import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Activity, DecisionPage, EventPage } from "./Activity";
import { EntityPage } from "./SubjectProfile";
import { api, ApiError } from "./api";
import { entityUrl } from "./addresses";
import {
  analytics,
  context,
  decision,
  entries,
  subject,
  timeline,
} from "./subject-profile.test-fixtures";
import type { SubjectKind, SubjectTimeline } from "./subject-profile";

const origin =
  "/activity?check=can_claim_trial&outcome=DENY&from=100&to=1000&cursor=source_page";
const address = `${entityUrl("user", subject)}&from=100&to=1000&return_to=${encodeURIComponent(origin)}`;
let contextFailure: unknown;
let historyFailure: unknown;
let records = entries();
const paths = () => vi.mocked(api.get).mock.calls.map(([path]) => path);
function mount(path = address) {
  const router = createMemoryRouter(
    [
      { path: "/inspect/entity", element: <EntityPage /> },
      { path: "/entities/:kind/:id", element: <EntityPage /> },
      { path: "/activity", element: <Activity /> },
      { path: "/activity/decisions/:id", element: <DecisionPage /> },
      { path: "/inspect/event", element: <EventPage /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  contextFailure = undefined;
  historyFailure = undefined;
  records = entries();
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(api, "get").mockImplementation(
    async <T,>(path: string): Promise<T> => {
      const q = new URLSearchParams(path.split("?")[1]);
      if (path.startsWith("/lookup/entities/context?")) {
        if (contextFailure instanceof Error) throw contextFailure;
        return (
          contextFailure === undefined
            ? context({ kind: q.get("kind")!, id: q.get("id")! })
            : contextFailure
        ) as T;
      }
      if (path.startsWith("/lookup/entities/relationships?"))
        return { items: [], next_cursor: null } as T;
      if (path.startsWith("/analytics/activity?")) return analytics(q) as T;
      if (path.startsWith("/lookup/entities/timeline?")) {
        if (historyFailure instanceof Error) throw historyFailure;
        if (historyFailure !== undefined) return historyFailure as T;
        const from = Number(q.get("from")),
          to = Number(q.get("to")),
          old = q.has("cursor");
        const value = timeline({
          scope: { kind: q.get("kind") as SubjectKind, id: q.get("id")! },
          range: {
            from,
            to,
            effective_from: from,
            effective_to: to,
            time_basis: "accepted_at",
          },
          as_of: Math.max(Date.now(), to),
          items: old
            ? []
            : records.filter(
                (item) => item.accepted_at >= from && item.accepted_at <= to,
              ),
          next_cursor: old || !records.length ? null : "older",
        });
        return value as T;
      }
      if (path.startsWith("/activity/decisions/")) return decision as T;
      if (path.startsWith("/lookup/events?")) return entries()[0]!.summary as T;
      if (path.startsWith("/activity/decisions?"))
        return { items: [decision], next_cursor: null } as T;
      throw new Error(`Unexpected ${path}`);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("subject investigation flow", () => {
  it("renders one ordered mixed stream, real session context and captured evidence without repeating the user", async () => {
    mount();
    await screen.findByRole("link", { name: "trial.requested" });
    expect(
      [...document.querySelectorAll(".subject-record .record-heading > a")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["trial.requested", "can_claim_trial", "browser.context"]);
    expect(document.querySelectorAll(".timeline-session")).toHaveLength(1);
    expect(document.querySelector(".subject-timeline")!.textContent).toContain(
      "Session session_one",
    );
    expect(
      document.querySelector(".subject-timeline")!.textContent,
    ).not.toContain(subject);
    expect(document.querySelector(".subject-timeline")!.textContent).toContain(
      "Unknown: timeout",
    );
    expect(screen.getByText("Unknown source")).toBeTruthy();
    expect(screen.getByText("Occurrence not recorded")).toBeTruthy();
    expect(screen.getByText("Sample record").getAttribute("title")).toContain(
      "synthetic-demo",
    );
    expect(
      document.querySelector(".record-time time")?.getAttribute("datetime"),
    ).toBe("1970-01-01T00:00:00.950Z");
    expect(
      document.querySelector(".record-context time")?.getAttribute("datetime"),
    ).toBe("1970-01-01T00:00:00.120Z");
    expect(
      screen.queryByRole("heading", { name: "Current metrics" }),
    ).toBeNull();
    expect(screen.getByText("user@example.test")).toBeTruthy();
  });
  it("carries an Activity spike's exact interval into the subject, discarding other filters only from the subject history", async () => {
    const user = userEvent.setup();
    const router = mount(origin);
    await user.click(await screen.findByRole("link", { name: subject.trim() }));
    await screen.findByRole("link", { name: "trial.requested" });
    const query = new URLSearchParams(router.state.location.search);
    expect(query.get("from")).toBe("100");
    expect(query.get("to")).toBe("1000");
    expect(query.has("cursor")).toBe(false);
    expect(query.get("return_to")).toBe(origin);
    const request = new URLSearchParams(
      paths()
        .find((p) => p.startsWith("/lookup/entities/timeline?"))!
        .split("?")[1],
    );
    expect(Object.fromEntries(request)).toEqual({
      kind: "user",
      id: subject,
      from: "100",
      to: "1000",
      limit: "50",
    });
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(origin);
  });
  it("preserves exact typed interval and cursor on copied record-return links and back navigation", async () => {
    const user = userEvent.setup();
    const router = mount(address);
    await user.click(
      await screen.findByRole("link", { name: "can_claim_trial" }),
    );
    const back = await screen.findByRole("link", { name: "Back to subject" });
    expect(back.getAttribute("href")).toBe(address);
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(origin);
    await user.click(back);
    await screen.findByRole("link", { name: "Older records →" });
    await user.click(screen.getByRole("link", { name: "Older records →" }));
    await screen.findByText("No older records on this page.");
    expect(
      new URLSearchParams(router.state.location.search).get("cursor"),
    ).toBe("older");
    expect(document.activeElement?.id).toBe("subject-history-heading");
    await act(() => router.navigate(-1));
    await screen.findByRole("link", { name: "trial.requested" });
    expect(
      new URLSearchParams(router.state.location.search).get("cursor"),
    ).toBeNull();
  });
  it("restores a copied profile page independently of the broader Activity origin", async () => {
    const user = userEvent.setup();
    const profile = `${address}&cursor=older`;
    mount(
      `/activity/decisions/${decision.decision_id}?subject_return=${encodeURIComponent(profile)}&return_to=${encodeURIComponent(origin)}`,
    );
    await user.click(
      await screen.findByRole("link", { name: "Back to subject" }),
    );
    await screen.findByText("No older records on this page.");
    expect(
      paths().some(
        (path) => path.includes("/timeline?") && path.endsWith("&cursor=older"),
      ),
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(origin);
  });
  it.each([
    "https://evil.example/inspect/entity?kind=user&id=x&from=1&to=2",
    "/inspect/entity?kind=user&id=x&id=y&from=1&to=2",
    "/inspect/entity?kind=user&id=x&from=1&to=2&cursor=older&cursor=newer",
  ])("ignores an unsafe or ambiguous profile return %s", async (returnTo) => {
    mount(
      `/activity/decisions/${decision.decision_id}?subject_return=${encodeURIComponent(returnTo)}`,
    );
    await screen.findByRole("heading", { name: /can_claim_trial/ });
    expect(screen.queryByRole("link", { name: "Back to subject" })).toBeNull();
  });
  it("preserves an over-broad originating interval as an explicit error instead of silently narrowing it", async () => {
    const broad = "/activity?from=0&to=5000000000&outcome=DENY";
    const user = userEvent.setup();
    mount(broad);
    await user.click(await screen.findByRole("link", { name: subject.trim() }));
    await screen.findByText(/Choose an interval of at most 31 days/);
    expect(paths().some((path) => path.includes("/timeline?"))).toBe(false);
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(broad);
    await user.click(screen.getByRole("link", { name: "Reset profile" }));
    await screen.findByRole("heading", { name: subject.trim() });
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(broad);
  });
  it("keeps related-subject navigation in the same absolute interval without expanding the user's timeline", async () => {
    mount();
    await screen.findByRole("link", { name: "trial.requested" });
    const client = screen.getByRole("link", { name: "client_one" });
    const url = new URL(client.getAttribute("href")!, "http://localhost");
    expect(url.searchParams.get("kind")).toBe("client");
    expect(url.searchParams.get("id")).toBe("client_one");
    expect(url.searchParams.get("from")).toBe("100");
    expect(url.searchParams.get("to")).toBe("1000");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(
      paths()
        .filter((p) => p.includes("/timeline?"))
        .every(
          (p) => new URLSearchParams(p.split("?")[1]).get("id") === subject,
        ),
    ).toBe(true);
  });
  it("widens deliberately, resets only the timeline page, and preserves the originating Activity link", async () => {
    const user = userEvent.setup();
    const router = mount(
      `${address}&cursor=older&relationship_kind=backend&relationship_id=assertion`,
    );
    await screen.findByText("No older records on this page.");
    await user.click(screen.getByRole("link", { name: "Widen to 30 days" }));
    await screen.findByRole("link", { name: "trial.requested" });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("from")).toBe("0");
    expect(params.get("to")).toBe("1000");
    expect(params.has("cursor")).toBe(false);
    expect(params.get("relationship_id")).toBe("assertion");
    expect(params.get("return_to")).toBe(origin);
  });
  it("refreshes an absolute older page without moving its interval or cursor", async () => {
    const user = userEvent.setup();
    const router = mount(`${address}&cursor=older`);
    await screen.findByText("No older records on this page.");
    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() =>
      expect(paths().filter((p) => p.includes("/timeline?")).length).toBe(2),
    );
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("from")).toBe("100");
    expect(params.get("to")).toBe("1000");
    expect(params.get("cursor")).toBe("older");
  });
  it("advances both relative bounds only on refresh and returns to the newest page", async () => {
    records = [];
    const user = userEvent.setup();
    const router = mount(`${address}&range=24&cursor=older`);
    await screen.findByText("No older records on this page.");
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    await screen.findByText(
      "No directly attributed activity in this interval.",
    );
    const q = new URLSearchParams(router.state.location.search);
    expect(q.get("from")).toBe(String(now - 86_400_000));
    expect(q.get("to")).toBe(String(now));
    expect(q.has("cursor")).toBe(false);
  });
  it("switches the trend without filtering or repaging mixed history", async () => {
    const user = userEvent.setup();
    const router = mount();
    await screen.findByRole("link", { name: "trial.requested" });
    const before = paths().filter((p) => p.includes("/timeline?")).length;
    await user.click(
      within(screen.getByRole("navigation", { name: "Trend" })).getByRole(
        "link",
        { name: "Events" },
      ),
    );
    await screen.findByRole("heading", { name: "Events over time" });
    expect(paths().filter((p) => p.includes("/timeline?")).length).toBe(before);
    expect(new URLSearchParams(router.state.location.search).get("trend")).toBe(
      "events",
    );
    expect(screen.getByRole("link", { name: "can_claim_trial" })).toBeTruthy();
  });
});

describe("independent and honest profile states", () => {
  it("rejects a denied decision with an array discriminator instead of relabeling it as an event", async () => {
    historyFailure = {
      ...timeline(),
      items: [{ ...entries()[1]!, kind: ["decision"] }],
      next_cursor: null,
    };
    mount();
    await screen.findByText(/Could not load this information/);
    expect(document.querySelectorAll(".subject-record")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Unnamed event" })).toBeNull();
    expect(
      screen.queryByText("No directly attributed activity in this interval."),
    ).toBeNull();
    expect(screen.getByText("user@example.test")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Relationships" })).toBeTruthy();
  });
  it("keeps history and relationships usable when durable entity context has been removed", async () => {
    contextFailure = new ApiError(404, "not_found", "missing");
    mount();
    await screen.findByRole("link", { name: "trial.requested" });
    expect(screen.getByText(/Current context is unavailable/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Relationships" })).toBeTruthy();
    expect(
      screen.queryByText("No directly attributed activity in this interval."),
    ).toBeNull();
  });
  it("keeps current facts and relationships during a history outage without inventing empty records", async () => {
    historyFailure = new ApiError(503, "unavailable", "unavailable");
    mount();
    await screen.findByText("user@example.test");
    await screen.findByText(/History could not be loaded/);
    expect(screen.getByRole("heading", { name: "Relationships" })).toBeTruthy();
    expect(
      screen.queryByText("No directly attributed activity in this interval."),
    ).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
  it("retains previously observed history with an explicit stale marker after a failed refresh", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("link", { name: "trial.requested" });
    historyFailure = new ApiError(503, "unavailable", "unavailable");
    await user.click(screen.getByRole("button", { name: "Refresh activity" }));
    await screen.findByText(/Showing stale data/);
    expect(screen.getByRole("link", { name: "trial.requested" })).toBeTruthy();
  });
  it.each(["null coverage", "wrong attribution", "wrong order"])(
    "rejects %s without hiding independent context",
    async (invalid) => {
      const value = timeline();
      if (invalid === "null coverage")
        value.range.effective_from = value.range.effective_to = null;
      if (invalid === "wrong attribution")
        value.items[0]!.summary.user_id = "other-user";
      if (invalid === "wrong order") value.items.reverse();
      historyFailure = value;
      mount();
      await screen.findByText(/Could not load this information/);
      expect(screen.getByText("user@example.test")).toBeTruthy();
      expect(
        screen.queryByRole("link", { name: "trial.requested" }),
      ).toBeNull();
    },
  );
  it("distinguishes an expired interval from successful empty direct activity", async () => {
    historyFailure = timeline({
      items: [],
      next_cursor: null,
      range: { ...timeline().range, effective_from: null, effective_to: null },
      retention: { ...timeline().retention, available_since: 1001 },
    });
    mount();
    await screen.findByText("No retained coverage for this interval.");
    cleanup();
    historyFailure = undefined;
    records = [];
    mount();
    await screen.findByText(
      "No directly attributed activity in this interval.",
    );
    expect(
      screen.queryByText("No retained coverage for this interval."),
    ).toBeNull();
  });
  it.each([
    "kind=user&id=a&id=b&from=1&to=2",
    "kind=user&id=a&from=1&to=2&from=0",
    "kind=user&id=a&from=1",
    "kind=user&id=a&from=1&to=2678400001",
    "kind=user&id=a&cursor=orphan",
    "kind=user&id=a&bogus=yes",
  ])("stops ambiguous profile requests before fetching: %s", async (query) => {
    mount(`/inspect/entity?${query}`);
    await screen.findByRole("alert");
    expect(api.get).not.toHaveBeenCalled();
  });
  it("does not flash a previous subject's data when a response arrives after navigation", async () => {
    let resolve!: (value: SubjectTimeline) => void;
    const impl = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(
      async <T,>(path: string): Promise<T> => {
        if (
          path.includes("/timeline?") &&
          new URLSearchParams(path.split("?")[1]).get("id") === subject
        )
          return (await new Promise<SubjectTimeline>((done) => {
            resolve = done;
          })) as T;
        return impl(path) as Promise<T>;
      },
    );
    const router = mount();
    await screen.findByText("user@example.test");
    await act(() =>
      router.navigate(`${entityUrl("user", "another")}&from=100&to=1000`),
    );
    await screen.findByRole("heading", { name: "another" });
    await act(() => resolve(timeline()));
    expect(screen.queryByRole("link", { name: "trial.requested" })).toBeNull();
    // A malformed response for the new subject remains an error, not old evidence.
    await screen.findByText(/Could not load this information/);
  });
});
