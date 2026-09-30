import { operatorStorage } from "./operator-test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
import { DraftController } from "./draft";
import { ApiError } from "./api";
import type { Check, Policy } from "./types";
const deny: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [],
  otherwise: "DENY",
};
const allow: Policy = { ...deny, otherwise: "ALLOW" };
const initial: Check = {
  name: "qa_replay",
  description: "initial",
  active_version: 1,
  draft_revision: 3,
  draft: deny,
  has_draft_changes: false,
  updated_at: 1,
};
beforeEach(() => sessionStorage.clear());
it.each(["save", "restore"] as const)(
  "recovering %s must not regress a newer active version at the same draft revision",
  async (kind) => {
    const firstRun = vi
      .fn()
      .mockRejectedValue(new ApiError(0, "connection_failed", "lost response"));
    const original = new DraftController(
      { run: firstRun },
      initial,
      sessionStorage,
    );
    if (kind === "save") {
      original.edit(allow);
      await original.save();
    } else await original.restore(2);
    original.dispose();
    // Revision 4 committed under active v1, then another editor published it as v2.
    const committed = {
      ...initial,
      draft: allow,
      draft_revision: 4,
      has_draft_changes: true,
    };
    const latest = {
      ...committed,
      active_version: 2,
      has_draft_changes: false,
    };
    const replayRun = vi.fn().mockResolvedValue(committed);
    const reopened = new DraftController(
      { run: replayRun },
      latest,
      sessionStorage,
    );
    if (kind === "save") await reopened.save();
    else await reopened.retryAction();
    expect(replayRun.mock.calls[0]![0]).toEqual(firstRun.mock.calls[0]![0]);
    expect(reopened.state.server.active_version).toBe(2);
    expect(reopened.state.server.has_draft_changes).toBe(false);
  },
);

const snapshot = (
  draft_revision: number,
  active_version: number | null,
  draft: Policy,
  has_draft_changes: boolean,
): Check => ({
  ...initial,
  draft_revision,
  active_version,
  draft,
  has_draft_changes,
});

const orderings = [
  {
    name: "older draft and publication",
    latest: snapshot(5, 2, deny, true),
    response: snapshot(4, 1, allow, true),
    accept: false,
  },
  {
    name: "older draft with the same publication",
    latest: snapshot(5, 1, deny, false),
    response: snapshot(4, 1, allow, true),
    accept: false,
  },
  {
    name: "same draft with an older publication",
    latest: snapshot(4, 2, allow, false),
    response: snapshot(4, 1, allow, true),
    accept: false,
  },
  {
    name: "same draft and publication",
    latest: snapshot(4, 1, allow, true),
    response: snapshot(4, 1, allow, true),
    accept: true,
  },
  {
    name: "same draft with a newer publication",
    latest: snapshot(4, 1, allow, true),
    response: snapshot(4, 2, allow, false),
    accept: true,
  },
  {
    name: "newer draft with the same publication",
    latest: snapshot(3, 1, deny, false),
    response: snapshot(4, 1, allow, true),
    accept: true,
  },
  {
    name: "newer draft and publication",
    latest: snapshot(3, 1, deny, false),
    response: snapshot(4, 2, allow, false),
    accept: true,
  },
  {
    name: "first publication after an unpublished snapshot",
    latest: snapshot(3, null, deny, true),
    response: snapshot(4, 1, allow, true),
    accept: true,
  },
];

for (const kind of ["save", "restore"] as const) {
  it.each(orderings)(
    `${kind} recovery selects a coherent snapshot: $name`,
    async ({ latest, response, accept }) => {
      const firstRun = vi
        .fn()
        .mockRejectedValue(
          new ApiError(0, "connection_failed", "lost response"),
        );
      const original = new DraftController(
        { run: firstRun },
        {
          ...initial,
          active_version: latest.active_version === null ? null : 1,
        },
        sessionStorage,
      );
      if (kind === "save") {
        original.edit(allow);
        await original.save();
      } else await original.restore(2);
      const local: Policy = { ...deny, inputs: { reviewed_value: "number" } };
      original.edit(local, "newer local work");
      original.dispose();

      const replayRun = vi.fn().mockResolvedValue(response);
      const reopened = new DraftController(
        { run: replayRun },
        latest,
        sessionStorage,
      );
      await reopened.retryAction();

      expect(replayRun.mock.calls[0]![0]).toEqual(firstRun.mock.calls[0]![0]);
      expect(reopened.state.server).toEqual(accept ? response : latest);
      expect(reopened.state.policy).toEqual(local);
      expect(reopened.state.description).toBe("newer local work");
      expect(reopened.pending).toBe(false);
      expect(reopened.state.status).toBe(
        latest.draft_revision > response.draft_revision
          ? "conflict"
          : "changed",
      );
      expect(operatorStorage.getItem("krine:draft:qa_replay")).toContain(
        "newer local work",
      );
    },
  );
}
it.each(["publish", "restore"] as const)(
  "old detached %s completion cannot overwrite the actual newer owner",
  async (kind) => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    const old = new DraftController(
      {
        run: vi
          .fn()
          .mockImplementation(() => new Promise((r) => (finishOld = r))),
      },
      initial,
      sessionStorage,
    );
    const oldPromise = kind === "publish" ? old.publish() : old.restore(1);
    old.dispose();
    const reopened = new DraftController(
      {
        run: vi
          .fn()
          .mockImplementation(() => new Promise((r) => (finishNew = r))),
      },
      initial,
      sessionStorage,
    );
    const newPromise = reopened.retryAction();
    reopened.edit(allow, "new owner edits");
    const result =
      kind === "publish"
        ? { version: 2, published_at: 5, policy: deny }
        : { ...initial, draft_revision: 4 };
    finishOld(result);
    await oldPromise;
    expect(reopened.state.action?.status).toBe("running");
    expect(operatorStorage.getItem("krine:draft:qa_replay")).toContain(
      "new owner edits",
    );
    finishNew(result);
    await newPromise;
    expect(reopened.state.policy).toEqual(allow);
    expect(reopened.state.description).toBe("new owner edits");
    expect(operatorStorage.getItem("krine:draft:qa_replay")).toContain(
      "new owner edits",
    );
  },
);
