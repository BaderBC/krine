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
import { Activity } from "./Activity";
import { ActivityChart, AnalyticsSummary, useAnalytics } from "./Analytics";
import { Overview, InstallationContext, EntityLookup } from "./Overview";
import { api, ApiError } from "./api";
import { validAnalytics, type ActivityAnalytics } from "./activity-analytics";
import { formWindow } from "./ActivityRange";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: { get: vi.fn() },
}));
const from = 1_790_754_516_534,
  to = 1_790_754_816_536;
const fixture: ActivityAnalytics = {
  schema_version: 1,
  scope: {
    kind: "decision",
    check: null,
    operation_id: null,
    outcome: null,
    entity: null,
    entity_kind: null,
    name: null,
    reason: null,
    provenance: null,
  },
  range: {
    from,
    to,
    time_basis: "accepted_at",
    effective_from: from,
    effective_to: to,
    bucket_ms: 300_000,
  },
  as_of: 1_790_755_116_845,
  retention: {
    days: 30,
    requested_days: 30,
    applying: false,
    available_since: 1_788_163_116_841,
  },
  visibility: "asynchronous",
  delivery: {
    scope: "installation",
    observed_at: 1_790_755_116_845,
    pending_records: 0,
    oldest_record_accepted_at: null,
  },
  totals: { total: 2, allow: 1, deny: 1, awaiting_verification: 0, unknown: 0 },
  buckets: [
    {
      from,
      to: 1_790_754_599_999,
      counts: {
        total: 1,
        allow: 0,
        deny: 1,
        awaiting_verification: 0,
        unknown: 0,
      },
    },
    {
      from: 1_790_754_600_000,
      to,
      counts: {
        total: 1,
        allow: 1,
        deny: 0,
        awaiting_verification: 0,
        unknown: 0,
      },
    },
  ],
  breakdowns: {
    checks: {
      items: [
        { value: "..", count: 1 },
        { value: "check_b", count: 1 },
      ],
      other_count: 0,
    },
    reasons: { items: [{ value: "otherwise", count: 2 }], other_count: 0 },
  },
};
function mount(element: React.ReactNode, path = "/") {
  const router = createMemoryRouter([{ path: "*", element }], {
    initialEntries: [path],
  });
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async (path) =>
    path.startsWith("/analytics/")
      ? structuredClone(fixture)
      : { items: [], next_cursor: null, retention: fixture.retention },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["event", "decision"])(
  "rejects an array %s analytics kind at both the wire boundary and hook",
  async (kind) => {
    const eventCounts = { total: 2, backend: 1, browser: 1, unknown: 0 };
    const value = {
      ...structuredClone(fixture),
      scope: { ...fixture.scope, kind: "event" },
      totals: eventCounts,
      buckets: [{ from, to, counts: eventCounts }],
      range: { ...fixture.range, bucket_ms: 3_600_000 },
      breakdowns: {
        checks: { items: [], other_count: 2 },
        reasons: { items: [], other_count: 2 },
      },
    };
    expect(validAnalytics(value)).toBe(true);
    const malformed = { ...value, scope: { ...value.scope, kind: [kind] } };
    expect(validAnalytics(malformed)).toBe(false);
    vi.mocked(api.get).mockResolvedValue(malformed);
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    function Probe() {
      const result = useAnalytics(params, "event");
      return (
        <p>
          {result.error ? "rejected" : result.data ? "rendered" : "loading"}
        </p>
      );
    }
    render(<Probe />);
    await screen.findByText("rejected");
    expect(screen.queryByText("rendered")).toBeNull();
  },
);

it("renders aggregate totals independently of the paginated list and drills into clipped inclusive intervals", async () => {
  mount(<Overview />, `/?from=${from}&to=${to}`);
  const total = await screen.findByRole("link", { name: "2" });
  expect(
    new URL(total.getAttribute("href")!, "http://krine").searchParams.get("to"),
  ).toBe(String(to));
  expect(screen.getByRole("img").textContent).toContain(
    "2 records in 2 intervals",
  );
  await userEvent.click(screen.getByText("View chart data and intervals"));
  const table = screen.getByRole("table");
  const deny = within(table).getByRole("link", { name: /Deny: 1 in interval/ });
  const query = new URL(deny.getAttribute("href")!, "http://krine")
    .searchParams;
  expect(Object.fromEntries(query)).toEqual({
    from: String(from),
    to: "1790754599999",
    view: "decisions",
    outcome: "DENY",
  });
  expect(api.get).not.toHaveBeenCalledWith(
    expect.stringContaining("/activity/decisions"),
  );
});

