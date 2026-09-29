import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, ApiError } from "./api";
import { Settings } from "./Settings";
import { Activity } from "./Activity";
import type { Receipt } from "./types";

const event: Receipt = {
  received_at: 1000,
  basis: "retained_history",
  record: { kind: "event", id: "..", availability: "available" },
};
const retained = {
  days: 30,
  requested_days: 90,
  applying: true,
  available_since: 500,
  visibility: "asynchronous",
};
function response(check: string | null = null) {
  return {
    browser_url: "https://krine.example",
    server_url: "https://krine.example",
    allowed_origins: ["https://app.example"],
    public_key: "pk_browser",
    browser_credential_id: "cred_browser",
    active_credentials: { browser: 1, server: 1 },
    sdk: { browser_package: "@krine/browser", server_package: "@krine/server" },
    observations: {
      tracked_since: 2000,
      check,
      client_evidence: event,
      backend_event: null,
      check_attempt:
        check === null
          ? null
          : {
              received_at: 3000,
              basis: "tracked",
              record: {
                kind: "decision",
                id: `dec_${check}`,
                availability: "available",
              },
            },
    },
    history_retention: retained,
  };
}
let global: unknown;
let selected: unknown;
let credential: unknown;
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  global = response();
  selected = undefined;
  credential = undefined;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(api, "get").mockImplementation(
    async <T,>(path: string): Promise<T> => {
      if (path === "/setup") {
        if (global instanceof Error) throw global;
        return structuredClone(global) as T;
      }
      if (path.startsWith("/setup?")) {
        if (selected instanceof Error) throw selected;
        return structuredClone(
          selected === undefined
            ? response(new URLSearchParams(path.split("?")[1]).get("check"))
            : selected,
        ) as T;
      }
      if (path === "/providers") return { items: [] } as T;
      if (path.startsWith("/credentials?"))
        return {
          items: credential ? [credential] : [],
          next_cursor: null,
        } as T;
      if (path.startsWith("/activity/"))
        return { items: [], next_cursor: null, retention: retained } as T;
      throw new Error(path);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(path = "/settings") {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: <Settings /> },
      { path: "/activity", element: <Activity /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
async function refresh() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Refresh receipts" }),
  );
}
it("shows global receipts, honest upgrade coverage and no attempt for the snippet's default name", async () => {
  mount();
  const link = await screen.findByRole("link", { name: "View received event" });
  expect(link.getAttribute("href")).toBe("/inspect/event?id=..");
  expect(
    screen.getByText(/Earliest surviving receipt at upgrade/),
  ).toBeTruthy();
  expect(screen.getByText(/No receipt recorded in this coverage/)).toBeTruthy();
  expect(
    screen.getByText(/snippet’s example name does not select a check/),
  ).toBeTruthy();
  expect(
    vi.mocked(api.get).mock.calls.some(([path]) => path.includes("?check=")),
  ).toBe(false);
  const disclosure = screen.getByText("History retention", {
    selector: "summary",
  });
  expect((disclosure.parentElement as HTMLDetailsElement).open).toBe(false);
  await userEvent.click(disclosure);
  expect(screen.getByText("90 days · Applying")).toBeTruthy();
  expect(
    screen.getByText(/does not promise uninterrupted coverage/),
  ).toBeTruthy();
});
it.each(["pending", "not_retained", "unavailable"] as const)(
  "keeps the %s receipt distinct from no receipt and offers no dead record link",
  async (availability) => {
    selected = response("trial");
    (
      selected as ReturnType<typeof response>
    ).observations.check_attempt!.record.availability = availability;
    mount("/settings?check=trial");
    await screen.findByText("Check attempt", { exact: true });
    await screen.findByText(
      {
        pending: "· Evaluation pending",
        not_retained: "· Record no longer retained",
        unavailable: "· Record availability could not be confirmed",
      }[availability],
    );
    expect(
      screen.queryByRole("link", { name: "View received decision" }),
    ).toBeNull();
    expect(screen.getByText(/First receipt since tracking began/)).toBeTruthy();
  },
);
it.each([
  null,
  {},
  { ...response("wrong") },
  {
    ...response("trial"),
    observations: {
      ...response("trial").observations,
      check_attempt: {
        received_at: 3000,
        basis: "tracked",
        record: { kind: "event", id: "wrong", availability: "available" },
      },
    },
  },
])(
  "isolates malformed or mismatched attempt response %# from global receipts and credentials",
  async (invalid) => {
    selected = invalid;
    mount("/settings?check=trial");
    await screen.findByText(/Attempt receipt for trial could not be read/);
    expect(
      screen.getByRole("link", { name: "View received event" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Application credentials", { selector: "summary" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "View received decision" }),
    ).toBeNull();
  },
);
it("keeps the selected check's404 read failure explicit instead of claiming no requests", async () => {
  selected = new ApiError(404, "not_found", "Not found");
  mount("/settings?check=missing");
  await screen.findByText(/Attempt receipt for missing could not be read/);
  expect(
    screen.getByRole("link", { name: "View received event" }),
  ).toBeTruthy();
  expect(screen.queryByText("No requests received")).toBeNull();
});
it("discards an old check response after scope changes and never shows another check's receipt during loading", async () => {
  let finish!: (value: unknown) => void;
  const original = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(
    async <T,>(path: string): Promise<T> =>
      path === "/setup?check=first"
        ? ((await new Promise<unknown>((resolve) => {
            finish = resolve;
          })) as T)
        : (original(path) as Promise<T>),
  );
  const router = mount("/settings?check=first");
  await screen.findByRole("link", { name: "View received event" });
  await act(async () => router.navigate("/settings?check=second"));
  expect(
    (
      await screen.findByRole("link", { name: "View received decision" })
    ).getAttribute("href"),
  ).toBe("/activity/decisions/dec_second");
  await act(async () => finish(response("first")));
  expect(
    screen
      .getByRole("link", { name: "View received decision" })
      .getAttribute("href"),
  ).toBe("/activity/decisions/dec_second");
  await act(async () => router.navigate("/settings"));
  expect(
    screen.queryByRole("link", { name: "View received decision" }),
  ).toBeNull();
});
it("retains last good same-scope receipts after a failed refresh and labels them stale", async () => {
  mount("/settings?check=trial");
  await screen.findByRole("link", { name: "View received decision" });
  global = null;
  selected = response("another");
  await refresh();
  await screen.findByText(/Installation receipts could not be read/);
  expect(
    screen.getAllByText(/Showing the last successful receipt read/),
  ).toHaveLength(2);
  expect(
    screen
      .getByRole("link", { name: "View received decision" })
      .getAttribute("href"),
  ).toBe("/activity/decisions/dec_trial");
});
it("keeps a once-only server secret mounted through receipt faults, reauthentication and changed check scope", async () => {
  const secret = `sk_${"I".repeat(43)}`;
  vi.spyOn(api, "run").mockImplementation(async <T,>(): Promise<T> => {
    credential = {
      id: "cred_new",
      kind: "server",
      label: "Fixture",
      source: "administrator",
      public_key: null,
      created_at: 4000,
      revoked_at: null,
      revoked_by: null,
    };
    return { credential, secret, secret_status: "revealed" } as T;
  });
  const user = userEvent.setup();
  const router = mount("/settings?check=trial");
  await user.click(
    await screen.findByText("Application credentials", { selector: "summary" }),
  );
  await user.click(screen.getByRole("button", { name: "Create credential" }));
  await user.selectOptions(screen.getByLabelText("Credential type"), "server");
  await user.type(screen.getByLabelText("Label"), "Fixture");
  await user.click(
    screen.getByRole("button", { name: "Create server secret" }),
  );
  const field = (await screen.findByLabelText(
    "New server secret",
  )) as HTMLInputElement;
  const section = document.querySelector("#credentials");
  selected = new ApiError(401, "unauthorized", "Sign in again");
  global = null;
  await refresh();
  await screen.findByText(/Attempt receipt for trial could not be read/);
  expect(screen.getByLabelText("New server secret")).toBe(field);
  await act(async () => router.navigate("/settings?check=other"));
  selected = { ...response("other"), observations: null };
  await refresh();
  await screen.findByText(/Attempt receipt for other could not be read/);
  expect(document.querySelector("#credentials")).toBe(section);
  expect(field.value).toBe(secret);
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(
    secret,
  );
});
it("rejects repeated selected-check parameters without querying an arbitrary check", async () => {
  mount("/settings?check=first&check=second");
  await screen.findByText(/Choose one valid check/);
  expect(
    vi.mocked(api.get).mock.calls.some(([path]) => path.includes("?check=")),
  ).toBe(false);
});
it("shows the effective boundary in empty Activity without promising complete coverage", async () => {
  mount("/activity?entity=user&entity_kind=user&range=all");
  await screen.findByRole("heading", { name: "No matching records." });
  expect(screen.getByText(/effective history window is 30 days/)).toBeTruthy();
  expect(screen.getByText(/gaps may remain within this window/)).toBeTruthy();
  expect(
    screen.getByText(/extension to 90 days is still applying/),
  ).toBeTruthy();
});
it("rejects malformed retention independently from otherwise readable receipts", async () => {
  global = { ...response(), history_retention: { ...retained, days: "30" } };
  mount();
  await screen.findByRole("link", { name: "View received event" });
  await userEvent.click(
    screen.getByText("History retention", { selector: "summary" }),
  );
  expect(
    screen.getByText("History retention information could not be read."),
  ).toBeTruthy();
});

it("hides the previous loaded check receipt while a different scope is still loading", async () => {
  const router = mount("/settings?check=first");
  await screen.findByRole("link", { name: "View received decision" });
  let finish!: (value: unknown) => void;
  const original = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(
    async <T,>(path: string): Promise<T> =>
      path === "/setup?check=second"
        ? ((await new Promise<unknown>((resolve) => {
            finish = resolve;
          })) as T)
        : (original(path) as Promise<T>),
  );
  await act(async () => router.navigate("/settings?check=second"));
  expect(
    screen.queryByRole("link", { name: "View received decision" }),
  ).toBeNull();
  expect(
    screen.getByRole("link", { name: "View received event" }),
  ).toBeTruthy();
  await act(async () => finish(response("second")));
  expect(
    screen
      .getByRole("link", { name: "View received decision" })
      .getAttribute("href"),
  ).toBe("/activity/decisions/dec_second");
});
it("rejects a malformed receipt basis instead of coercing it into a coverage claim", async () => {
  global = {
    ...response(),
    observations: {
      ...response().observations,
      client_evidence: { ...event, basis: ["retained_history"] },
    },
  };
  mount();
  await screen.findByText(/Installation receipts could not be read/);
  expect(
    screen.queryByRole("link", { name: "View received event" }),
  ).toBeNull();
});
