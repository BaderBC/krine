import { ApiError, definitiveMutationFailure, errorMessage } from "./api";
import type { Api, Mutation } from "./api";
import type { Check, Policy, Version } from "./types";
import { policyError, sameJson } from "./policy";

type Document = { policy: Policy; description: string };
type Intent =
  | { kind: "save"; key: string; revision: number; document: Document }
  | {
      kind: "publish";
      key: string;
      revision: number;
      expected_active_version: number | null;
    }
  | {
      kind: "restore";
      key: string;
      revision: number;
      version: number;
      before: Document;
    };
export type DraftStatus =
  "saved" | "changed" | "saving" | "failed" | "conflict";
export interface DraftState extends Document {
  server: Check;
  status: DraftStatus;
  error: string | null;
  recoveryAvailable: boolean;
  action: {
    kind: "publish" | "restore";
    status: "running" | "recovering" | "failed";
    error: string | null;
    revision: number;
  } | null;
  notice: string | null;
}
interface Recovery extends Document {
  check?: string;
  revision: number;
  intent: Intent | null;
}

// A reopened editor owns this tab's recovery record. Detached requests may finish,
// but can never replace or remove a newer editor's work.
const recoveryOwners = new WeakMap<Storage, Map<string, symbol>>();
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function document(value: unknown): value is Document {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Document>;
  return (
    typeof candidate.description === "string" &&
    validRecoveryPolicy(candidate.policy)
  );
}
function validRecoveryPolicy(value: unknown): value is Policy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Policy;
  if (
    policy.schema_version !== 1 ||
    !policy.inputs ||
    typeof policy.inputs !== "object" ||
    Array.isArray(policy.inputs) ||
    !Object.values(policy.inputs).every((type) =>
      ["number", "string", "boolean"].includes(type),
    ) ||
    !Array.isArray(policy.rules) ||
    policy.rules.length > 32 ||
    !["ALLOW", "DENY"].includes(policy.otherwise)
  )
    return false;
  let nodes = 0;
  const reference = (ref: unknown): boolean => {
    if (!ref || typeof ref !== "object") return false;
    const r = ref as Record<string, unknown>;
    return (
      typeof r.name === "string" &&
      (r.source === "input" || (r.source === "metric" && integer(r.version)))
    );
  };
  const scalar = (v: unknown) =>
    v === null || ["string", "number", "boolean"].includes(typeof v);
  const condition = (v: unknown, depth: number): boolean => {
    if (!v || typeof v !== "object" || ++nodes > 256 || depth > 8) return false;
    const c = v as Record<string, unknown>;
    switch (c.op) {
      case "compare":
        return (
          reference(c.left) &&
          ["eq", "ne", "gt", "gte", "lt", "lte"].includes(
            String(c.comparison),
          ) &&
          scalar(c.value)
        );
      case "known":
        return reference(c.value);
      case "between":
        return (
          reference(c.left) &&
          (typeof c.min === "number" || c.min === null) &&
          (typeof c.max === "number" || c.max === null)
        );
      case "in":
        return (
          reference(c.left) &&
          Array.isArray(c.values) &&
          c.values.length <= 32 &&
          c.values.every(scalar)
        );
      case "not":
        return condition(c.condition, depth + 1);
      case "all":
      case "any":
        return (
          Array.isArray(c.conditions) &&
          c.conditions.length > 0 &&
          c.conditions.every((child) => condition(child, depth + 1))
        );
      default:
        return false;
    }
  };
  return policy.rules.every(
    (rule) =>
      rule &&
      typeof rule.id === "string" &&
      ["ALLOW", "DENY", "CHALLENGE"].includes(rule.then) &&
      ["DENY", "NEXT", "CHALLENGE"].includes(rule.on_unknown) &&
      condition(rule.condition, 1),
  );
}
function validIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Intent;
  if (
    typeof intent.key !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(intent.key) ||
    !integer(intent.revision)
  )
    return false;
  if (intent.kind === "save")
    return document(intent.document) && !policyError(intent.document.policy);
  if (intent.kind === "publish")
    return (
      intent.expected_active_version === null ||
      integer(intent.expected_active_version)
    );
  return (
    intent.kind === "restore" &&
    integer(intent.version) &&
    document(intent.before)
  );
}