it("does not turn conflicting zero series into links that broaden the counted population", () => {
  const value = structuredClone(fixture);
  value.scope.outcome = "DENY";
  value.scope.entity = " ./% 雪 ";
  value.scope.entity_kind = "user";
  value.totals = {
    total: 1,
    allow: 0,
    deny: 1,
    awaiting_verification: 0,
    unknown: 0,
  };
  mount(
    <>
      <AnalyticsSummary value={value} />
      <ActivityChart value={value} />
    </>,
  );
  expect(screen.queryByRole("link", { name: "Allow" })).toBeNull();
  expect(screen.queryByRole("link", { name: "0" })).toBeNull();
  const target = new URL(
    screen.getByRole("link", { name: "Deny" }).getAttribute("href")!,
    "http://krine",
  );
  expect(target.searchParams.get("entity")).toBe(" ./% 雪 ");
  expect(target.searchParams.get("entity_kind")).toBe("user");
  expect(target.searchParams.get("outcome")).toBe("DENY");
});

it("keeps unknown outcomes descriptive and distinct from a recorded unknown-evidence reason", () => {
  const value = structuredClone(fixture);
  value.totals = {
    total: 3,
    allow: 1,
    deny: 1,
    awaiting_verification: 0,
    unknown: 1,
  };
  mount(<AnalyticsSummary value={value} />);
  expect(screen.getByText("Other / unknown")).toBeTruthy();
  for (const link of screen.getAllByRole("link"))
    expect(link.getAttribute("href")).not.toMatch(/UNKNOWN|unknown_denied/);
});

it("keeps dense charts out of the mandatory keyboard path and exposes the exact data on demand", () => {
  mount(<ActivityChart value={fixture} />);
  const disclosure = screen
    .getByText("View chart data and intervals")
    .closest("details")!;
  expect(disclosure.open).toBe(false);
  for (const link of document.querySelectorAll("svg a"))
    expect(link.getAttribute("tabindex")).toBe("-1");
  expect(disclosure.querySelector("table")).toBeTruthy();
});

it("preserves hostile user identifiers in the explicit typed lookup", async () => {
  const scope = `/activity?from=${from}&to=${to}&reason=unknown_denied&cursor=page`;
  const router = mount(
    <EntityLookup
      params={new URLSearchParams({ from: String(from), to: String(to) })}
    />,
    scope,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Exact subject identifier"),
    " ./% 雪 ",
  );
  await user.click(screen.getByRole("button", { name: "Investigate →" }));
  const query = new URLSearchParams(router.state.location.search);
  expect(query.get("kind")).toBe("user");
  expect(query.get("id")).toBe(" ./% 雪 ");
  expect(query.get("from")).toBe(String(from));
  expect(query.get("to")).toBe(String(to));
  expect(query.get("return_to")).toBe(scope);
});

it("advances both relative bounds on refresh and clears only the relative page cursor", async () => {
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const router = mount(
    <Activity />,
    `/activity?range=24&from=${now - 86_400_000}&to=${now}&cursor=old`,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Refresh activity" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  now += 60_000;
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh activity" }),
  );
  const query = new URLSearchParams(router.state.location.search);
  expect(query.get("from")).toBe(String(now - 86_400_000));
  expect(query.get("to")).toBe(String(now));
  expect(query.has("cursor")).toBe(false);
});

it("keeps an absolute interval and its page fixed when refreshed", async () => {
  const path = `/activity?from=${from}&to=${to}&cursor=page-two&outcome=DENY`;
  const router = mount(<Activity />, path);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Refresh activity" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh activity" }),
  );
  expect(router.state.location.pathname + router.state.location.search).toBe(
    path,
  );
  expect(api.get).toHaveBeenCalledWith(
    `/activity/decisions?cursor=page-two&outcome=DENY&from=${from}&to=${to}`,
  );
});

