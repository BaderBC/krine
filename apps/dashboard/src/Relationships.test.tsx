import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, ApiError } from "./api";
import { Activity, DecisionPage, EntityPage } from "./Activity";
import type {
  DecisionDetail,
  Entity,
  Relationship,
  RelationshipDetail,
} from "./types";

const original: Relationship = {
  id: "association_one",
  kind: "backend",
  client_id: "cli_one",
  session_id: "ses_one",
  user_id: "user_one",
  ip: null,
  first_seen: 100,
  last_seen: 100,
  source: "backend",
  credential_id: "cred_one",
  last_credential_id: "cred_one",
  first_source: "backend",
  last_source: "backend",
  first_event_id: null,
  last_event_id: null,
  revision: 1,
  revoked_at: null,
  revocation_reason: null,
  revoked_by: null,
  metadata: {},
};
const corrected = {
  ...original,
  revision: 2,
  revoked_at: 200,
  revocation_reason: "Wrong account",
  revoked_by: "administrator",
};
const ipSegment: Relationship = {
  ...original,
  id: "observation_one",
  kind: "observed_ip",
  user_id: null,
  ip: "203.0.113.5",
  last_seen: 150,
  source: "browser_observation",
  first_source: "browser.context",
  last_source: "browser.proof",
  first_event_id: "context_event",
  last_event_id: "context_event",
};
let rows: Relationship[];
let detail: RelationshipDetail;
let entity: Entity;
let entityFailure: unknown;
let sourceFailure: unknown;
const scope =
  "/activity?entity=cli_one&entity_kind=client&from=1&to=200&cursor=two";
