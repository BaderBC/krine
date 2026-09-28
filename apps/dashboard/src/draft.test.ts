import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, mutation } from "./api";
import type { Mutation } from "./api";
import { DraftController } from "./draft";
import type { Check, Policy } from "./types";

export const deny: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [],
  otherwise: "DENY",
};
export const initial: Check = {
  name: "can_claim_trial",
  description: "",
  active_version: 1,
  draft_revision: 3,
  has_draft_changes: false,
  draft: deny,
  updated_at: 1,
};
beforeEach(() => {
  sessionStorage.clear();
});

describe("draft persistence", () => {
  it("recognizes already-saved recovery and reverting a local edit without an unnecessary request", () => {
    sessionStorage.setItem(
      "krine:draft:can_claim_trial",
      JSON.stringify({
        revision: 2,
        policy: deny,
        description: "",
        pending: null,
      }),
    );
    const run = vi.fn();
    const model = new DraftController({ run }, initial, sessionStorage);
    expect(model.state.status).toBe("saved");
    expect(sessionStorage.length).toBe(0);
    model.edit({ ...deny, otherwise: "ALLOW" });
    model.edit(deny);
    expect(model.state.status).toBe("saved");
    expect(model.dirty).toBe(false);
  });
  it("acknowledges a JSONB response with different key ordering without resaving forever", async () => {
    const run = vi.fn().mockResolvedValue({
      ...initial,
      draft_revision: 4,
      draft: { otherwise: "ALLOW", rules: [], inputs: {}, schema_version: 1 },
    });
    const model = new DraftController({ run }, initial, sessionStorage);
    model.edit({ ...deny, otherwise: "ALLOW" });
    await model.save();
    expect(model.state.status).toBe("saved");
    expect(model.dirty).toBe(false);
    await model.save();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("retains an ambiguous save key and body while new edits remain local, then saves the newer revision", async () => {
    const calls: Mutation[] = [];
    let fail = true;
    const api = {
      run: async <T>(operation: Mutation): Promise<T> => {
        calls.push(operation);
        if (fail) {
          fail = false;
          throw new ApiError(0, "connection_failed", "Connection lost");
        }
        const body = operation.body as {
          revision: number;
          policy: Policy;
          description: string;
        };
        return {
          ...initial,
          draft_revision: body.revision + 1,
          draft: body.policy,
          description: body.description,
        } as T;
      },
    };
    const model = new DraftController(api, initial, sessionStorage);
    model.edit({ ...deny, otherwise: "ALLOW" });
    await model.save();
    expect(model.state.status).toBe("failed");
    model.edit({ ...deny, otherwise: "ALLOW" }, "newer local description");
    await model.save();
    expect(calls[1]).toEqual(calls[0]);
    expect(model.state.description).toBe("newer local description");
    expect(model.state.status).toBe("changed");
    await model.save();
    expect(calls[2]!.key).not.toBe(calls[0]!.key);
    expect(calls[2]!.body).toMatchObject({
      revision: 4,
      description: "newer local description",
    });
    expect(model.state.status).toBe("saved");
    expect(sessionStorage.length).toBe(0);
  });

  it("never overwrites another editor until an explicit reconciliation and catches a second concurrent edit", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Changed"));
    const model = new DraftController({ run }, initial, sessionStorage);
    model.edit({ ...deny, otherwise: "ALLOW" });
    await model.save();
    expect(model.state.status).toBe("conflict");
    model.edit({ ...deny, otherwise: "ALLOW" }, "keep me");
    await model.save();
    expect(run).toHaveBeenCalledTimes(1);
    expect(model.state.policy.otherwise).toBe("ALLOW");
    model.reconcile({ ...initial, draft_revision: 4 }, true);
    await model.save();
    expect(run.mock.calls[1]![0].body.revision).toBe(4);
    expect(model.state.status).toBe("conflict");
    expect(model.state.description).toBe("keep me");
  });

  it("restores lost-response saves after a reload, preserving the original idempotency key", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "unavailable", "Unavailable"));
    const model = new DraftController({ run }, initial, sessionStorage);
    model.edit({ ...deny, otherwise: "ALLOW" });
    await model.save();
    const replay = vi.fn().mockResolvedValue({
      ...initial,
      draft_revision: 4,
      draft: { ...deny, otherwise: "ALLOW" },
    });
    const recovered = new DraftController(
      { run: replay },
      { ...initial, draft_revision: 4 },
      sessionStorage,
    );
    await recovered.save();
    expect(replay.mock.calls[0]![0]).toEqual(run.mock.calls[0]![0]);
    expect(recovered.state.status).toBe("saved");
  });

  it("keeps an in-flight save separate from edits made while it is running", async () => {
    let finish!: (check: Check) => void;
    const run = vi.fn().mockImplementation(
      () =>
        new Promise<Check>((resolve) => {
          finish = resolve;
        }),
    );
    const model = new DraftController({ run }, initial);
    model.edit({ ...deny, otherwise: "ALLOW" });
    const saving = model.save();
    model.edit({ ...deny, otherwise: "ALLOW" }, "edit during save");
    void model.save();
    expect(run).toHaveBeenCalledTimes(1);
    finish({
      ...initial,
      draft_revision: 4,
      draft: { ...deny, otherwise: "ALLOW" },
    });
    await saving;
    expect(model.state.description).toBe("edit during save");
    expect(model.state.status).toBe("changed");
  });

  it("does not serialize an empty numeric field as a null policy value", async () => {
    const run = vi.fn();
    const model = new DraftController({ run }, initial);
    model.edit({
      ...deny,
      rules: [
        {
          id: "rule",
          condition: {
            op: "compare",
            left: { source: "metric", name: "ip.risk", version: 1 },
            comparison: "gte",
            value: NaN,
          },
          then: "DENY",
          on_unknown: "DENY",
        },
      ],
    });
    await model.save();
    expect(run).not.toHaveBeenCalled();
    expect(model.dirty).toBe(true);
  });
});

