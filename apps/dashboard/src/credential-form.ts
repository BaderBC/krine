import {
  api,
  ApiError,
  definitiveMutationFailure,
  encode,
  mutation,
} from "./api";
import type { Mutation } from "./api";
import type { Credential, CredentialCreation } from "./types";

const recoveryKey = "krine:credential-mutation:v1";
const retryWindow = 23 * 60 * 60 * 1000;
export interface CredentialIntent {
  operation: Mutation;
  startedAt: number;
  kind: Credential["kind"];
  label: string;
  id: string | null;
}
interface State {
  pending: CredentialIntent | null;
  busy: boolean;
  result: CredentialCreation | null;
  error: string | null;
  storageUnavailable: boolean;
  expired: boolean;
}
export function validCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const item = value as Credential;
  return (
    typeof item.id === "string" &&
    /^cred_[A-Za-z0-9_-]+$/.test(item.id) &&
    ["browser", "server"].includes(item.kind) &&
    typeof item.label === "string" &&
    ["bootstrap", "administrator"].includes(item.source) &&
    (item.kind === "browser"
      ? typeof item.public_key === "string" && Boolean(item.public_key)
      : item.public_key === null) &&
    Number.isSafeInteger(item.created_at) &&
    item.created_at >= 0 &&
    ((item.revoked_at === null && item.revoked_by === null) ||
      (Number.isSafeInteger(item.revoked_at) &&
        item.revoked_at! >= 0 &&
        item.revoked_by === "administrator"))
  );
}
export function validLabel(label: string) {
  return (
    Boolean(label) &&
    label === label.trim() &&
    new TextEncoder().encode(label).length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(label)
  );
}
function readIntent(storage: Storage): CredentialIntent | null {
  const text = storage.getItem(recoveryKey);
  if (!text) return null;
  const value = JSON.parse(text) as CredentialIntent;
  const op = value?.operation;
  if (
    !value ||
    !op ||
    op.method !== "POST" ||
    !/^[\da-f-]{36}$/i.test(op.key) ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt > Date.now() ||
    !["browser", "server"].includes(value.kind) ||
    typeof value.label !== "string" ||
    !validLabel(value.label)
  )
    throw new Error("Invalid recovery");
  const expectedBody =
    value.id === null ? { kind: value.kind, label: value.label } : {};
  const path =
    value.id === null
      ? "/credentials"
      : typeof value.id === "string" && /^cred_[A-Za-z0-9_-]+$/.test(value.id)
        ? `/credentials/${encode(value.id)}/revocations`
        : null;
  if (
    op.path !== path ||
    JSON.stringify(op.body) !== JSON.stringify(expectedBody)
  )
    throw new Error("Invalid recovery");
  return {
    operation: {
      path: op.path,
      method: "POST",
      key: op.key,
      body: expectedBody,
    },
    startedAt: value.startedAt,
    kind: value.kind,
    label: value.label,
    id: value.id,
  };
}

