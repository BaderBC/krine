import { api } from "./api";
import { operatorStorage } from "./operator-test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { DraftController } from "./draft";
import type { Check, Policy } from "./types";

const deny: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [],
  otherwise: "DENY",
};
const allow: Policy = { ...deny, otherwise: "ALLOW" };
const initial: Check = {
  name: "recovery",
  description: "initial",
  active_version: 1,
  draft_revision: 3,
  draft: deny,
  has_draft_changes: false,
  updated_at: 1,
};
const storageKey = "krine:draft:recovery";
const kinds = ["save", "publish", "restore"] as const;
type Kind = (typeof kinds)[number];
function committed(kind: Kind) {
  return kind === "publish"
    ? { version: 2, policy: deny, published_at: 5 }
    : { ...initial, draft_revision: 4, draft: allow };
}
async function submit(model: DraftController, kind: Kind) {
  if (kind === "save") {
    model.edit(allow);
    await model.save();
  } else if (kind === "publish") await model.publish();
  else await model.restore(2);
}
beforeEach(() => sessionStorage.clear());

describe("durable mutation intent before acknowledgement", () => {
  for (const kind of kinds) {
    it.each([401, 403, 408, 429])(
      `${kind} survives %i before replay lookup, reload and a newer shared revision`,
      async (status) => {
        const run = vi
          .fn()
          .mockRejectedValueOnce(
            new ApiError(0, "connection_failed", "Committed response lost"),
          )
          .mockRejectedValueOnce(
            new ApiError(status, "pre_handler_failure", "Retry later"),
          );
        const model = new DraftController({ run }, initial, sessionStorage);
        await submit(model, kind);
        const original = structuredClone(run.mock.calls[0]![0]);
        const intent = JSON.parse(operatorStorage.getItem(storageKey)!).intent;
        model.edit(deny, "new local work");
        await model.retryAction();
        expect(run.mock.calls[1]![0]).toEqual(original);
        expect(model.pending).toBe(true);
        expect(JSON.parse(operatorStorage.getItem(storageKey)!).intent).toEqual(
          intent,
        );
        model.dispose();
        const latest: Check = {
          ...initial,
          active_version: 3,
          draft_revision: 5,
          description: "new shared work",
        };
        const replay = vi.fn().mockResolvedValue(committed(kind));
        const reopened = new DraftController(
          { run: replay },
          latest,
          sessionStorage,
        );
        await reopened.retryAction();
        expect(replay.mock.calls[0]![0]).toEqual(original);
        expect(reopened.pending).toBe(false);
        expect(reopened.state.server).toEqual(latest);
        expect(reopened.state.description).toBe("new local work");
        expect(reopened.state.policy).toEqual(deny);
        expect(
          JSON.parse(operatorStorage.getItem(storageKey)!).intent,
        ).toBeNull();
      },
    );
    it.each([
      ["null", null],
      ["bodyless", undefined],
      ["empty object", {}],
      ["incomplete object", { version: 2, draft_revision: 4 }],
      [
        "invalid policy",
        {
          ...initial,
          draft_revision: 4,
          version: 2,
          published_at: 5,
          policy: { ...deny, rules: [null] },
          draft: { ...deny, rules: [null] },
        },
      ],
    ])(
      `${kind} retains exact durable intent after a %s success response`,
      async (_label, malformed) => {
        const run = vi.fn().mockResolvedValueOnce(malformed);
        const model = new DraftController({ run }, initial, sessionStorage);
        await submit(model, kind);
        expect(model.pending).toBe(true);
        expect(
          kind === "save" ? model.state.status : model.state.action?.status,
        ).toBe("failed");
        const original = structuredClone(run.mock.calls[0]![0]);
        expect(
          JSON.parse(operatorStorage.getItem(storageKey)!).intent.key,
        ).toBe(original.key);
        model.dispose();
        const replay = vi.fn().mockResolvedValue(committed(kind));
        const reopened = new DraftController(
          { run: replay },
          initial,
          sessionStorage,
        );
        await reopened.retryAction();
        expect(replay.mock.calls[0]![0]).toEqual(original);
        expect(reopened.pending).toBe(false);
        expect(operatorStorage.getItem(storageKey)).toBeNull();
      },
    );
  }
  it("does not acknowledge a response for another check or a different saved document", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ...initial,
        name: "another",
        draft_revision: 4,
        draft: allow,
      })
      .mockResolvedValueOnce({ ...initial, draft_revision: 4 })
      .mockResolvedValueOnce(committed("save"));
    const model = new DraftController({ run }, initial, sessionStorage);
    await submit(model, "save");
    await model.retryAction();
    expect(model.pending).toBe(true);
    await model.retryAction();
    expect(model.pending).toBe(false);
    expect(run.mock.calls[2]![0]).toEqual(run.mock.calls[0]![0]);
  });
});