describe("admin transport", () => {
  it("accepts bodyless logout and sends cookie, CSRF and stable mutation headers", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const api = new Api();
    api.csrf = "session-csrf";
    const operation = mutation("/session", {}, "DELETE");
    await expect(api.run(operation)).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
      method: "DELETE",
      headers: {
        "X-CSRF-Token": "session-csrf",
        "Idempotency-Key": operation.key,
      },
    });
    vi.unstubAllGlobals();
  });
  it("reauthenticates without destroying the current editor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "unauthenticated", message: "Sign in again" },
          }),
          { status: 401 },
        ),
      ),
    );
    const api = new Api();
    const expired = vi.fn();
    api.onUnauthorized = expired;
    await expect(api.get("/checks")).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(expired).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe("publication and restoration recovery", () => {
  it("recovers the reviewed publication after reopening without publishing newer local content", async () => {
    const first = vi
      .fn()
      .mockRejectedValue(new ApiError(0, "connection_failed", "Response lost"));
    const original = new DraftController(
      { run: first },
      initial,
      sessionStorage,
    );
    await original.publish();
    original.edit({ ...deny, otherwise: "ALLOW" }, "newer local draft");
    original.dispose();
    const replay = vi
      .fn()
      .mockResolvedValue({ version: 2, policy: deny, published_at: 5 });
    const reopened = new DraftController(
      { run: replay },
      { ...initial, active_version: 2 },
      sessionStorage,
    );
    expect(reopened.state.action?.status).toBe("recovering");
    await reopened.retryAction();
    expect(replay.mock.calls[0]![0]).toEqual(first.mock.calls[0]![0]);
    expect(replay.mock.calls[0]![0].body).toEqual({
      revision: 3,
      expected_active_version: 1,
    });
    expect(reopened.state.policy.otherwise).toBe("ALLOW");
    expect(reopened.state.description).toBe("newer local draft");
    expect(reopened.state.server.active_version).toBe(2);
    expect(sessionStorage.getItem("krine:draft:can_claim_trial")).toContain(
      "newer local draft",
    );
  });
  it("recovers a restoration while preserving edits made after its explicit replacement confirmation", async () => {
    const first = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "unavailable", "Response lost"));
    const original = new DraftController(
      { run: first },
      initial,
      sessionStorage,
    );
    await original.restore(1);
    original.edit({ ...deny, otherwise: "ALLOW" }, "newer work");
    original.dispose();
    const replay = vi
      .fn()
      .mockResolvedValue({
        ...initial,
        draft_revision: 4,
        description: "saved restoration",
      });
    const reopened = new DraftController(
      { run: replay },
      initial,
      sessionStorage,
    );
    await reopened.retryAction();
    expect(replay.mock.calls[0]![0]).toEqual(first.mock.calls[0]![0]);
    expect(reopened.state.server.draft_revision).toBe(4);
    expect(reopened.state.policy.otherwise).toBe("ALLOW");
    expect(reopened.state.description).toBe("newer work");
  });
  it("never downgrades a newer shared revision when recovering an earlier committed save", async () => {
    const first = vi
      .fn()
      .mockRejectedValue(new ApiError(0, "connection_failed", "Response lost"));
    const original = new DraftController(
      { run: first },
      initial,
      sessionStorage,
    );
    original.edit({ ...deny, otherwise: "ALLOW" });
    await original.save();
    original.dispose();
    const replay = vi
      .fn()
      .mockResolvedValue({
        ...initial,
        draft_revision: 4,
        draft: { ...deny, otherwise: "ALLOW" },
      });
    const reopened = new DraftController(
      { run: replay },
      { ...initial, draft_revision: 5, description: "Another editor's draft" },
      sessionStorage,
    );
    await reopened.save();
    expect(reopened.state.server.draft_revision).toBe(5);
    expect(reopened.state.status).toBe("conflict");
    expect(reopened.state.policy.otherwise).toBe("ALLOW");
    await reopened.save();
    expect(replay).toHaveBeenCalledTimes(1);
  });
  it("rejects a stored intent copied from another check or an arbitrary request endpoint", async () => {
    sessionStorage.setItem(
      "krine:draft:can_claim_trial",
      JSON.stringify({
        check: "another_check",
        revision: 3,
        policy: deny,
        description: "",
        intent: {
          kind: "publish",
          key: "intent",
          revision: 3,
          expected_active_version: 1,
        },
      }),
    );
    const run = vi.fn();
    const model = new DraftController({ run }, initial, sessionStorage);
    await model.retryAction();
    expect(run).not.toHaveBeenCalled();
    expect(model.state.error).toContain("could not be read");
    sessionStorage.setItem(
      "krine:draft:can_claim_trial",
      JSON.stringify({
        check: initial.name,
        revision: 3,
        policy: deny,
        description: "",
        intent: {
          path: "/credentials",
          method: "POST",
          key: "intent",
          body: {},
        },
      }),
    );
    const arbitrary = new DraftController({ run }, initial, sessionStorage);
    await arbitrary.retryAction();
    expect(run).not.toHaveBeenCalled();
  });
  it("a detached failed save cannot recreate recovery after a newer controller discarded the edit", async () => {
    let fail!: (reason: unknown) => void;
    const old = new DraftController(
      {
        run: () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      },
      initial,
      sessionStorage,
    );
    old.edit({ ...deny, otherwise: "ALLOW" });
    const saving = old.save();
    const newer = new DraftController(
      { run: vi.fn() },
      initial,
      sessionStorage,
    );
    // Recover the same intent first, then deliberately reconcile the document.
    const rejected = new DraftController(
      {
        run: vi
          .fn()
          .mockRejectedValue(
            new ApiError(409, "revision_conflict", "Conflict"),
          ),
      },
      initial,
      sessionStorage,
    );
    await rejected.save();
    rejected.reconcile(initial, false);
    expect(sessionStorage.getItem("krine:draft:can_claim_trial")).toBeNull();
    fail(new ApiError(503, "unavailable", "Unavailable"));
    await saving;
    expect(sessionStorage.getItem("krine:draft:can_claim_trial")).toBeNull();
    newer.dispose();
  });
});
