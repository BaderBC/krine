import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, ApiError } from "./api";
import { Activity, DecisionPage, EventPage } from "./Activity";
import { MetricPage, Metrics } from "./Metrics";
import { CheckPage, Checks } from "./Checks";
import { Settings } from "./Settings";
import { Time } from "./shared";
import type { DecisionDetail, Metric, Policy } from "./types";

const policy: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [
    {
      id: "risk",
      condition: {
        op: "compare",
        left: { source: "metric", name: "ip.risk", version: 1 },
        comparison: "gt",
        value: 0.8,
      },
      then: "DENY",
      on_unknown: "DENY",
    },
  ],
  otherwise: "ALLOW",
};
const metric: Metric = {
  name: "ip.risk",
  version: 1,
  kind: "primitive",
  value_type: "number",
  range: [0, 1],
  description: "Normalized risk",
  dependencies: [],
  source: "ip_intelligence",
  missing: "Unknown on provider timeout",
  examples: [],
};
const decision: DecisionDetail = {
  decision_id: "dec_1",
  operation_id: "operation_1",
  check: "can_claim",
  policy_version: 1,
  outcome: "DENY",
  reason: "unknown_denied",
  accepted_at: 1800000000123,
  completed_at: 1800000000124,
  client_id: "client_1",
  user_id: null,
  session_id: "session_1",
  ip: "127.0.0.1",
  source: "evaluation",
  policy,
  snapshot: {
    inputs: {},
    metrics: {
      "ip.risk": {
        version: 1,
        state: { status: "unknown", reason: "timeout" },
        provenance: { source: "ip_intelligence", observed_at: 1800000000122 },
      },
    },
  },
  evaluation: {
    outcome: "DENY",
    reason: "unknown_denied",
    rule_id: "risk",
    trace: [
      {
        rule_id: "risk",
        route: "deny",
        condition: {
          result: "unknown",
          reference: { source: "metric", name: "ip.risk", version: 1 },
          observed: { status: "unknown", reason: "timeout" },
        },
      },
    ],
  },
};
const event = {
  event_id: "event_1",
  name: "login",
  accepted_at: 1800000000123,
  occurred_at: 1800000000001,
  provenance: "backend",
  client_id: "client_1",
  properties: {},
};
const scope =
  "/activity?check=can_claim&outcome=DENY&from=100&to=200&cursor=page_two";
