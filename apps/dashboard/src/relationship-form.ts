import { relationshipPath } from "./addresses";
import {
  api,
  ApiError,
  definitiveMutationFailure,
  encode,
  mutation,
} from "./api";
import type { Mutation } from "./api";
import type {
  Page,
  Relationship,
  RelationshipDetail,
  RelationshipSummary,
} from "./types";

const recoveryKey = "krine:relationship-mutation:v1";
const retryWindow = 23 * 60 * 60 * 1000;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  Boolean(value) &&
  new TextEncoder().encode(value).length <= 256 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const nullableId = (value: unknown) => value === null || identifier(value);
const timestamp = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export function validRelationshipSummary(
  value: unknown,
): value is RelationshipSummary {
  if (!object(value)) return false;
  return (
    identifier(value.id) &&
    (value.kind === "backend" || value.kind === "observed_ip") &&
    identifier(value.client_id) &&
    nullableId(value.session_id) &&
    nullableId(value.user_id) &&
    nullableId(value.ip) &&
    (value.kind === "backend"
      ? identifier(value.user_id) &&
        value.ip === null &&
        value.source === "backend"
      : identifier(value.session_id) &&
        identifier(value.ip) &&
        value.user_id === null &&
        value.source === "browser_observation") &&
    timestamp(value.first_seen) &&
    timestamp(value.last_seen) &&
    Number(value.last_seen) >= Number(value.first_seen) &&
    nullableId(value.credential_id) &&
    nullableId(value.last_credential_id) &&
    typeof value.first_source === "string" &&
    ["backend", "browser.context", "browser.proof", "legacy"].includes(
      value.first_source,
    ) &&
    typeof value.last_source === "string" &&
    ["backend", "browser.context", "browser.proof", "legacy"].includes(
      value.last_source,
    ) &&
    nullableId(value.first_event_id) &&
    nullableId(value.last_event_id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    (value.revoked_at === null || timestamp(value.revoked_at)) &&
    (value.revocation_reason === null ||
      typeof value.revocation_reason === "string") &&
    nullableId(value.revoked_by)
  );
}
export function validRelationship(value: unknown): value is Relationship {
  return (
    validRelationshipSummary(value) && object((value as Relationship).metadata)
  );
}
export function validRelationships(
  value: unknown,
): value is Page<Relationship> {
  return (
    object(value) &&
    Array.isArray(value.items) &&
    value.items.length <= 100 &&
    value.items.every(validRelationship) &&
    (value.next_cursor === null || typeof value.next_cursor === "string")
  );
}
export function validRelationshipDetail(
  value: unknown,
): value is RelationshipDetail {
  if (
    !object(value) ||
    !validRelationship(value.relationship) ||
    value.recalculation !== "complete" ||
    !object(value.audit)
  )
    return false;
  return (
    Array.isArray(value.audit.items) &&
    value.audit.items.length <= 100 &&
    value.audit.items.every((item: unknown) => {
      if (!object(item)) return false;
      return (
        identifier(item.id) &&
        timestamp(item.at) &&
        typeof item.action === "string" &&
        typeof item.reason === "string" &&
        nullableId(item.actor) &&
        (item.revision === null ||
          (Number.isSafeInteger(item.revision) &&
            Number(item.revision) >= 1)) &&
        (item.relationship === null || validRelationship(item.relationship))
      );
    }) &&
    (value.audit.next_cursor === null ||
      typeof value.audit.next_cursor === "string")
  );
}
export function validReason(value: string): boolean {
  return (
    Boolean(value) &&
    value === value.trim() &&
    new TextEncoder().encode(value).length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}
export type RelationshipAction = "correct" | "restore";
export interface RelationshipIntent {
  relationship: RelationshipSummary;
  action: RelationshipAction;
  reason: string;
  startedAt: number;
  operation: Mutation;
}
export interface RelationshipReceipt {
  relationship: Relationship;
  audit_id: string;
  recalculation: "complete";
}
interface State {
  pending: RelationshipIntent | null;
  receipt: RelationshipReceipt | null;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  expired: boolean;
  storageUnavailable: boolean;
}
export { relationshipPath } from "./addresses";
export function relationshipSummary(item: Relationship): RelationshipSummary {
  const { metadata: _metadata, ...summary } = item;
  return summary;
}
function operationBody(
  intent: Pick<RelationshipIntent, "relationship" | "reason">,
) {
  return { revision: intent.relationship.revision, reason: intent.reason };
}
function operationPath(
  intent: Pick<RelationshipIntent, "relationship" | "action">,
) {
  return relationshipPath(
    intent.relationship,
    intent.action === "correct" ? "/corrections" : "/restorations",
  );
}
function validIntent(value: unknown): value is RelationshipIntent {
  if (!object(value)) return false;
  const intent = value as unknown as RelationshipIntent;
  return (
    validRelationshipSummary(intent.relationship) &&
    ["correct", "restore"].includes(intent.action) &&
    (intent.action === "correct"
      ? intent.relationship.revoked_at === null
      : intent.relationship.revoked_at !== null) &&
    typeof intent.reason === "string" &&
    validReason(intent.reason) &&
    timestamp(intent.startedAt) &&
    intent.startedAt <= Date.now() &&
    object(intent.operation) &&
    intent.operation.method === "POST" &&
    typeof intent.operation.key === "string" &&
    /^[\da-f-]{36}$/i.test(intent.operation.key) &&
    (intent.operation.path === operationPath(intent) ||
      intent.operation.path ===
        `/relationships/${intent.relationship.kind}/${encode(intent.relationship.id)}/${intent.action === "correct" ? "corrections" : "restorations"}`) &&
    JSON.stringify(intent.operation.body) ===
      JSON.stringify(operationBody(intent))
  );
}

/** Persist the reviewed non-secret request before submission, never a replacement revision. */
export class RelationshipForm {
  private state: State = {
    pending: null,
    receipt: null,
    busy: false,
    error: null,
    conflict: false,
    expired: false,
    storageUnavailable: false,
  };
  private storage: Storage | null = null;
  private listeners = new Set<() => void>();
  private alive = true;
  constructor(
    private client: Pick<typeof api, "run"> = api,
    storage?: Storage,
  ) {
    try {
      this.storage = storage ?? sessionStorage;
      const saved = this.storage.getItem(recoveryKey);
      if (saved) {
        const intent: unknown = JSON.parse(saved);
        if (!validIntent(intent)) throw new Error("Invalid recovery");
        this.state.pending = intent;
        this.state.expired = Date.now() - intent.startedAt >= retryWindow;
      }
    } catch {
      this.state.storageUnavailable = true;
      this.state.error =
        "Request recovery could not be read. Keep this page open; do not repeat an earlier change without checking its audit history.";
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private update(change: Partial<State>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private persist(intent: RelationshipIntent | null) {
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      if (intent) this.storage.setItem(recoveryKey, JSON.stringify(intent));
      else this.storage.removeItem(recoveryKey);
    } catch {
      this.update({ storageUnavailable: true });
    }
  }
  async submit(
    relationship: Relationship,
    action: RelationshipAction,
    reason: string,
  ) {
    if (
      this.state.pending ||
      this.state.busy ||
      this.state.receipt ||
      !validRelationship(relationship) ||
      !validReason(reason)
    )
      return;
    if ((action === "correct") !== (relationship.revoked_at === null)) return;
    const intent = {
      relationship: relationshipSummary(relationship),
      action,
      reason,
      startedAt: Date.now(),
      operation: null as unknown as Mutation,
    };
    intent.operation = mutation(operationPath(intent), operationBody(intent));
    await this.send(intent);
  }
  async retry() {
    if (this.state.pending && !this.state.busy)
      await this.send(this.state.pending);
  }
  private async send(intent: RelationshipIntent) {
    if (Date.now() - intent.startedAt >= retryWindow) {
      this.update({ pending: intent, expired: true });
      return;
    }
    this.persist(intent);
    this.update({
      pending: intent,
      busy: true,
      error: null,
      receipt: null,
      conflict: false,
    });
    try {
      const value = await this.client.run<unknown>(intent.operation);
      const receipt = value as RelationshipReceipt;
      const item = receipt?.relationship;
      const reviewed = intent.relationship;
      if (
        !validRelationship(item) ||
        !identifier(receipt.audit_id) ||
        receipt.recalculation !== "complete" ||
        item.kind !== reviewed.kind ||
        item.id !== reviewed.id ||
        item.client_id !== reviewed.client_id ||
        item.session_id !== reviewed.session_id ||
        item.user_id !== reviewed.user_id ||
        item.ip !== reviewed.ip ||
        item.revision !== reviewed.revision + 1 ||
        (intent.action === "correct"
          ? item.revoked_at === null || item.revocation_reason !== intent.reason
          : item.revoked_at !== null)
      ) {
        throw new ApiError(
          200,
          "invalid_response",
          "Invalid correction acknowledgement",
        );
      }
      if (!this.alive) return;
      this.persist(null);
      this.update({ pending: null, busy: false, receipt });
    } catch (error) {
      if (!this.alive) return;
      const certain = definitiveMutationFailure(error);
      const conflict = error instanceof ApiError && error.status === 409;
      if (certain) this.persist(null);
      this.update({
        busy: false,
        conflict,
        ...(certain ? { pending: null } : {}),
        error: conflict
          ? error instanceof ApiError && error.code === "relationship_active"
            ? "A newer active IP segment exists. This segment was not restored. Inspect current evidence before reviewing another change."
            : "This relationship changed or the request conflicts with an earlier change. Inspect current evidence and explicitly review a new change."
          : certain
            ? "Krine rejected this change. Inspect current evidence before reviewing another change."
            : error instanceof ApiError && [401, 403].includes(error.status)
              ? "Sign in again, then retry this same reviewed request."
              : "The result is unconfirmed. Retry this same reviewed request before making another change.",
      });
    }
  }
  dismiss() {
    if (!this.state.pending && !this.state.busy)
      this.update({ receipt: null, error: null, conflict: false });
  }
  acknowledgeExpired() {
    if (this.state.expired) {
      this.persist(null);
      this.update({ pending: null, expired: false, error: null });
    }
  }
  activate() {
    this.alive = true;
  }
  dispose() {
    this.alive = false;
    this.listeners.clear();
  }
}