function validAcknowledgement(
  value: unknown,
  intent: Intent,
  name: string,
): value is Check | Version {
  if (!value || typeof value !== "object") return false;
  if (intent.kind === "publish") {
    const version = value as Version;
    return (
      integer(version.version) &&
      version.version > (intent.expected_active_version ?? 0) &&
      integer(version.published_at) &&
      validRecoveryPolicy(version.policy) &&
      !policyError(version.policy)
    );
  }
  const check = value as Check;
  return (
    check.name === name &&
    typeof check.description === "string" &&
    integer(check.draft_revision) &&
    check.draft_revision > intent.revision &&
    (check.active_version === null ||
      (integer(check.active_version) && check.active_version > 0)) &&
    typeof check.has_draft_changes === "boolean" &&
    integer(check.updated_at) &&
    validRecoveryPolicy(check.draft) &&
    !policyError(check.draft) &&
    (intent.kind !== "save" ||
      (sameJson(check.draft, intent.document.policy) &&
        check.description === intent.document.description))
  );
}

/** Serializes check mutations and reconciles results with the current local document. */
export class DraftController {
  state: DraftState;
  private listeners = new Set<() => void>();
  private intent: Intent | null = null;
  private running: Promise<Check | Version | undefined> | null = null;
  private storageKey: string;
  private owner = Symbol();
  private disposed = false;
  constructor(
    private api: Pick<Api, "run">,
    check: Check,
    private storage?: Storage,
  ) {
    this.storageKey = `krine:draft:${check.name}`;
    if (storage) {
      if (!recoveryOwners.has(storage)) recoveryOwners.set(storage, new Map());
      recoveryOwners.get(storage)!.set(this.storageKey, this.owner);
    }
    this.state = {
      server: check,
      policy: check.draft,
      description: check.description,
      status: "saved",
      error: null,
      recoveryAvailable: Boolean(storage),
      action: null,
      notice: null,
    };
    try {
      const raw = storage?.getItem(this.storageKey);
      if (raw) {
        const recovery = JSON.parse(raw) as Recovery;
        if (
          !document(recovery) ||
          !integer(recovery.revision) ||
          (recovery.intent != null &&
            (recovery.check !== check.name || !validIntent(recovery.intent)))
        ) {
          this.state = {
            ...this.state,
            error:
              "The browser recovery copy could not be read. The saved shared draft is shown; the recovery copy has been retained.",
            recoveryAvailable: false,
          };
        } else {
          this.intent = recovery.intent ?? null;
          const alreadySaved =
            !this.intent &&
            sameJson(recovery.policy, check.draft) &&
            recovery.description === check.description;
          const conflict =
            !alreadySaved &&
            recovery.revision !== check.draft_revision &&
            !this.intent;
          this.state = {
            ...this.state,
            policy: recovery.policy,
            description: recovery.description,
            status: alreadySaved ? "saved" : conflict ? "conflict" : "changed",
            error: conflict
              ? "The shared draft changed while you were away. Your local work is preserved. Compare drafts before saving."
              : null,
            action:
              this.intent && this.intent.kind !== "save"
                ? {
                    kind: this.intent.kind,
                    status: "recovering",
                    error: null,
                    revision: this.intent.revision,
                  }
                : null,
          };
          if (alreadySaved) storage?.removeItem(this.storageKey);
        }
      }
    } catch {
      this.state.recoveryAvailable = false;
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private ownsRecovery() {
    return (
      !this.disposed &&
      (!this.storage ||
        recoveryOwners.get(this.storage)?.get(this.storageKey) === this.owner)
    );
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  get dirty(): boolean {
    return (
      this.intent?.kind === "save" ||
      !sameJson(this.state.policy, this.state.server.draft) ||
      this.state.description !== this.state.server.description
    );
  }
  get pendingAction(): boolean {
    return this.intent !== null && this.intent.kind !== "save";
  }
  get pending(): boolean {
    return this.intent !== null;
  }
  private emit() {
    if (!this.ownsRecovery()) return;
    try {
      if (this.dirty || this.intent)
        this.storage?.setItem(
          this.storageKey,
          JSON.stringify({
            check: this.state.server.name,
            revision: this.state.server.draft_revision,
            policy: this.state.policy,
            description: this.state.description,
            intent: this.intent,
          } satisfies Recovery),
        );
      else this.storage?.removeItem(this.storageKey);
    } catch {
      this.state = { ...this.state, recoveryAvailable: false };
    }
    this.listeners.forEach((listener) => listener());
  }
  edit(policy: Policy, description = this.state.description) {
    const blocked =
      this.state.status === "conflict" || this.state.status === "failed";
    this.state = {
      ...this.state,
      policy,
      description,
      notice: null,
      status: blocked ? this.state.status : "changed",
    };
    if (this.state.status !== "conflict" && !this.dirty)
      this.state = { ...this.state, status: "saved", error: null };
    this.emit();
  }
  async save(): Promise<void> {
    if (
      this.pendingAction ||
      this.state.status === "conflict" ||
      !this.dirty ||
      (!this.intent && policyError(this.state.policy))
    )
      return;
    const intent = this.intent ?? {
      kind: "save",
      key: crypto.randomUUID(),
      revision: this.state.server.draft_revision,
      document: {
        policy: this.state.policy,
        description: this.state.description,
      },
    };
    await this.execute(intent);
  }
  publish(): Promise<Check | Version | undefined> {
    if (this.intent || this.dirty || this.state.status !== "saved")
      return Promise.resolve(undefined);
    return this.execute({
      kind: "publish",
      key: crypto.randomUUID(),
      revision: this.state.server.draft_revision,
      expected_active_version: this.state.server.active_version,
    });
  }
  restore(version: number): Promise<Check | Version | undefined> {
    if (this.intent || this.running) return Promise.resolve(undefined);
    return this.execute({
      kind: "restore",
      key: crypto.randomUUID(),
      revision: this.state.server.draft_revision,
      version,
      before: {
        policy: this.state.policy,
        description: this.state.description,
      },
    });
  }
  retryAction() {
    return this.intent ? this.execute(this.intent) : Promise.resolve(undefined);
  }
  private request(intent: Intent): Mutation {
    const base = `/checks/${encodeURIComponent(this.state.server.name)}`;
    return intent.kind === "save"
      ? {
          path: `${base}/draft`,
          body: { revision: intent.revision, ...intent.document },
          method: "PUT",
          key: intent.key,
        }
      : intent.kind === "publish"
        ? {
            path: `${base}/publications`,
            body: {
              revision: intent.revision,
              expected_active_version: intent.expected_active_version,
            },
            method: "POST",
            key: intent.key,
          }
        : {
            path: `${base}/restorations`,
            body: {
              revision: intent.revision,
              version: intent.version,
              replace_draft: true,
            },
            method: "POST",
            key: intent.key,
          };
  }
  private execute(intent: Intent): Promise<Check | Version | undefined> {
    if (!this.ownsRecovery()) return Promise.resolve(undefined);
    if (this.running) return this.running;
    this.intent = intent;
    this.state =
      intent.kind === "save"
        ? { ...this.state, status: "saving", error: null }
        : {
            ...this.state,
            action: {
              kind: intent.kind,
              status: "running",
              error: null,
              revision: intent.revision,
            },
          };
    this.emit();
    this.running = this.perform(intent).finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async perform(intent: Intent): Promise<Check | Version | undefined> {
    try {
      const result = await this.api.run<unknown>(this.request(intent));
      if (!this.ownsRecovery()) return undefined;
      if (!validAcknowledgement(result, intent, this.state.server.name))
        throw new ApiError(
          200,
          "invalid_response",
          "Krine returned an unreadable acknowledgement. Retry the original request to recover its result.",
        );
      const prior = this.state.server;
      let server = prior;
      let policy = this.state.policy;
      let description = this.state.description;
      let stale = false;
      if (intent.kind === "publish") {
        const version = result as Version;
        if (
          prior.active_version === null ||
          prior.active_version <= version.version
        )
          server = {
            ...prior,
            active_version: version.version,
            has_draft_changes: !sameJson(prior.draft, version.policy),
            updated_at: Math.max(prior.updated_at, version.published_at),
          };
        stale = prior.draft_revision > intent.revision;
      } else {
        const check = result as Check;
        stale = prior.draft_revision > check.draft_revision;
        // Publication advances independently of the draft revision. Keep a
        // complete snapshot so its draft-change flag describes the same pair.
        const olderPublication =
          (check.active_version ?? 0) < (prior.active_version ?? 0);
        server = stale || olderPublication ? prior : check;
        if (intent.kind === "restore") {
          if (sameJson(policy, intent.before.policy)) policy = server.draft;
          if (description === intent.before.description)
            description = server.description;
        }
      }
      const changed =
        !sameJson(policy, server.draft) || description !== server.description;
      let notice = this.state.notice;
      if (intent.kind === "publish") {
        const published = (result as Version).version;
        notice = `Version ${published} published.`;
        if (server.active_version !== null && server.active_version > published)
          notice += ` Version ${server.active_version} supersedes it.`;
      } else if (intent.kind === "restore") {
        const restoredRevision = (result as Check).draft_revision;
        notice = `Version ${intent.version} copied to draft revision ${restoredRevision}.`;
        if (server.draft_revision > restoredRevision)
          notice += ` Draft revision ${server.draft_revision} supersedes that restoration.`;
      }
      if (intent.kind !== "save" && changed)
        notice += " Your local edits are preserved.";
      this.state = {
        ...this.state,
        server,
        policy,
        description,
        status: stale && changed ? "conflict" : changed ? "changed" : "saved",
        error:
          stale && changed
            ? "The earlier request completed, but the shared draft has since changed. Your newer local work is preserved. Compare drafts before saving."
            : null,
        action: null,
        notice,
      };
      this.intent = null;
      this.emit();
      return result;
    } catch (error) {
      if (!this.ownsRecovery()) return undefined;
      const conflict =
        error instanceof ApiError && error.code === "revision_conflict";
      if (definitiveMutationFailure(error)) this.intent = null;
      const details =
        error instanceof ApiError
          ? error.details
              .map((detail) => `${detail.path}: ${detail.message}`)
              .join(" ")
          : "";
      const message = conflict
        ? "The shared draft or active version changed. Your local work is preserved. Compare the current draft before continuing."
        : [errorMessage(error), details].filter(Boolean).join(" ");
      this.state =
        intent.kind === "save"
          ? {
              ...this.state,
              status: conflict ? "conflict" : "failed",
              error: message,
            }
          : {
              ...this.state,
              status: conflict ? "conflict" : this.state.status,
              action: {
                kind: intent.kind,
                status: "failed",
                error: message,
                revision: intent.revision,
              },
            };
      this.emit();
      return undefined;
    }
  }
  reconcile(latest: Check, keepLocal: boolean) {
    if (this.running || this.intent) return;
    this.state = {
      ...this.state,
      server: latest,
      policy: keepLocal ? this.state.policy : latest.draft,
      description: keepLocal ? this.state.description : latest.description,
      status: keepLocal ? "changed" : "saved",
      error: null,
      action: null,
    };
    if (!this.dirty) this.state = { ...this.state, status: "saved" };
    this.emit();
  }
}