function mount(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/activity", element: <Activity /> },
      { path: "/activity/decisions/:id", element: <DecisionPage /> },
      { path: "/activity/events/:id", element: <EventPage /> },
      { path: "/metrics/:name", element: <MetricPage /> },
      { path: "/metrics", element: <Metrics /> },
      { path: "/checks/:name", element: <CheckPage /> },
      { path: "/checks", element: <Checks /> },
      { path: "/settings", element: <Settings /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(api, "get").mockImplementation(
    async <T,>(path: string): Promise<T> => {
      if (path.startsWith("/activity/decisions?"))
        return { items: [decision], next_cursor: null } as T;
      if (path.startsWith("/activity/decisions/")) return decision as T;
      if (path.startsWith("/activity/events?"))
        return { items: [event], next_cursor: null } as T;
      if (path.startsWith("/activity/events/")) return event as T;
      if (path.startsWith("/metrics/")) return metric as T;
      if (path.startsWith("/metrics?"))
        return { items: [metric], next_cursor: null } as T;
      throw new Error(`Unexpected ${path}`);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("investigation context", () => {
  it("returns from decision and metric inspection to the exact filtered page and position", async () => {
    const user = userEvent.setup();
    const router = mount(scope);
    await screen.findByRole("link", { name: "Deny" });
    vi.spyOn(window, "scrollY", "get").mockReturnValue(418);
    await user.click(screen.getByRole("link", { name: "Deny" }));
    const back = await screen.findByRole("link", { name: "Back to Activity" });
    expect(back.getAttribute("href")).toBe(scope);
    const trace = document.querySelector<HTMLDetailsElement>("#policy-path")!;
    expect(trace.open).toBe(false);
    expect(
      document.querySelector('[aria-label="Decisive captured evidence"]')!
        .textContent,
    ).toContain("Unknown: timeout");
    await user.click(
      screen.getByText("Evidence captured for this decision", {
        selector: "summary",
      }),
    );
    await user.click(screen.getByRole("link", { name: "ip.risk v1" }));
    expect(
      (
        await screen.findByRole("link", { name: "Back to Activity" })
      ).getAttribute("href"),
    ).toBe(scope);
    await user.click(screen.getByRole("link", { name: "Back to Activity" }));
    await screen.findByRole("link", { name: "Deny" });
    expect(router.state.location.pathname + router.state.location.search).toBe(
      scope,
    );
    expect(window.scrollTo).toHaveBeenLastCalledWith({
      top: 418,
      behavior: "instant",
    });
  });
  it("keeps event filters and cursor in its return link", async () => {
    const user = userEvent.setup();
    const scope =
      "/activity?view=events&name=login&entity=client_1&range=all&cursor=event_page";
    mount(scope);
    await user.click(await screen.findByRole("link", { name: "login" }));
    expect(
      (
        await screen.findByRole("link", { name: "Back to Activity · Events" })
      ).getAttribute("href"),
    ).toBe(scope);
  });
  it("does not accept an external return destination", async () => {
    mount(
      "/activity/decisions/dec_1?return_to=https%3A%2F%2Fevil.example%2Factivity",
    );
    expect(
      (
        await screen.findByRole("link", { name: "Back to Activity" })
      ).getAttribute("href"),
    ).toBe("/activity");
  });
});

describe("honest resource state", () => {
  it.each([
    "/checks/missing",
    "/checks",
    "/activity",
    "/activity/decisions/missing",
    "/activity/events/missing",
    "/metrics",
    "/metrics/missing",
    "/settings",
  ])("stops announcing loading after %s fails", async (path) => {
    vi.mocked(api.get).mockRejectedValue(
      new ApiError(404, "not_found", "The resource does not exist."),
    );
    mount(path);
    await screen.findAllByText("The resource does not exist.");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });
  it("retains rows with an explicit stale marker and last successful refresh after a failed refresh", async () => {
    const user = userEvent.setup();
    mount(scope);
    await screen.findByRole("link", { name: "Deny" });
    vi.mocked(api.get).mockRejectedValue(
      new ApiError(503, "unavailable", "History unavailable"),
    );
    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    await screen.findByText(/Showing stale data. Last successful refresh/);
    expect(screen.getByRole("link", { name: "Deny" })).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
  it("shows saved unpublished draft changes in the list and active policy", async () => {
    const check = {
      name: "can_claim",
      description: "",
      active_version: 1,
      draft_revision: 2,
      draft: { ...policy, otherwise: "DENY" },
      has_draft_changes: true,
      updated_at: 1800000000123,
      recent: null,
    };
    vi.mocked(api.get).mockImplementation(
      async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/metrics"))
          return { items: [metric], next_cursor: null } as T;
        if (path === "/checks?")
          return { items: [check], next_cursor: null } as T;
        if (path.includes("/versions?"))
          return {
            items: [{ version: 1, published_at: 1, policy }],
            next_cursor: null,
          } as T;
        if (path.includes("/versions/"))
          return { version: 1, published_at: 1, policy } as T;
        return check as T;
      },
    );
    const user = userEvent.setup();
    mount("/checks");
    await screen.findByText("· Draft");
    await user.click(screen.getByRole("link", { name: "can_claim" }));
    await screen.findByText(/Unpublished draft changes/);
  });
});

it("exposes an exact UTC timestamp to keyboard and assistive technology", () => {
  render(<Time at={1800000000123} />);
  const time = document.querySelector("time")!;
  expect(time.getAttribute("datetime")).toBe("2027-01-15T08:00:00.123Z");
  expect(time.getAttribute("title")).toBe("2027-01-15T08:00:00.123Z (UTC)");
  expect(time.getAttribute("aria-label")).toContain(".123Z (UTC)");
  expect(time.tabIndex).toBe(0);
  time.focus();
  expect(document.activeElement).toBe(time);
});
