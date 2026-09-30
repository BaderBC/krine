export const capabilities = [
  "session",
  "investigate",
  "edit",
  "administer",
  "manage_operators",
  "audit",
] as const;
export type Capability = (typeof capabilities)[number];
export type Role = "viewer" | "editor" | "admin";
export interface Operator {
  id: string;
  name: string;
  sign_in_name: string;
  role: Role;
  state: "active" | "disabled";
  revision: number;
  authentication_method: "local";
  created_at: number;
  last_sign_in_at: number | null;
}
export interface OperatorSession {
  operator: Operator | null;
  actor_id: string;
  session_id: string;
  authentication_method: "local" | "installation_recovery";
  capabilities: Capability[];
  csrf_token: string;
  expires_at: number;
  recovery_reason: string | null;
}
export interface AuthMethods {
  installation_id: string;
  local: boolean;
  bootstrap: boolean;
  recovery: true;
  oidc: false;
}
export interface IntentOwner {
  installation_id: string;
  actor_id: string;
}
export interface OperatorReveal {
  operator: Operator;
  credential: string | null;
  secret_status: "revealed" | "unrecoverable";
}
export interface OperatorSessionRecord {
  id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  current: boolean;
}
export const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
export const timestamp = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 8.64e15;
export const identifier = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 256 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export const textValue = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  Boolean(v) &&
  v.trim() === v &&
  new TextEncoder().encode(v).length <= max &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export const validRole = (v: unknown): v is Role =>
  v === "viewer" || v === "editor" || v === "admin";
export function validOperator(v: unknown): v is Operator {
  return (
    object(v) &&
    typeof v.id === "string" &&
    /^op_[A-Za-z0-9_-]+$/.test(v.id) &&
    textValue(v.name, 128) &&
    typeof v.sign_in_name === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(v.sign_in_name) &&
    validRole(v.role) &&
    (v.state === "active" || v.state === "disabled") &&
    Number.isSafeInteger(v.revision) &&
    Number(v.revision) > 0 &&
    v.authentication_method === "local" &&
    timestamp(v.created_at) &&
    (v.last_sign_in_at === null || timestamp(v.last_sign_in_at))
  );
}
export const roleCapabilities: Record<Role, readonly Capability[]> = {
  viewer: ["session", "investigate"],
  editor: ["session", "investigate", "edit"],
  admin: capabilities,
};
export function validSession(v: unknown): v is OperatorSession {
  if (
    !object(v) ||
    !identifier(v.actor_id) ||
    !identifier(v.session_id) ||
    !identifier(v.csrf_token) ||
    !timestamp(v.expires_at) ||
    !Array.isArray(v.capabilities) ||
    new Set(v.capabilities).size !== v.capabilities.length
  )
    return false;
  const expected =
    v.authentication_method === "local" &&
    validOperator(v.operator) &&
    v.operator.state === "active" &&
    v.actor_id === v.operator.id &&
    v.recovery_reason === null
      ? roleCapabilities[v.operator.role]
      : v.authentication_method === "installation_recovery" &&
          v.operator === null &&
          /^recovery:[A-Za-z0-9_-]+$/.test(v.actor_id) &&
          textValue(v.recovery_reason, 512)
        ? ["session", "manage_operators"]
        : null;
  return (
    expected !== null &&
    expected.length === v.capabilities.length &&
    expected.every((c) => (v.capabilities as unknown[]).includes(c))
  );
}
export function validMethods(v: unknown): v is AuthMethods {
  return (
    object(v) &&
    identifier(v.installation_id) &&
    typeof v.local === "boolean" &&
    typeof v.bootstrap === "boolean" &&
    v.recovery === true &&
    v.oidc === false
  );
}
export function validOwner(v: unknown): v is IntentOwner {
  return object(v) && identifier(v.installation_id) && identifier(v.actor_id);
}
export function sameOwner(
  a: IntentOwner | null | undefined,
  b: IntentOwner | null | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.installation_id === b.installation_id &&
    a.actor_id === b.actor_id
  );
}
export function validReveal(v: unknown): v is OperatorReveal {
  return (
    object(v) &&
    validOperator(v.operator) &&
    (v.secret_status === "revealed"
      ? typeof v.credential === "string" &&
        /^ok_[A-Za-z0-9_-]{43}$/.test(v.credential)
      : v.secret_status === "unrecoverable" && v.credential === null)
  );
}
export function validSessionRecord(v: unknown): v is OperatorSessionRecord {
  return (
    object(v) &&
    identifier(v.id) &&
    timestamp(v.created_at) &&
    timestamp(v.expires_at) &&
    v.expires_at > v.created_at &&
    (v.revoked_at === null || timestamp(v.revoked_at)) &&
    typeof v.current === "boolean"
  );
}
export function validPage<T>(
  v: unknown,
  item: (v: unknown) => v is T,
): v is { items: T[]; next_cursor: string | null } {
  return (
    object(v) &&
    Array.isArray(v.items) &&
    v.items.length <= 100 &&
    v.items.every(item) &&
    (v.next_cursor === null || identifier(v.next_cursor))
  );
}

export function ownedStorageKey(key: string, owner: IntentOwner): string {
  return `krine:operator:${encodeURIComponent(owner.installation_id)}:${encodeURIComponent(owner.actor_id)}:${key}`;
}
/** This wrapper captures the original owner; changing the signed-in actor never rebinds it. */
const storageViews = new WeakMap<Storage, Map<string, Storage>>();
export function ownedStorage(storage: Storage, owner: IntentOwner): Storage {
  const prefix = ownedStorageKey("", owner);
  const existing = storageViews.get(storage)?.get(prefix);
  if (existing) return existing;
  const keys = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (k): k is string => k !== null && k.startsWith(prefix),
    );
  const view: Storage = {
    get length() {
      return keys().length;
    },
    key: (i) => keys()[i]?.slice(prefix.length) ?? null,
    getItem: (k) => storage.getItem(prefix + k),
    setItem: (k, v) => storage.setItem(prefix + k, v),
    removeItem: (k) => storage.removeItem(prefix + k),
    clear: () => keys().forEach((k) => storage.removeItem(k)),
  };
  if (!storageViews.has(storage)) storageViews.set(storage, new Map());
  storageViews.get(storage)!.set(prefix, view);
  return view;
}
export function hasLegacyRecovery(storage: Storage): boolean {
  return Array.from({ length: storage.length }, (_, i) => storage.key(i)).some(
    (key) =>
      key?.startsWith("krine:draft:") ||
      key === "krine:credential-mutation:v1" ||
      key === "krine:relationship-mutation:v1",
  );
}
