import { useEffect, useRef, useState } from "react";
import { useBeforeUnload } from "react-router-dom";
import {
  api,
  ApiError,
  definitiveMutationFailure,
  encode,
  errorMessage,
} from "./api";
import type { Mutation } from "./api";
import {
  identifier,
  object,
  ownedStorage,
  sameOwner,
  textValue,
  timestamp,
  validOperator,
  validOwner,
  validReveal,
  validRole,
} from "./operator";
const pendingKey = "operator-change:v1";
export interface OperatorChange {
  operation: Mutation;
  started_at: number;
  kind: "create" | "update" | "rotate" | "revoke";
  target: string | null;
  revision: number | null;
  session_id: string | null;
}
export function validOperatorChange(v: unknown): v is OperatorChange {
  if (
    !object(v) ||
    !object(v.operation) ||
    !validOwner(v.operation.owner) ||
    !sameOwner(v.operation.owner, api.owner()) ||
    !identifier(v.operation.key) ||
    !timestamp(v.started_at) ||
    v.started_at > Date.now() ||
    !object(v.operation.body)
  )
    return false;
  const b = v.operation.body;
  if (!textValue(b.reason, 512)) return false;
  if (v.kind === "create")
    return (
      v.target === null &&
      v.revision === null &&
      v.session_id === null &&
      v.operation.path === "/operators" &&
      v.operation.method === "POST" &&
      textValue(b.name, 128) &&
      typeof b.sign_in_name === "string" &&
      /^[A-Za-z0-9_.-]{1,64}$/.test(b.sign_in_name) &&
      validRole(b.role)
    );
  if (
    !identifier(v.target) ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1 ||
    b.revision !== v.revision
  )
    return false;
  const path = `/operators/${encode(v.target)}`;
  if (v.kind === "update")
    return (
      v.operation.path === path &&
      v.operation.method === "PUT" &&
      v.session_id === null &&
      textValue(b.name, 128) &&
      validRole(b.role) &&
      (b.state === "active" || b.state === "disabled")
    );
  if (v.kind === "rotate")
    return (
      v.operation.path === `${path}/credential-rotations` &&
      v.operation.method === "POST" &&
      v.session_id === null
    );
  return (
    v.kind === "revoke" &&
    v.operation.method === "POST" &&
    (v.session_id === null || identifier(v.session_id)) &&
    v.operation.path ===
      `${path}${v.session_id ? `/sessions/${encode(v.session_id)}/revocations` : "/session-revocations"}`
  );
}
function validResult(v: unknown, change: OperatorChange): boolean {
  const body = change.operation.body as Record<string, unknown>;
  if (change.kind === "create" || change.kind === "rotate")
    return (
      validReveal(v) &&
      (change.target === null
        ? v.operator.sign_in_name === body.sign_in_name
        : v.operator.id === change.target) &&
      (v.secret_status === "unrecoverable" ||
        (change.kind === "create"
          ? v.operator.role === body.role &&
            v.operator.name === body.name &&
            v.operator.revision === 1
          : v.operator.revision === change.revision! + 1))
    );
  if (change.kind === "update")
    return (
      validOperator(v) &&
      v.id === change.target &&
      v.revision === change.revision! + 1 &&
      v.name === body.name &&
      v.role === body.role &&
      v.state === body.state
    );
  return (
    object(v) &&
    v.operator_id === change.target &&
    v.session_id === change.session_id &&
    Number.isSafeInteger(v.revoked) &&
    Number(v.revoked) >= 0 &&
    (change.session_id === null || v.revoked === 1)
  );
}
export function useOperatorChange(
  onResult: (change: OperatorChange, result: unknown) => void,
) {
  const [storage] = useState(() => {
    try {
      return ownedStorage(sessionStorage, api.requireOwner());
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<OperatorChange | null>(() => {
    try {
      const raw = storage?.getItem(pendingKey);
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      if (!validOperatorChange(v)) throw Error();
      return v;
    } catch {
      return null;
    }
  });
  const [persisted, setPersisted] = useState(pending !== null);
  const [invalidRecovery] = useState(() => {
    try {
      const raw = storage?.getItem(pendingKey);
      return Boolean(raw && !validOperatorChange(JSON.parse(raw)));
    } catch {
      return true;
    }
  });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const running = useRef(false);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useBeforeUnload((e) => {
    if (pending || busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  const expired =
    pending !== null && Date.now() - pending.started_at >= 23 * 3600_000;
  async function send(change: OperatorChange) {
    if (
      running.current ||
      invalidRecovery ||
      Date.now() - change.started_at >= 23 * 3600_000
    )
      return;
    running.current = true;
    setBusy(true);
    setError(null);
    setPending(change);
    let stored = false;
    try {
      if (storage) {
        storage.setItem(pendingKey, JSON.stringify(change));
        stored = true;
      }
    } catch {
      // The immutable request remains retryable in memory.
    }
    setPersisted(stored);
    try {
      const result = await api.run<unknown>(change.operation);
      if (!live.current) return;
      if (!validResult(result, change))
        throw new ApiError(
          200,
          "invalid_response",
          "The result could not be confirmed. Retry the same request; a credential reveal may already be lost.",
        );
      setPending(null);
      onResult(change, result);
      try {
        storage?.removeItem(pendingKey);
      } catch {
        setError(
          "The change is confirmed, but its browser recovery record could not be cleared. Inspect this result before retrying an older stored request.",
        );
      }
    } catch (cause) {
      if (!live.current) return;
      let removalFailed = false;
      if (definitiveMutationFailure(cause)) {
        setPending(null);
        try {
          storage?.removeItem(pendingKey);
        } catch {
          removalFailed = true;
        }
      }
      const message =
        cause instanceof ApiError && cause.code === "last_admin"
          ? "This is the last active Admin. Add or restore another Admin before removing this access."
          : cause instanceof ApiError && cause.code === "revision_conflict"
            ? "This operator changed. Refresh and review the new revision before making another change."
            : cause instanceof ApiError && cause.status === 403
              ? "Your current session cannot perform this action. An earlier unconfirmed effect may still exist; inspect the operator and audit before starting another request."
              : errorMessage(cause);
      setError(
        removalFailed
          ? `${message} Its browser recovery record could not be cleared and may reappear after a reload. Inspect the recorded outcome before retrying it.`
          : message,
      );
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  return {
    pending,
    busy,
    error:
      [
        error,
        pending && !persisted
          ? "Browser recovery is unavailable. Keep this page open; reloading may lose the exact retry request."
          : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    invalidRecovery,
    expired,
    send,
    acknowledgeExpired: () => {
      try {
        storage?.removeItem(pendingKey);
        setPending(null);
        setError(null);
      } catch {
        setError(
          "The browser recovery record could not be cleared. It remains stored. Keep this page open and try again when browser storage is available.",
        );
      }
    },
  };
}