it("preserves millisecond bounds when the browser normalizes unchanged datetime input seconds", () => {
  const form = new FormData();
  form.set("range", "custom");
  form.set("range_from", "1970-01-01T00:00");
  form.set("range_to", "1970-01-01T00:00");
  expect(
    Object.fromEntries(
      formWindow(form, new URLSearchParams("from=100&to=200"), Date.now()),
    ),
  ).toEqual({ from: "100", to: "200" });
});

it("reports unavailable retained coverage without calling it zero activity", async () => {
  const value = structuredClone(fixture);
  value.totals = null;
  value.buckets = [];
  value.range.effective_from = null;
  value.range.effective_to = null;
  value.retention.available_since = to + 1;
  value.breakdowns = {};
  vi.mocked(api.get).mockResolvedValue(value);
  mount(<Overview />, `/?from=${from}&to=${to}`);
  await screen.findByText("History isn’t available for this period.");
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText("Check attempts")).toBeNull();
});

it("rejects malformed aggregate coverage and scope rather than displaying persuasive numbers", async () => {
  const value = structuredClone(fixture);
  value.scope.entity = "another-user";
  vi.mocked(api.get).mockResolvedValue(value);
  mount(<Overview />, `/?from=${from}&to=${to}`);
  await screen.findByText(/Could not load this information/);
  expect(screen.queryByRole("img")).toBeNull();
  const gap = structuredClone(fixture);
  gap.buckets[1]!.from += 1;
  expect(validAnalytics(gap)).toBe(false);
  const partial = structuredClone(fixture);
  partial.totals!.total = 3;
  expect(validAnalytics(partial)).toBe(false);
  expect(validAnalytics(fixture)).toBe(true);
});

it("keeps the last successful trend explicitly stale after a refresh failure", async () => {
  mount(<Overview />, `/?from=${from}&to=${to}`);
  await screen.findByRole("img");
  vi.mocked(api.get).mockRejectedValue(
    new ApiError(503, "unavailable", "History unavailable"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/Showing stale data. Last successful refresh/);
  expect(screen.getByRole("img").textContent).toContain("2 records");
});

it("shows sample context only from the authenticated installation marker", async () => {
  vi.mocked(api.get).mockResolvedValue({
    sample_data: {
      dataset_id: "demo",
      generator_version: "1",
      seed: "fixture",
      from,
      to,
      completed_at: to,
    },
  });
  mount(<InstallationContext />);
  await screen.findByText("Sample data");
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    `/?from=${from}&to=${to}`,
  );
  expect(api.get).toHaveBeenCalledWith("/installation");
});

it("does not label a normal installation as sample data", async () => {
  vi.mocked(api.get).mockResolvedValue({ sample_data: null });
  mount(<InstallationContext />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByText("Sample data")).toBeNull();
});

it("preserves source scope in event series without turning a conflicting zero into a broader query", () => {
  const value = structuredClone(fixture);
  value.scope.kind = "event";
  value.scope.provenance = "backend";
  value.scope.name = "account.created";
  value.totals = { total: 2, backend: 2, browser: 0, unknown: 0 };
  value.buckets = [{ from, to, counts: value.totals }];
  value.breakdowns = {};
  mount(<ActivityChart value={value} />);
  expect(screen.queryByRole("link", { name: "Client evidence" })).toBeNull();
  const query = new URL(
    screen
      .getByRole("link", { name: "Backend assertions" })
      .getAttribute("href")!,
    "http://krine",
  ).searchParams;
  expect(Object.fromEntries(query)).toEqual({
    name: "account.created",
    provenance: "backend",
    from: String(from),
    to: String(to),
    view: "events",
  });
});

it("explains an unsupported Overview interval instead of rendering a blank analytical surface", async () => {
  mount(<Overview />, `/?from=0&to=${32 * 86_400_000}`);
  await screen.findByText(
    "Choose a valid interval of up to 31 days to see this overview.",
  );
  expect(api.get).not.toHaveBeenCalled();
});