function mount(
  path = `/entities/client/cli_one?relationship_kind=backend&relationship_id=association_one&return_to=${encodeURIComponent(scope)}`,
) {
  const router = createMemoryRouter(
    [
      { path: "/entities/:kind/:id", element: <EntityPage /> },
      { path: "/inspect/entity", element: <EntityPage /> },
      { path: "/activity", element: <Activity /> },
      { path: "/activity/decisions/:id", element: <DecisionPage /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  sessionStorage.clear();
  rows = [structuredClone(original)];
  detail = {
    relationship: structuredClone(original),
    recalculation: "complete",
    audit: { items: [], next_cursor: null },
  };
  entity = {
    kind: "client",
    id: "cli_one",
    first_seen: 100,
    metadata: {},
    metrics: {
      "client.user_count_30d": {
        version: 1,
        state: { status: "known", value: 1 },
        provenance: { source: "backend", observed_at: 100 },
      },
    },
    associations: [],
    associations_next_cursor: null,
    recent_decisions: [],
    recent_events: [],
  };
  entityFailure = undefined;
  sourceFailure = undefined;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  vi.spyOn(api, "get").mockImplementation(
    async <T,>(path: string): Promise<T> => {
      if (path.startsWith("/lookup/entities/relationships?"))
        return {
          items: structuredClone(rows),
          next_cursor: "next_relationships",
        } as T;
      if (path.startsWith("/lookup/relationships?")) {
        if (sourceFailure !== undefined) {
          if (sourceFailure instanceof Error) throw sourceFailure;
          return sourceFailure as T;
        }
        return structuredClone(detail) as T;
      }
      if (path.startsWith("/lookup/entities?")) {
        if (entityFailure !== undefined) {
          if (entityFailure instanceof Error) throw entityFailure;
          return entityFailure as T;
        }
        return structuredClone(entity) as T;
      }
      if (path.startsWith("/activity/"))
        return { items: [], next_cursor: null } as T;
      throw new Error(path);
    },
  );
  vi.spyOn(api, "run").mockImplementation(async <T,>(): Promise<T> => {
    detail.relationship = structuredClone(corrected);
    rows = [corrected];
    entity.metrics["client.user_count_30d"]!.state = {
      status: "known",
      value: 0,
    };
    return {
      relationship: structuredClone(corrected),
      audit_id: "audit_one",
      recalculation: "complete",
    } as T;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function startReview(
  user: ReturnType<typeof userEvent.setup>,
  text = "Wrong account",
) {
  await user.click(
    await screen.findByRole("button", { name: "Correct relationship" }),
  );
  expect(document.activeElement?.id).toBe("relationship-review-heading");
  await user.type(screen.getByRole("textbox", { name: "Reason" }), text);
}
it("loads an off-page source directly, displays exact provenance and keeps Activity return scope", async () => {
  rows = [];
  mount();
  await screen.findByRole("button", { name: "Correct relationship" });
  expect(screen.getByText("No retained direct relationships.")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Back to Activity" }).getAttribute("href"),
  ).toBe(scope);
  expect(
    screen.getByRole("link", { name: "View activity" }).getAttribute("href"),
  ).toContain("entity_kind=client");
  const source = document.querySelector(".relationship-detail")!;
  for (const text of [
    "cli_one",
    "ses_one",
    "user_one",
    "cred_one",
    "association_one",
  ])
    expect(source.textContent).toContain(text);
  expect(source.textContent).toContain("Revision 1");
});
it("requires a valid reason and an explicit review, then refreshes current metrics", async () => {
  const user = userEvent.setup();
  mount();
  await startReview(user, "é".repeat(257));
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("1–512 UTF-8 bytes"),
  );
  expect(api.run).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Reason" }),
  );
  await user.clear(screen.getByRole("textbox", { name: "Reason" }));
  await user.type(
    screen.getByRole("textbox", { name: "Reason" }),
    "Wrong account",
  );
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByText(/Change accepted at revision 2/);
  await screen.findByRole("button", { name: "Restore relationship" });
  expect(document.activeElement?.id).toBe("relationship-change-result");
  expect(document.querySelector(".metric-values dd")?.textContent).toContain(
    "0",
  );
  expect(api.run).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.run).mock.calls[0]![0].body).toEqual({
    revision: 1,
    reason: "Wrong account",
  });
});
it.each([
  null,
  { malformed: true },
  new ApiError(503, "unavailable", "unavailable"),
])(
  "retains a confirmed result and review surface when entity refresh fails %#",
  async (failure) => {
    const user = userEvent.setup();
    mount();
    await startReview(user);
    entityFailure = failure;
    await user.click(
      screen.getByRole("button", { name: "Confirm correction" }),
    );
    await screen.findByText(/Change accepted at revision 2/);
    await screen.findByText(/Showing stale data/);
    expect(
      screen.getByRole("button", { name: "Restore relationship" }),
    ).toBeTruthy();
    expect(document.querySelector(".metric-values dd")?.textContent).toContain(
      "1",
    );
  },
);
it("keeps the exact request after malformed success, reload and a sign-in interruption", async () => {
  const user = userEvent.setup();
  vi.mocked(api.run)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new ApiError(401, "unauthorized", "unauthorized"));
  const router = mount();
  await startReview(user);
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByText(/result is unconfirmed/);
  const operation = vi.mocked(api.run).mock.calls[0]![0];
  cleanup();
  mount(router.state.location.pathname + router.state.location.search);
  await user.click(
    await screen.findByRole("button", { name: "Retry same reviewed request" }),
  );
  await screen.findByText(/Sign in again/);
  await user.click(
    screen.getByRole("button", { name: "Retry same reviewed request" }),
  );
  await screen.findByText(/Change accepted/);
  expect(vi.mocked(api.run).mock.calls.map(([op]) => op)).toEqual([
    operation,
    operation,
    operation,
  ]);
});
it("a conflict requires a new explicit review and never adopts the new revision silently", async () => {
  const user = userEvent.setup();
  mount();
  await startReview(user);
  detail.relationship = { ...original, revision: 4 };
  vi.mocked(api.run).mockRejectedValueOnce(
    new ApiError(409, "revision_conflict", "conflict"),
  );
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByRole("button", { name: "Review current relationship" });
  expect(
    screen.queryByRole("button", { name: "Confirm correction" }),
  ).toBeNull();
  expect(api.run).toHaveBeenCalledTimes(1);
  const review = document.querySelector(".review")!;
  expect(review.textContent).toContain("Revision 1");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Review current relationship",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(
    screen.getByRole("button", { name: "Review current relationship" }),
  );
  expect(document.querySelector(".review")?.textContent).toContain(
    "Revision 4",
  );
  expect(
    (screen.getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement)
      .value,
  ).toBe("");
  expect(api.run).toHaveBeenCalledTimes(1);
});
it("never treats a superseded replay receipt as the current source", async () => {
  const user = userEvent.setup();
  mount();
  await startReview(user);
  vi.mocked(api.run).mockImplementationOnce(async <T,>(): Promise<T> => {
    detail.relationship = { ...original, revision: 3 };
    return {
      relationship: corrected,
      audit_id: "audit_one",
      recalculation: "complete",
    } as T;
  });
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByText(/Change accepted at revision 2/);
  await waitFor(() =>
    expect(
      document.querySelector(".relationship-provenance")?.textContent,
    ).toContain("Revision 3"),
  );
  expect(
    screen.getByRole("button", { name: "Correct relationship" }),
  ).toBeTruthy();
});
it("retains newer source evidence and blocks a review when a later read is stale or malformed", async () => {
  const user = userEvent.setup();
  detail.relationship = corrected;
  mount();
  await user.click(
    await screen.findByText("Audit history", { selector: "summary" }),
  );
  detail.relationship = original;
  await user.click(
    screen.getByRole("button", { name: "Refresh source and audit" }),
  );
  await screen.findByText(/source response is older/);
  expect(
    document.querySelector(".relationship-provenance")?.textContent,
  ).toContain("Revision 2");
  expect(
    (
      screen.getByRole("button", {
        name: "Restore relationship",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  sourceFailure = null;
  await user.click(
    screen.getByRole("button", { name: "Refresh source and audit" }),
  );
  await screen.findByText(/Showing stale data/);
  expect(
    document.querySelector(".relationship-provenance")?.textContent,
  ).toContain("Revision 2");
});
it("explains observed-segment cutoff and a conflicting newer active segment", async () => {
  const user = userEvent.setup();
  detail.relationship = {
    ...ipSegment,
    revision: 2,
    revoked_at: 200,
    revocation_reason: "Bad evidence",
    revoked_by: "administrator",
  };
  rows = [detail.relationship];
  mount(
    "/entities/client/cli_one?relationship_kind=observed_ip&relationship_id=observation_one",
  );
  await user.click(
    await screen.findByRole("button", { name: "Restore relationship" }),
  );
  expect(document.querySelector(".review")?.textContent).toContain(
    "newer active segment",
  );
  expect(
    screen.getByRole("link", { name: "context_event" }).getAttribute("href"),
  ).toContain("/inspect/event?id=context_event");
  await user.type(
    screen.getByRole("textbox", { name: "Reason" }),
    "Rechecked source",
  );
  vi.mocked(api.run).mockRejectedValueOnce(
    new ApiError(409, "relationship_active", "conflict"),
  );
  await user.click(screen.getByRole("button", { name: "Confirm restoration" }));
  await screen.findByText(/This segment was not restored/);
  expect(api.run).toHaveBeenCalledTimes(1);
});
it("keeps selected source and return scope while paginating relationships and audit", async () => {
  const user = userEvent.setup();
  detail.audit.next_cursor = "older_audit";
  mount();
  await user.click(
    await screen.findByRole("button", { name: "Next relationships →" }),
  );
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining("cursor=next_relationships"),
    ),
  );
  expect(document.activeElement?.id).toBe("relationships-heading");
  await user.click(screen.getByText("Audit history", { selector: "summary" }));
  await user.click(
    screen.getByRole("button", { name: "Older audit records →" }),
  );
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      "/lookup/relationships?kind=backend&id=association_one&limit=20&cursor=older_audit",
    ),
  );
  expect(
    screen.getByRole("link", { name: "Back to Activity" }).getAttribute("href"),
  ).toBe(scope);
  await screen.findByRole("button", { name: "Latest audit records" });
});
it("blocks navigation with a pending change and returns focus on canceled review", async () => {
  const user = userEvent.setup();
  const router = mount();
  await startReview(user);
  await user.click(screen.getByRole("button", { name: "Cancel review" }));
  expect(document.activeElement?.id).toBe("relationship-detail-heading");
  await startReview(user);
  vi.mocked(api.run).mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByText(/result is unconfirmed/);
  await user.click(screen.getByRole("link", { name: "Back to Activity" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByRole("button", { name: "Discard review and leave" }),
  ).toBeNull();
  await user.click(
    within(dialog).getByRole("button", { name: "Stay with relationship" }),
  );
  expect(router.state.location.pathname).toBe("/entities/client/cli_one");
});
it("keeps historical sample count, truncation and revision separate from current source links", async () => {
  const record = {
    decision_id: "dec_one",
    operation_id: "op_one",
    check: "trial",
    policy_version: 1,
    outcome: "DENY",
    reason: "rule_denied",
    accepted_at: 200,
    completed_at: 200,
    client_id: "cli_one",
    session_id: "ses_one",
    user_id: "user_one",
    ip: "203.0.113.5",
    source: "evaluation",
    snapshot: { inputs: {}, metrics: {} },
    relationship_context: {
      items: Array.from({ length: 100 }, (_, i) => ({
        ...original,
        id: `association_${i}`,
        metadata: undefined,
      })),
      total: 125,
      truncated: true,
      observed_at: 200,
      observed_ip: ipSegment,
    },
  } as unknown as DecisionDetail;
  vi.mocked(api.get).mockResolvedValue(record);
  mount(`/activity/decisions/dec_one?return_to=${encodeURIComponent(scope)}`);
  const user = userEvent.setup();
  await user.click(
    await screen.findByText("Evidence captured for this decision", {
      selector: "summary",
    }),
  );
  const captured = screen.getByRole("region", {
    name: "Captured relationships",
  });
  expect(captured.textContent).toContain("125 active backend assertions");
  expect(captured.textContent).toContain(
    "100 captured summaries; this sample is not the complete inventory",
  );
  await user.click(
    within(captured).getAllByText(/Backend assertion.*Revision 1/, {
      selector: "summary",
    })[0]!,
  );
  expect(
    within(captured)
      .getAllByRole("link", { name: "Inspect current source" })[0]!
      .getAttribute("href"),
  ).toContain("relationship_kind=backend&relationship_id=association_0");
  expect(captured.textContent).toContain(
    "These facts do not change when a relationship is corrected.",
  );
});
it("preserves typed entity and exact time scope across Activity view/filter/pagination changes", async () => {
  const user = userEvent.setup();
  const router = mount(scope);
  await screen.findByText(/Scoped to client/);
  await user.click(screen.getByRole("link", { name: "Events" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining(
        "/activity/events?entity=cli_one&from=1&to=200&entity_kind=client",
      ),
    ),
  );
  expect(router.state.location.search).not.toContain("cursor=");
  await user.type(screen.getByRole("searchbox", { name: "Search" }), "login");
  await user.click(screen.getByRole("button", { name: "Find" }));
  const params = new URLSearchParams(router.state.location.search);
  expect(params.get("entity_kind")).toBe("client");
  expect(params.get("entity")).toBe("cli_one");
  expect(params.get("from")).toBe("1");
  expect(params.get("to")).toBe("200");
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Find by" }),
    "entity",
  );
  await user.clear(screen.getByRole("searchbox", { name: "Search" }));
  await user.type(
    screen.getByRole("searchbox", { name: "Search" }),
    "another_id",
  );
  await user.click(screen.getByRole("button", { name: "Find" }));
  expect(
    new URLSearchParams(router.state.location.search).has("entity_kind"),
  ).toBe(false);
  expect(screen.getByText(/does not report it automatically/)).toBeTruthy();
});

it("keeps a recovered receipt visible when the request is resumed from an entity URL without source selection", async () => {
  const user = userEvent.setup();
  mount();
  await startReview(user);
  vi.mocked(api.run).mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByText(/result is unconfirmed/);
  cleanup();
  mount("/entities/client/cli_one");
  await user.click(
    await screen.findByRole("button", { name: "Retry same reviewed request" }),
  );
  await screen.findByText(/Change accepted at revision 2/);
  await screen.findByRole("button", { name: "Restore relationship" });
});

it("late reads cannot replace the newly selected source or silently seed its review", async () => {
  const user = userEvent.setup();
  let finish!: (value: unknown) => void;
  rows = [original, ipSegment];
  const get = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(
    async <T,>(path: string): Promise<T> => {
      if (path.startsWith("/lookup/relationships?kind=backend&"))
        return (await new Promise<unknown>((resolve) => {
          finish = resolve;
        })) as T;
      if (path.startsWith("/lookup/relationships?kind=observed_ip&"))
        return { ...detail, relationship: ipSegment } as T;
      return (await get(path)) as T;
    },
  );
  mount();
  await user.click(
    await screen.findByRole("button", {
      name: "Inspect IP segment observation_one",
    }),
  );
  await waitFor(() =>
    expect(
      document.querySelector(".relationship-provenance")?.textContent,
    ).toContain("observation_one"),
  );
  finish({ ...detail, relationship: corrected });
  await waitFor(() =>
    expect(
      document.querySelector(".relationship-provenance")?.textContent,
    ).not.toContain("association_one"),
  );
  await startReview(user);
  expect(document.querySelector(".review")?.textContent).toContain(
    "observation_one",
  );
  expect(document.querySelector(".review")?.textContent).toContain(
    "New browser observations can create a new active segment.",
  );
});

it("shows explicit failed reads for invalid initial entity/source responses and recovers without a new route", async () => {
  const user = userEvent.setup();
  entityFailure = null;
  sourceFailure = null;
  mount();
  await screen.findAllByText(/Could not load this information/);
  expect(
    screen
      .queryByRole("button", { name: "Correct relationship" })
      ?.hasAttribute("disabled"),
  ).toBe(true);
  entityFailure = undefined;
  sourceFailure = undefined;
  for (const retry of screen.getAllByRole("button", { name: "Retry" }))
    await user.click(retry);
  await screen.findByRole("heading", { name: "cli_one" });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Correct relationship",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});

it("a mismatched detail response cannot authorize a change to another relationship", async () => {
  detail.relationship = { ...original, id: "other_assertion" };
  mount();
  await screen.findByText(/Could not load this information/);
  expect(
    (
      screen.getByRole("button", {
        name: "Correct relationship",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(api.run).not.toHaveBeenCalled();
});

const recentDecision = {
  decision_id: "decision_one",
  operation_id: "operation_one",
  check: "can_claim_trial",
  policy_version: 1,
  outcome: "DENY",
  reason: "rule_denied",
  accepted_at: 100,
  completed_at: 101,
  client_id: "cli_one",
  session_id: "ses_one",
  user_id: null,
  ip: "127.0.0.1",
  source: "evaluation" as const,
};
const recentEvent = {
  event_id: "event_one",
  name: "trial_requested",
  accepted_at: 100,
  provenance: "backend" as const,
  client_id: "cli_one",
  user_id: null,
};
it.each([
  ["wrong entity ID", { id: "cli_other" }],
  ["wrong entity kind", { kind: "user" }],
  [
    "unknown metric with an object reason",
    {
      metrics: {
        "client.user_count_30d": {
          version: 1,
          state: { status: "unknown", reason: { invalid: true } },
          provenance: { source: "backend", observed_at: 100 },
        },
      },
    },
  ],
  [
    "known metric with an object value",
    {
      metrics: {
        "client.user_count_30d": {
          version: 1,
          state: { status: "known", value: { invalid: true } },
          provenance: { source: "backend", observed_at: 100 },
        },
      },
    },
  ],
  [
    "known metric with a missing value",
    {
      metrics: {
        "client.user_count_30d": {
          version: 1,
          state: { status: "known" },
          provenance: { source: "backend", observed_at: 100 },
        },
      },
    },
  ],
  [
    "known metric with a nonfinite value",
    {
      metrics: {
        "client.user_count_30d": {
          version: 1,
          state: { status: "known", value: Infinity },
          provenance: { source: "backend", observed_at: 100 },
        },
      },
    },
  ],
  [
    "metric with a malformed provenance time",
    {
      metrics: {
        "client.user_count_30d": {
          version: 1,
          state: { status: "known", value: 1 },
          provenance: { source: "backend", observed_at: "yesterday" },
        },
      },
    },
  ],
  ["null event row", { recent_events: [null] }],
  [
    "event with a nonstring provenance",
    { recent_events: [{ ...recentEvent, provenance: ["backend"] }] },
  ],
  [
    "event with an object name",
    { recent_events: [{ ...recentEvent, name: {} }] },
  ],
  [
    "event with an object subject",
    { recent_events: [{ ...recentEvent, user_id: {} }] },
  ],
  [
    "event with a missing timestamp",
    { recent_events: [{ ...recentEvent, accepted_at: undefined }] },
  ],
  ["null decision row", { recent_decisions: [null] }],
  [
    "decision with a nonstring source",
    { recent_decisions: [{ ...recentDecision, source: ["evaluation"] }] },
  ],
  [
    "decision with an object reason",
    { recent_decisions: [{ ...recentDecision, reason: {} }] },
  ],
  [
    "decision with an object check",
    { recent_decisions: [{ ...recentDecision, check: {} }] },
  ],
  [
    "decision with an object outcome",
    { recent_decisions: [{ ...recentDecision, outcome: {} }] },
  ],
  [
    "decision with an object subject",
    { recent_decisions: [{ ...recentDecision, user_id: {} }] },
  ],
  [
    "decision with a malformed timestamp",
    { recent_decisions: [{ ...recentDecision, accepted_at: "yesterday" }] },
  ],
])(
  "rejects %s on entity refresh without replacing evidence or losing a confirmed change",
  async (_name, invalid) => {
    const user = userEvent.setup();
    mount();
    await startReview(user);
    entityFailure = { ...structuredClone(entity), ...invalid };
    await user.click(
      screen.getByRole("button", { name: "Confirm correction" }),
    );
    await screen.findByText(/Change accepted at revision 2/);
    await screen.findByText(/Showing stale data/);
    expect(screen.getByRole("heading", { name: "cli_one" })).toBeTruthy();
    expect(document.querySelector(".metric-values dd")?.textContent).toMatch(
      /^1/,
    );
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Restore relationship" }),
    ).toBeTruthy();
    expect(api.run).toHaveBeenCalledTimes(1);
  },
);

it("keeps a pending reviewed restoration when another malformed entity retry fails", async () => {
  const user = userEvent.setup();
  mount();
  await startReview(user);
  entityFailure = { ...structuredClone(entity), recent_events: [null] };
  await user.click(screen.getByRole("button", { name: "Confirm correction" }));
  await screen.findByText(/Showing stale data/);
  await user.click(
    screen.getByRole("button", { name: "Restore relationship" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Reason" }),
    "Restore reviewed evidence",
  );
  vi.mocked(api.run).mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Confirm restoration" }));
  await screen.findByRole("button", { name: "Retry same reviewed request" });
  const saved = sessionStorage.getItem("krine:relationship-mutation:v1");
  entityFailure = {
    ...structuredClone(entity),
    kind: "user",
    id: "other_user",
  };
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/Showing stale data/);
  expect(
    screen.getByRole("button", { name: "Retry same reviewed request" }),
  ).toBeTruthy();
  expect(document.querySelector(".review")?.textContent).toContain(
    "Restore reviewed evidence",
  );
  expect(sessionStorage.getItem("krine:relationship-mutation:v1")).toBe(saved);
  expect(screen.getByRole("heading", { name: "cli_one" })).toBeTruthy();
  expect(api.run).toHaveBeenCalledTimes(2);
});

it("shows an initial identity read failure and accepts a later valid additive response", async () => {
  const user = userEvent.setup();
  entityFailure = { ...entity, id: "wrong_client" };
  mount();
  await screen.findByText(/Could not load this information/);
  expect(screen.queryByRole("heading", { name: "wrong_client" })).toBeNull();
  entityFailure = {
    ...entity,
    additional_future_field: { retained: true },
    metrics: {
      "client.user_count_30d": entity.metrics["client.user_count_30d"],
      "client.flag": {
        version: 1,
        state: { status: "known", value: true, additional: "allowed" },
        provenance: { source: "backend", observed_at: 100 },
      },
      "client.text": {
        version: 1,
        state: { status: "known", value: "observed" },
        provenance: { source: "backend", observed_at: 100 },
      },
      "client.risk": {
        version: 1,
        state: { status: "unknown", reason: "provider_unavailable" },
        provenance: { source: "provider", observed_at: 100 },
      },
    },
    recent_decisions: [{ ...recentDecision, future_field: true }],
    recent_events: [{ ...recentEvent, future_field: true }],
  };
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "cli_one" });
  expect(screen.getByText("Unknown · provider unavailable")).toBeTruthy();
  expect(screen.getByRole("link", { name: "trial_requested" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Deny" })).toBeTruthy();
  expect(screen.queryByText(/Could not load this information/)).toBeNull();
});

it.each([".", "..", "%2e", "a/b?c#d&x=1+ 雪"])(
  "inspects a canonical user selector literally: %s",
  async (id) => {
    entity = { ...entity, kind: "user", id };
    rows = [{ ...original, user_id: id }];
    detail = { ...detail, relationship: { ...original, user_id: id } };
    mount(
      `/inspect/entity?${new URLSearchParams({ kind: "user", id, relationship_kind: "backend", relationship_id: "association_one", return_to: scope })}`,
    );
    await screen.findByRole("heading", { name: id, level: 1 });
    await screen.findByRole("button", { name: "Correct relationship" });
    expect(api.get).toHaveBeenCalledWith(
      `/lookup/entities?${new URLSearchParams({ kind: "user", id })}`,
    );
    expect(api.get).toHaveBeenCalledWith(
      `/lookup/entities/relationships?${new URLSearchParams({ kind: "user", id })}&limit=20`,
    );
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(scope);
  },
);
it.each(["kind=user&id=.&id=..", "kind=user&kind=client&id=."])(
  "rejects ambiguous entity selectors: %s",
  async (query) => {
    mount(`/inspect/entity?${query}`);
    await screen.findByText("Provide one entity kind and ID in the address.");
    expect(api.get).not.toHaveBeenCalled();
  },
);
it("rejects duplicate relationship source selectors without reading either source", async () => {
  mount(
    "/inspect/entity?kind=client&id=cli_one&relationship_kind=backend&relationship_id=.&relationship_id=..",
  );
  await screen.findByText(
    "Provide one relationship kind and ID in the address.",
  );
  expect(
    vi
      .mocked(api.get)
      .mock.calls.every(([path]) => !path.startsWith("/lookup/relationships?")),
  ).toBe(true);
});