it.each(kinds)(
  "preserves an actor-bound %s intent using a legacy address without rewriting its path",
  async (kind) => {
    const key = `legacy-${kind}`;
    const intent =
      kind === "save"
        ? {
            kind,
            owner: api.requireOwner(),
            key,
            revision: 3,
            document: { policy: allow, description: "older request" },
          }
        : kind === "publish"
          ? {
              kind,
              owner: api.requireOwner(),
              key,
              revision: 3,
              expected_active_version: 1,
            }
          : {
              kind,
              owner: api.requireOwner(),
              key,
              revision: 3,
              version: 2,
              before: { policy: deny, description: "initial" },
            };
    operatorStorage.setItem(
      storageKey,
      JSON.stringify({
        check: "recovery",
        revision: 3,
        policy: allow,
        description: "new local work",
        intent,
      }),
    );
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(403, "csrf", "Sign in again"))
      .mockResolvedValueOnce(committed(kind));
    const reopened = new DraftController(
      { run },
      { ...initial, draft_revision: 7 },
      sessionStorage,
    );
    await reopened.retryAction();
    const expected = {
      owner: api.requireOwner(),
      path: `/checks/recovery/${kind === "save" ? "draft" : kind === "publish" ? "publications" : "restorations"}`,
      method: kind === "save" ? "PUT" : "POST",
      key,
      body:
        kind === "save"
          ? { revision: 3, policy: allow, description: "older request" }
          : kind === "publish"
            ? { revision: 3, expected_active_version: 1 }
            : { revision: 3, version: 2, replace_draft: true },
    };
    expect(run.mock.calls[0]![0]).toEqual(expected);
    expect(JSON.parse(operatorStorage.getItem(storageKey)!).intent).toEqual(
      intent,
    );
    await reopened.retryAction();
    expect(run.mock.calls[1]![0]).toEqual(expected);
  },
);

it.each(kinds)(
  "persists query addressing for a new dot-named %s before first send and keeps it across reload",
  async (kind) => {
    const dotCheck = { ...initial, name: ".." };
    const run = vi.fn().mockImplementation(async () => {
      expect(
        JSON.parse(operatorStorage.getItem("krine:draft:..")!).intent.address,
      ).toBe("query");
      throw new ApiError(0, "lost", "Acknowledgement lost");
    });
    const model = new DraftController({ run }, dotCheck, sessionStorage);
    await submit(model, kind);
    const request = run.mock.calls[0]![0];
    expect(request.path).toBe(
      `/lookup/checks/${kind === "save" ? "draft" : kind === "publish" ? "publications" : "restorations"}?name=..`,
    );
    model.dispose();
    const replay = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "unavailable", "Retry later"));
    const reopened = new DraftController(
      { run: replay },
      { ...dotCheck, draft_revision: 8 },
      sessionStorage,
    );
    await reopened.retryAction();
    expect(replay.mock.calls[0]![0]).toEqual(request);
  },
);