/** Only a non-secret mutation intent is persisted. A returned secret lives in memory until dismissed. */
export class CredentialForm {
  private state: State = {
    pending: null,
    busy: false,
    result: null,
    error: null,
    storageUnavailable: false,
    expired: false,
  };
  private listeners = new Set<() => void>();
  private revocations = new Map<
    string,
    { revoked_at: number; revoked_by: "administrator" }
  >();
  private alive = true;
  private storage: Storage | null = null;
  constructor(
    private client: Pick<typeof api, "run"> = api,
    storage?: Storage,
  ) {
    try {
      this.storage = storage ?? sessionStorage;
      this.state.pending = readIntent(this.storage);
      this.state.expired = Boolean(
        this.state.pending &&
          Date.now() - this.state.pending.startedAt >= retryWindow,
      );
    } catch {
      this.state.storageUnavailable = true;
      this.state.error =
        "Request recovery could not be read. Inspect existing credentials before creating a replacement.";
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  private update(change: Partial<State>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private persist(intent: CredentialIntent | null) {
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      if (intent) this.storage.setItem(recoveryKey, JSON.stringify(intent));
      else this.storage.removeItem(recoveryKey);
    } catch {
      this.update({ storageUnavailable: true });
    }
  }
  async create(kind: Credential["kind"], label: string) {
    if (
      this.state.pending ||
      this.state.result ||
      this.state.busy ||
      !validLabel(label)
    )
      return;
    await this.submit({
      operation: mutation("/credentials", { kind, label }),
      kind,
      label,
      id: null,
      startedAt: Date.now(),
    });
  }
  async revoke(item: Credential) {
    if (this.state.pending || this.state.busy || item.revoked_at !== null)
      return;
    this.update({ result: null });
    await this.submit({
      operation: mutation(`/credentials/${encode(item.id)}/revocations`, {}),
      kind: item.kind,
      label: item.label,
      id: item.id,
      startedAt: Date.now(),
    });
  }
  async retry() {
    if (this.state.pending && !this.state.busy)
      await this.submit(this.state.pending);
  }
  private async submit(intent: CredentialIntent) {
    if (Date.now() - intent.startedAt >= retryWindow) {
      this.update({ pending: intent, expired: true, error: null });
      return;
    }
    this.persist(intent);
    this.update({ pending: intent, busy: true, result: null, error: null });
    try {
      const response = await this.client.run<unknown>(intent.operation);
      let result: CredentialCreation;
      if (intent.id !== null) {
        if (
          !validCredential(response) ||
          response.id !== intent.id ||
          response.kind !== intent.kind ||
          response.label !== intent.label ||
          response.revoked_at === null
        )
          throw new ApiError(
            200,
            "invalid_response",
            "Invalid revocation response",
          );
        result = {
          credential: response,
          secret: null,
          secret_status: "not_applicable",
        };
      } else {
        result = response as CredentialCreation;
        if (
          !result ||
          !validCredential(result.credential) ||
          result.credential.kind !== intent.kind ||
          result.credential.label !== intent.label ||
          result.credential.source !== "administrator" ||
          (intent.kind === "browser"
            ? result.secret !== null ||
              result.secret_status !== "not_applicable"
            : !(
                (result.secret_status === "unrecoverable" &&
                  result.secret === null) ||
                (result.secret_status === "revealed" &&
                  result.credential.revoked_at === null &&
                  typeof result.secret === "string" &&
                  /^sk_[A-Za-z0-9_-]{43}$/.test(result.secret))
              ))
        )
          throw new ApiError(
            200,
            "invalid_response",
            "Invalid creation response",
          );
      }
      if (!this.alive) return;
      this.observe([result.credential]);
      this.persist(null);
      this.update({
        pending: null,
        busy: false,
        result: this.reconcile(result),
      });
    } catch (cause) {
      if (!this.alive) return;
      const certain = definitiveMutationFailure(cause);
      if (certain) this.persist(null);
      this.update({
        busy: false,
        ...(certain ? { pending: null } : {}),
        error:
          cause instanceof ApiError && [401, 403].includes(cause.status)
            ? "Sign in again, then retry this same request."
            : certain
              ? "Krine rejected this request. Refresh the credentials and check the label before trying again."
              : "The result is unconfirmed. Retry this same request before making another change.",
      });
    }
  }
  // Revocation is irreversible. Keep only its metadata, independent of list pages.
  currentCredential(item: Credential): Credential {
    const revoked = this.revocations.get(item.id);
    return revoked && item.revoked_at !== revoked.revoked_at
      ? { ...item, ...revoked }
      : item;
  }
  private reconcile(result: CredentialCreation): CredentialCreation {
    const credential = this.currentCredential(result.credential);
    return credential === result.credential
      ? result
      : { credential, secret: null, secret_status: "not_applicable" };
  }
  observe(items: Credential[]) {
    if (!this.alive) return;
    for (const item of items) {
      if (item.revoked_at !== null && !this.revocations.has(item.id))
        this.revocations.set(item.id, {
          revoked_at: item.revoked_at,
          revoked_by: "administrator",
        });
    }
    if (this.state.result) {
      const result = this.reconcile(this.state.result);
      if (result !== this.state.result) this.update({ result });
    }
  }
  dismiss() {
    if (!this.state.pending && !this.state.busy)
      this.update({ result: null, error: null });
  }
  acknowledgeExpired() {
    if (!this.state.expired) return;
    this.persist(null);
    this.update({ pending: null, expired: false, error: null });
  }
  activate() {
    this.alive = true;
  }
  dispose() {
    this.alive = false;
    this.listeners.clear();
  }
}