it("preserves a copied operation restriction while refining Result, and broadens only after explicit removal", async () => {
  const rows = [
    { decision_id: "denied", operation_id: "op_exact", outcome: "DENY" },
    { decision_id: "allowed_1", operation_id: "op_other_1", outcome: "ALLOW" },
    { decision_id: "allowed_2", operation_id: "op_other_2", outcome: "ALLOW" },
  ].map((row) => ({
    ...row,
    check: "can_login",
    policy_version: 1,
    accepted_at: from,
    reason: "otherwise",
    source: "evaluation",
    user_id: "user_one",
    client_id: "client_one",
    session_id: "session_one",
    reason_summary: null,
  }));
  vi.mocked(api.get).mockImplementation(async (path) => {
    const q = new URL(path, "http://krine").searchParams;
    const selected = rows.filter(
      (row) =>
        (!q.has("operation_id") ||
          q.get("operation_id") === row.operation_id) &&
        (!q.has("outcome") || q.get("outcome") === row.outcome),
    );
    if (!path.startsWith("/analytics/"))
      return {
        items: selected,
        next_cursor: null,
        retention: fixture.retention,
      };
    const value = structuredClone(fixture);
    for (const key of Object.keys(value.scope))
      if (key !== "kind") value.scope[key] = q.get(key);
    const counts = {
      total: selected.length,
      allow: selected.filter((row) => row.outcome === "ALLOW").length,
      deny: selected.filter((row) => row.outcome === "DENY").length,
      awaiting_verification: 0,
      unknown: 0,
    };
    value.totals = counts;
    value.buckets[0]!.counts = counts;
    value.buckets[1]!.counts = {
      total: 0,
      allow: 0,
      deny: 0,
      awaiting_verification: 0,
      unknown: 0,
    };
    value.breakdowns = {
      checks: {
        items: counts.total
          ? [{ value: "can_login", count: counts.total }]
          : [],
        other_count: 0,
      },
      reasons: {
        items: counts.total
          ? [{ value: "otherwise", count: counts.total }]
          : [],
        other_count: 0,
      },
    };
    return value;
  });
  const router = mount(
    <Activity />,
    `/activity?from=${from}&to=${to}&check=can_login&operation_id=op_exact&outcome=DENY`,
  );
  await screen.findByRole("link", { name: "user_one" });
  expect(
    screen.getByRole("list", { name: "Additional active filters" }).textContent,
  ).toContain("op_exact");
  await userEvent.selectOptions(screen.getByLabelText("Result"), "ALLOW");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByText("No matching records.");
  expect(
    new URLSearchParams(router.state.location.search).get("operation_id"),
  ).toBe("op_exact");
  expect(screen.getByRole("img").textContent).toContain("0 records");
  await userEvent.click(
    screen.getByRole("button", { name: "Remove Operation ID filter" }),
  );
  await waitFor(() =>
    expect(screen.getAllByRole("link", { name: "user_one" })).toHaveLength(2),
  );
  expect(
    new URLSearchParams(router.state.location.search).has("operation_id"),
  ).toBe(false);
  expect(screen.getByRole("img").textContent).toContain("2 records");
});

it("replaces only the visible search dimension and keeps other exact restrictions", async () => {
  const router = mount(
    <Activity />,
    `/activity?from=${from}&to=${to}&check=can_login&operation_id=op_exact&reason=otherwise`,
  );
  await userEvent.selectOptions(screen.getByLabelText("Find by"), "entity");
  await userEvent.clear(screen.getByRole("searchbox", { name: "Search" }));
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search" }),
    " tenant\\x41\\ ",
  );
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  const q = new URLSearchParams(router.state.location.search);
  expect(q.has("check")).toBe(false);
  expect(q.get("operation_id")).toBe("op_exact");
  expect(q.get("reason")).toBe("otherwise");
  expect(q.get("entity")).toBe(" tenant\\x41\\ ");
});

it("preserves the untyped entity restriction when refining an event source", async () => {
  const router = mount(
    <Activity />,
    `/activity?view=events&from=${from}&to=${to}&name=account.created&entity=exact_subject&provenance=backend`,
  );
  await userEvent.click(screen.getByText("More filters · active"));
  await userEvent.selectOptions(screen.getByLabelText("Source"), "browser");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  const q = new URLSearchParams(router.state.location.search);
  expect(q.get("name")).toBe("account.created");
  expect(q.get("entity")).toBe("exact_subject");
  expect(q.get("provenance")).toBe("browser");
});

