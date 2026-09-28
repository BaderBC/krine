import { beforeEach, it, expect, vi } from "vitest";
import { DraftController } from "./draft";
import { ApiError } from "./api";
import type { Check, Policy } from "./types";
const policy: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [],
  otherwise: "DENY",
};
const initial: Check = {
  name: "qa_superseded",
  description: "",
  active_version: 2,
  draft_revision: 3,
  draft: policy,
  has_draft_changes: false,
  updated_at: 1,
};
beforeEach(() => sessionStorage.clear());
it("does not say an older recovered publication governs new attempts", async () => {
  const original = new DraftController(
    {
      run: vi
        .fn()
        .mockRejectedValue(new ApiError(0, "connection_failed", "lost")),
    },
    initial,
    sessionStorage,
  );
  await original.publish();
  original.dispose();
  const latest = { ...initial, active_version: 4, draft_revision: 4 };
  const reopened = new DraftController(
    { run: vi.fn().mockResolvedValue({ version: 3, policy, published_at: 2 }) },
    latest,
    sessionStorage,
  );
  await reopened.retryAction();
  expect(reopened.state.server.active_version).toBe(4);
  expect(reopened.state.notice).toBe(
    "Version 3 published. Version 4 supersedes it.",
  );
});
it("does not claim a superseded restoration is the current draft", async () => {
  const original = new DraftController(
    {
      run: vi
        .fn()
        .mockRejectedValue(new ApiError(0, "connection_failed", "lost")),
    },
    initial,
    sessionStorage,
  );
  await original.restore(1);
  original.dispose();
  const restored = {
    ...initial,
    draft_revision: 4,
    draft: { ...policy, otherwise: "ALLOW" },
    has_draft_changes: true,
  };
  const latest: Check = {
    ...initial,
    draft_revision: 5,
    draft: { ...policy, inputs: { other_editor: "number" } },
    has_draft_changes: true,
  };
  const reopened = new DraftController(
    { run: vi.fn().mockResolvedValue(restored) },
    latest,
    sessionStorage,
  );
  await reopened.retryAction();
  expect(reopened.state.policy).toEqual(latest.draft);
  expect(reopened.state.notice).toBe(
    "Version 1 copied to draft revision 4. Draft revision 5 supersedes that restoration.",
  );
});

it.each([
  { kind: "publish", superseded: false },
  { kind: "publish", superseded: true },
  { kind: "restore", superseded: false },
  { kind: "restore", superseded: true },
] as const)(
  "$kind confirmation distinguishes preserved local work (superseded: $superseded)",
  async ({ kind, superseded }) => {
    const original = new DraftController(
      {
        run: vi
          .fn()
          .mockRejectedValue(new ApiError(0, "connection_failed", "lost")),
      },
      initial,
      sessionStorage,
    );
    if (kind === "publish") await original.publish();
    else await original.restore(1);
    const local: Policy = { ...policy, inputs: { local_input: "number" } };
    original.edit(local, "newer local work");
    original.dispose();

    const restored = { ...initial, draft_revision: 4 };
    const latest = superseded
      ? { ...initial, active_version: 4, draft_revision: 5 }
      : initial;
    const reopened = new DraftController(
      {
        run: vi
          .fn()
          .mockResolvedValue(
            kind === "publish"
              ? { version: 3, policy, published_at: 2 }
              : restored,
          ),
      },
      latest,
      sessionStorage,
    );
    await reopened.retryAction();
    expect(reopened.state.policy).toEqual(local);
    expect(reopened.state.description).toBe("newer local work");
    expect(reopened.state.notice).toBe(
      (kind === "publish"
        ? `Version 3 published.${superseded ? " Version 4 supersedes it." : ""}`
        : `Version 1 copied to draft revision 4.${superseded ? " Draft revision 5 supersedes that restoration." : ""}`) +
        " Your local edits are preserved.",
    );
  },
);
