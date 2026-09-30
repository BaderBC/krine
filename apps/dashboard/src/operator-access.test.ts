import { afterEach, expect, it, vi } from "vitest";
import { Api, api, ApiError, definitiveMutationFailure, mutation } from "./api";
import {
  authenticateFixture,
  methodsFixture,
  sessionFixture,
} from "./operator-test-fixtures";
import {
  hasLegacyRecovery,
  ownedStorage,
  validMethods,
  validOperator,
  validReveal,
  validSession,
} from "./operator";
import { DraftController } from "./draft";
import { CredentialForm } from "./credential-form";
import { RelationshipForm } from "./relationship-form";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it.each(["role", "state", "authentication_method"])(
  "rejects array-valued operator %s",
  (key) => {
    const value = sessionFixture().operator!;
    expect(
      validOperator({ ...value, [key]: [value[key as keyof typeof value]] }),
    ).toBe(false);
  },
);
it.each([
  null,
  {},
  { ...methodsFixture, installation_id: [] },
  { ...methodsFixture, local: "true" },
  { ...methodsFixture, recovery: false },
  { ...methodsFixture, oidc: true },
])("rejects malformed methods %#", (value) =>
  expect(validMethods(value)).toBe(false),
);
it.each(["viewer", "editor", "admin"] as const)(
  "accepts only exact current %s capabilities",
  (role) => {
    const s = sessionFixture(role);
    expect(validSession(s)).toBe(true);
    expect(
      validSession({
        ...s,
        capabilities: [...s.capabilities, "manage_operators"],
      }),
    ).toBe(false);
    expect(
      validSession({ ...s, capabilities: s.capabilities.map((c) => [c]) }),
    ).toBe(false);
    expect(
      validSession({ ...s, operator: { ...s.operator, state: "disabled" } }),
    ).toBe(false);
  },
);
it("validates restricted recovery without customer permissions or a fabricated operator", () => {
  const recovery = {
    ...sessionFixture(),
    operator: null,
    actor_id: "recovery:grant_one",
    authentication_method: "installation_recovery",
    recovery_reason: "Restore named access",
    capabilities: ["session", "manage_operators"],
  };
  expect(validSession(recovery)).toBe(true);
  expect(
    validSession({
      ...recovery,
      capabilities: ["session", "manage_operators", "investigate"],
    }),
  ).toBe(false);
  expect(validSession({ ...recovery, recovery_reason: null })).toBe(false);
});
it.each(["revealed", "unrecoverable"])(
  "validates %s reveal shapes without treating status arrays as authority",
  (status) => {
    const value = {
      operator: sessionFixture().operator,
      secret_status: status,
      credential: status === "revealed" ? `ok_${"a".repeat(43)}` : null,
    };
    expect(validReveal(value)).toBe(true);
    expect(validReveal({ ...value, secret_status: [status] })).toBe(false);
    expect(validReveal({ ...value, credential: "short" })).toBe(false);
  },
);
it.each([401, 403, 408, 429])(
  "%i does not disprove an earlier ambiguous effect",
  (status) =>
    expect(
      definitiveMutationFailure(new ApiError(status, "denied", "Denied")),
    ).toBe(false),
);
it.each(["actor_changed", "stale_authority"])(
  "%s cannot replace the original intent",
  (code) =>
    expect(definitiveMutationFailure(new ApiError(409, code, "Changed"))).toBe(
      false,
    ),
);
it("sends the actor captured in the original mutation and refuses another actor or installation", async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    json({ ok: true }),
  );
  vi.stubGlobal("fetch", fetcher);
  const op = mutation("/checks", { name: "trial" });
  await api.run(op);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    headers: { "X-Krine-Operator-ID": "op_fixture", "Idempotency-Key": op.key },
  });
  api.acceptSession(sessionFixture("admin", "op_other"));
  await expect(api.run(op)).rejects.toMatchObject({ code: "actor_changed" });
  api.acceptSession(sessionFixture());
  api.methods = { ...methodsFixture, installation_id: "other_installation" };
  await expect(api.run(op)).rejects.toMatchObject({ code: "actor_changed" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects a late successful read after actor change", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          finish = r;
        }),
    ),
  );
  const read = api.get("/credentials");
  api.acceptSession(sessionFixture("admin", "op_other"));
  finish(json({ items: ["old private data"] }));
  await expect(read).rejects.toMatchObject({ code: "stale_authority" });
});
it("rejects a late mutation response while preserving its original identity", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          finish = r;
        }),
    ),
  );
  const intent = mutation("/credentials", {
    kind: "server",
    label: "Original",
  });
  const result = api.run(intent);
  api.acceptSession(sessionFixture("viewer", "op_other"));
  finish(json({ secret: "old_secret" }));
  await expect(result).rejects.toMatchObject({ code: "stale_authority" });
  expect(intent.owner.actor_id).toBe("op_fixture");
});
it("does not resubmit and keeps its epoch for same-person reauthentication", async () => {
  const epoch = api.getSnapshot().epoch;
  const intent = mutation("/checks", { name: "trial" });
  const fetcher = vi.fn(async () =>
    json({ ...sessionFixture(), csrf_token: "new_csrf" }),
  );
  vi.stubGlobal("fetch", fetcher);
  api.suspend();
  await api.session({ sign_in_name: "fixture", credential: "saved_secret" });
  expect(api.getSnapshot().epoch).toBe(epoch);
  expect(api.csrf).toBe("new_csrf");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(intent.owner.actor_id).toBe(api.current!.actor_id);
});
it("capability change clears a revealed credential and invalidates the mounted authority", () => {
  const epoch = api.getSnapshot().epoch;
  api.revealCredential({
    operator: sessionFixture().operator!,
    credential: `ok_${"a".repeat(43)}`,
    secret_status: "revealed",
  });
  api.acceptSession(sessionFixture("viewer"));
  expect(api.revealedCredential).toBeNull();
  expect(api.getSnapshot().epoch).toBeGreaterThan(epoch);
});
it.each(["insufficient_privilege", "csrf_failed"])(
  "%s refreshes authority without pretending the session expired",
  async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code, message: "Forbidden" } }, 403)),
    );
    const client = new Api();
    authenticateFixture(client);
    client.onUnauthorized = vi.fn();
    client.onPrivilegeChanged = vi.fn();
    await expect(client.get("/checks")).rejects.toMatchObject({
      status: 403,
      code,
    });
    expect(client.onUnauthorized).not.toHaveBeenCalled();
    expect(client.onPrivilegeChanged).toHaveBeenCalledOnce();
    expect(client.suspended).toBe(false);
  },
);
it("an unreadable 403 does not open a sign-in loop", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("bad", { status: 403 })),
  );
  const client = new Api();
  authenticateFixture(client);
  client.onUnauthorized = vi.fn();
  await expect(client.get("/checks")).rejects.toMatchObject({
    code: "invalid_response",
  });
  expect(client.onUnauthorized).not.toHaveBeenCalled();
});
it("an older current-session response cannot replace a newer sign-in", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            finish = r;
          }),
      )
      .mockResolvedValueOnce(json(sessionFixture("viewer", "op_other"))),
  );
  const older = api.session();
  await api.session({ sign_in_name: "other", credential: "secret" });
  finish(json(sessionFixture()));
  await expect(older).rejects.toMatchObject({ code: "stale_authority" });
  expect(api.current?.actor_id).toBe("op_other");
});
it("namespaces records by installation and original actor, retaining the same storage owner identity", () => {
  const owner = api.requireOwner();
  const one = ownedStorage(sessionStorage, owner);
  one.setItem("draft", "first");
  const two = ownedStorage(sessionStorage, { ...owner, actor_id: "op_other" });
  expect(two.getItem("draft")).toBeNull();
  two.setItem("draft", "second");
  expect(one.getItem("draft")).toBe("first");
  expect(ownedStorage(sessionStorage, owner)).toBe(one);
  expect(
    ownedStorage(sessionStorage, {
      ...owner,
      installation_id: "elsewhere",
    }).getItem("draft"),
  ).toBeNull();
});
it("retains unbound legacy requests without adopting them as an operator", async () => {
  const raw = JSON.stringify({
    operation: {
      path: "/credentials",
      method: "POST",
      key: crypto.randomUUID(),
      body: { kind: "server", label: "Legacy" },
    },
    startedAt: Date.now(),
    kind: "server",
    label: "Legacy",
    id: null,
  });
  sessionStorage.setItem("krine:credential-mutation:v1", raw);
  sessionStorage.setItem("krine:relationship-mutation:v1", "unbound");
  sessionStorage.setItem(
    "krine:draft:trial",
    JSON.stringify({
      policy: { schema_version: 1, inputs: {}, rules: [], otherwise: "ALLOW" },
      description: "Legacy",
      revision: 1,
      intent: null,
    }),
  );
  const run = vi.fn();
  const credential = new CredentialForm({ run }, sessionStorage);
  const relationship = new RelationshipForm({ run }, sessionStorage);
  const draft = new DraftController(
    { run },
    {
      name: "trial",
      description: "Current",
      draft_revision: 1,
      active_version: null,
      has_draft_changes: false,
      updated_at: 1,
      draft: { schema_version: 1, inputs: {}, rules: [], otherwise: "DENY" },
    },
    sessionStorage,
  );
  expect(hasLegacyRecovery(sessionStorage)).toBe(true);
  expect(credential.getSnapshot().pending).toBeNull();
  expect(relationship.getSnapshot().pending).toBeNull();
  expect(draft.state.description).toBe("Current");
  await credential.retry();
  await relationship.retry();
  await draft.retryAction();
  expect(run).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("krine:credential-mutation:v1")).toBe(raw);
});
it("another actor never recovers a stored credential intent", async () => {
  const run = vi
    .fn()
    .mockRejectedValue(new ApiError(0, "connection_failed", "Lost"));
  const first = new CredentialForm({ run }, sessionStorage);
  await first.create("server", "Original");
  first.dispose();
  api.acceptSession(sessionFixture("admin", "op_other"));
  const second = new CredentialForm({ run }, sessionStorage);
  expect(second.getSnapshot().pending).toBeNull();
  await second.retry();
  expect(run).toHaveBeenCalledTimes(1);
  api.acceptSession(sessionFixture());
  const reopened = new CredentialForm({ run }, sessionStorage);
  expect(reopened.getSnapshot().pending?.operation.owner.actor_id).toBe(
    "op_fixture",
  );
});