it.each([
  "check",
  "operation_id",
  "outcome",
  "entity",
  "entity_kind",
  "name",
  "reason",
  "provenance",
  "from",
  "to",
  "view",
  "range",
  "cursor",
])(
  "rejects repeated %s selectors before either list or analytics requests",
  async (key) => {
    const query = new URLSearchParams({ from: String(from), to: String(to) });
    query.set(key, "first");
    query.append(key, "second");
    const router = mount(<Activity />, `/activity?${query}`);
    await screen.findByText(new RegExp(`repeats the “${key}” filter`));
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("No matching records.")).toBeNull();
    expect(
      new URLSearchParams(router.state.location.search).getAll(key),
    ).toEqual(["first", "second"]);
  },
);

it("rejects duplicate Overview selectors and offers an explicit reset without silently rewriting the address", async () => {
  const query = `?from=${from}&to=${to}&check=can_login&check=can_register`;
  const router = mount(<Overview />, `/${query}`);
  await screen.findByText(/repeats the “check” filter/);
  expect(api.get).not.toHaveBeenCalled();
  expect(router.state.location.search).toBe(query);
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(new URLSearchParams(router.state.location.search).has("check")).toBe(
    false,
  );
});

it.each([
  "unexpected=selector",
  "view=events&outcome=DENY",
  "name=login",
  "entity_kind=user",
  "range=all&from=100",
  "range=unsupported",
  "view=unknown",
  "provenance=browser",
  "outcome=unknown",
])(
  "does not run broadened queries for an unsupported or conflicting address: %s",
  async (query) => {
    mount(<Activity />, `/activity?${query}`);
    await screen.findByRole("button", { name: "Reset filters" });
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  },
);

it("rejects contradictory missing coverage and falsely clipped edges", () => {
  const missing = structuredClone(fixture);
  missing.totals = null;
  missing.buckets = [];
  missing.breakdowns = {};
  missing.range.effective_from = null;
  missing.range.effective_to = null;
  expect(validAnalytics(missing)).toBe(false);
  const clippedStart = structuredClone(fixture);
  clippedStart.range.effective_from! += 1;
  clippedStart.buckets[0]!.from += 1;
  expect(validAnalytics(clippedStart)).toBe(false);
  const clippedEnd = structuredClone(fixture);
  clippedEnd.range.effective_to! -= 1;
  clippedEnd.buckets[1]!.to -= 1;
  expect(validAnalytics(clippedEnd)).toBe(false);
  missing.retention.available_since = to + 1;
  expect(validAnalytics(missing)).toBe(true);
  missing.retention.available_since = to;
  expect(validAnalytics(missing)).toBe(false); // The inclusive final millisecond remains observable.
  missing.retention.available_since = fixture.retention.available_since;
  missing.as_of = from - 1;
  expect(validAnalytics(missing)).toBe(true);
});

it("shows an unreadable response, not history-unavailable advice, for contradictory coverage", async () => {
  const value = structuredClone(fixture);
  value.totals = null;
  value.buckets = [];
  value.breakdowns = {};
  value.range.effective_from = null;
  value.range.effective_to = null;
  vi.mocked(api.get).mockResolvedValue(value);
  mount(<Overview />, `/?from=${from}&to=${to}`);
  await screen.findByText(/Could not load this information/);
  expect(
    screen.queryByText("History isn’t available for this period."),
  ).toBeNull();
});

it("exposes the exact year and milliseconds in interval disclosure and chart table links", async () => {
  mount(<Activity />, `/activity?from=${from}&to=${to}`);
  await screen.findByRole("img");
  expect(
    screen.getByText(
      `${new Date(from).toISOString()} — ${new Date(to).toISOString()} · edit`,
    ),
  ).toBeTruthy();
  await userEvent.click(screen.getByText("View chart data and intervals"));
  const interval = `${new Date(from).toISOString()} – ${new Date(
    fixture.buckets[0]!.to,
  ).toISOString()}`;
  const link = screen.getByRole("link", { name: interval });
  const q = new URL(link.getAttribute("href")!, "http://krine").searchParams;
  expect(q.get("from")).toBe(String(from));
  expect(q.get("to")).toBe(String(fixture.buckets[0]!.to));
});
