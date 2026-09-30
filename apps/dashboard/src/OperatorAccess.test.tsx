import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { Settings } from "./Settings";
import { Checks } from "./Checks";
import { api } from "./api";
import {
  authenticateFixture,
  methodsFixture,
  sessionFixture,
} from "./operator-test-fixtures";
import type { Operator } from "./operator";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const operator = {
  ...sessionFixture().operator!,
  id: "op_alex",
  name: "Alex Example",
  sign_in_name: "alex",
  role: "viewer" as const,
};
const secret = `ok_${"a".repeat(43)}`;
function mount(path = "/settings?view=operators", app = false) {
  const route = { path: "/settings", element: <Settings /> };
  const router = createMemoryRouter(
    app ? [{ element: <App />, children: [route] }] : [route],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
function baseRead(
  path: string,
  ops: Operator[] = [operator],
): Response | undefined {
  if (path === "/auth/methods") return json(methodsFixture);
  if (path === "/session") return json(sessionFixture());
  if (path.startsWith("/operators?"))
    return json({ items: ops, next_cursor: null });
  if (path === `/operators/${operator.id}`) return json(operator);
  if (path.includes("/sessions?"))
    return json({
      items: [
        {
          id: "os_fixture",
          created_at: 1,
          expires_at: Date.now() + 60_000,
          revoked_at: null,
          current: true,
        },
      ],
      next_cursor: null,
    });
  if (path === "/installation") return json({ sample_data: null });
  return undefined;
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("BroadcastChannel", undefined);
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.clear();
});
it.each(["viewer", "editor"] as const)(
  "%s can inspect own sessions without reading operator administration",
  async (role) => {
    authenticateFixture(api, sessionFixture(role));
    const paths: string[] = [];
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      paths.push(path);
      if (path.includes("/sessions?"))
        return { items: [], next_cursor: null } as never;
      throw Error(`Unexpected ${path}`);
    });
    mount("/settings?view=sessions");
    await screen.findByText("No sessions in this page.");
    expect(paths).toEqual(["/operators/op_fixture/sessions?limit=50"]);
    expect(screen.queryByRole("link", { name: "Operators" })).toBeNull();
  },
);
it.each(["operators", "audit"])(
  "Viewer's denied %s link makes no forbidden eager request",
  async (view) => {
    authenticateFixture(api, sessionFixture("viewer"));
    const get = vi.spyOn(api, "get");
    mount(`/settings?view=${view}`);
    expect(
      screen.getByText(/Your current role does not have access/),
    ).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  },
);
it("Viewer check list hides creation while preserving investigation", async () => {
  authenticateFixture(api, sessionFixture("viewer"));
  vi.spyOn(api, "get").mockResolvedValue({ items: [], next_cursor: null });
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: "/checks", element: <Checks /> }], {
        initialEntries: ["/checks"],
      })}
    />,
  );
  await screen.findByText("Protect an action.");
  expect(screen.queryByRole("button", { name: "Create check" })).toBeNull();
});
it("restricted recovery loads operators without customer setup, provider or history requests", async () => {
  const session = {
    ...sessionFixture(),
    operator: null,
    actor_id: "recovery:grant_one",
    authentication_method: "installation_recovery" as const,
    capabilities: ["session", "manage_operators"] as const,
    recovery_reason: "Restore access",
  };
  api.acceptSession({ ...session, capabilities: [...session.capabilities] });
  const paths: string[] = [];
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    paths.push(path);
    if (path.startsWith("/operators?"))
      return { items: [], next_cursor: null } as never;
    throw Error(path);
  });
  mount("/settings");
  await screen.findByRole("button", { name: "Add operator" });
  expect(paths).toEqual(["/operators?limit=50"]);
  expect(screen.queryByRole("link", { name: "Application" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Audit" })).toBeNull();
});
it("a lost enrollment reveal cannot trigger automatic or repeated bootstrap", async () => {
  api.clear();
  const user = userEvent.setup();
  let bootstraps = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/auth/methods")
        return json({ ...methodsFixture, bootstrap: true });
      if (path === "/session")
        return json({ error: { code: "unauthenticated" } }, 401);
      if (path === "/auth/bootstrap" && init.method === "POST") {
        bootstraps++;
        throw new TypeError("Response lost");
      }
      throw Error(path);
    }),
  );
  mount("/settings", true);
  await user.type(
    await screen.findByLabelText("Installation secret"),
    "installation_secret",
  );
  await user.type(screen.getByLabelText("Your name"), "First Admin");
  await user.type(screen.getByLabelText("Sign-in name"), "first");
  await user.click(screen.getByRole("button", { name: "Create first Admin" }));
  await screen.findByText(/Enrollment may already be complete/);
  expect(
    screen.queryByRole("button", { name: "Create first Admin" }),
  ).toBeNull();
  expect(bootstraps).toBe(1);
  expect(sessionStorage.length).toBe(0);
});
it("bootstrap keeps its credential until deliberate save acknowledgement", async () => {
  api.clear();
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/auth/methods")
        return json({ ...methodsFixture, bootstrap: true });
      if (path === "/session")
        return json({ error: { code: "unauthenticated" } }, 401);
      if (path === "/auth/bootstrap")
        return json({
          operator: sessionFixture().operator,
          credential: secret,
          secret_status: "revealed",
        });
      throw Error(path);
    }),
  );
  mount("/settings", true);
  await user.type(
    await screen.findByLabelText("Installation secret"),
    "installation_secret",
  );
  await user.type(screen.getByLabelText("Your name"), "Fixture Operator");
  await user.type(screen.getByLabelText("Sign-in name"), "fixture");
  await user.click(screen.getByRole("button", { name: "Create first Admin" }));
  expect(
    ((await screen.findByLabelText("Sign-in credential")) as HTMLInputElement)
      .value,
  ).toBe(secret);
  expect(sessionStorage.length).toBe(0);
  await user.click(
    screen.getByRole("button", { name: "I saved the credential" }),
  );
  await screen.findByRole("heading", { name: "Sign in to Krine." });
  expect(
    (screen.getByLabelText("Sign-in credential") as HTMLInputElement).value,
  ).toBe("");
});
it("operator creation preserves its revealed credential when the following list refresh is malformed", async () => {
  const user = userEvent.setup();
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/operators" && init.method === "POST") {
        created = true;
        return json({
          operator,
          credential: secret,
          secret_status: "revealed",
        });
      }
      if (path.startsWith("/operators?"))
        return json(created ? null : { items: [], next_cursor: null });
      throw Error(path);
    }),
  );
  mount();
  await user.click(screen.getByRole("button", { name: "Add operator" }));
  await user.type(screen.getByLabelText("Name"), "Alex Example");
  await user.type(screen.getByLabelText("Sign-in name"), "alex");
  await user.type(screen.getByLabelText("Reason"), "Support investigation");
  await user.click(screen.getByRole("button", { name: "Create operator" }));
  expect(
    ((await screen.findByLabelText("Sign-in credential")) as HTMLInputElement)
      .value,
  ).toBe(secret);
  await screen.findByText(/Could not load this information/);
  expect(
    (screen.getByLabelText("Sign-in credential") as HTMLInputElement).value,
  ).toBe(secret);
  expect(
    Array.from({ length: sessionStorage.length }, (_, i) =>
      sessionStorage.getItem(sessionStorage.key(i)!),
    ).join(""),
  ).not.toContain(secret);
});
it("lost operator reveal retries its original intent and reports unrecoverability", async () => {
  const user = userEvent.setup();
  const writes: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/operators" && init.method === "POST") {
        writes.push(init);
        if (writes.length === 1) throw TypeError("Lost");
        return json({
          operator,
          credential: null,
          secret_status: "unrecoverable",
        });
      }
      return baseRead(path) ?? json(null);
    }),
  );
  mount();
  await user.click(screen.getByRole("button", { name: "Add operator" }));
  await user.type(screen.getByLabelText("Name"), "Alex Example");
  await user.type(screen.getByLabelText("Sign-in name"), "alex");
  await user.type(screen.getByLabelText("Reason"), "Support investigation");
  await user.click(screen.getByRole("button", { name: "Create operator" }));
  await user.click(
    await screen.findByRole("button", { name: "Retry same operator request" }),
  );
  await screen.findByRole("heading", {
    name: "The credential cannot be shown again.",
  });
  expect(writes).toHaveLength(2);
  expect(writes[1]!.body).toBe(writes[0]!.body);
  expect(writes[1]!.headers).toEqual(writes[0]!.headers);
  expect(screen.queryByLabelText("Sign-in credential")).toBeNull();
});
it("last-Admin conflict stays actionable and is never presented as disabled access", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (init.method === "PUT")
        return json(
          { error: { code: "last_admin", message: "last admin" } },
          409,
        );
      return baseRead(path) ?? json(null);
    }),
  );
  mount("/settings?view=operators&operator=op_alex");
  await user.click(await screen.findByRole("button", { name: "Edit access" }));
  await user.selectOptions(screen.getByLabelText("Access"), "disabled");
  await user.type(screen.getByLabelText("Reason"), "Offboard access");
  await user.click(screen.getByRole("button", { name: "Apply access change" }));
  await screen.findByText(/This is the last active Admin/);
  expect(screen.queryByText("Operator access updated.")).toBeNull();
  expect(screen.getByText(/viewer · active · Revision 1/)).toBeTruthy();
});
it("confirmed disable dominates a delayed older operator list", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (init.method === "PUT")
        return json({ ...operator, state: "disabled", revision: 2 });
      return baseRead(path) ?? json(null);
    }),
  );
  mount("/settings?view=operators&operator=op_alex");
  await user.click(await screen.findByRole("button", { name: "Edit access" }));
  await user.selectOptions(screen.getByLabelText("Access"), "disabled");
  await user.type(screen.getByLabelText("Reason"), "Offboard access");
  await user.click(screen.getByRole("button", { name: "Apply access change" }));
  await screen.findByText("Operator access updated.");
  expect(screen.getByText(/viewer · disabled · Revision 2/)).toBeTruthy();
  const row = screen
    .getByRole("button", { name: "Alex Example" })
    .closest("tr")!;
  expect(within(row).getByText("disabled")).toBeTruthy();
});
it("actor change unmounts the old view and removes the credential reveal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        baseRead(url.replace("/v1/admin", "")) ?? json(null),
    ),
  );
  mount("/settings?view=operators", true);
  await screen.findByRole("button", { name: "Add operator" });
  act(() =>
    api.revealCredential({
      operator,
      credential: secret,
      secret_status: "revealed",
    }),
  );
  await screen.findByLabelText("Sign-in credential");
  act(() => api.acceptSession(sessionFixture("viewer", "op_other")));
  await screen.findByText(/Your current role does not have access/);
  expect(screen.queryByLabelText("Sign-in credential")).toBeNull();
  expect(api.revealedCredential).toBeNull();
});
it("self-rotation reveal remains saveable when its session ends", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        baseRead(url.replace("/v1/admin", "")) ?? json(null),
    ),
  );
  mount("/settings?view=operators", true);
  await screen.findByRole("button", { name: "Add operator" });
  act(() => {
    api.revealCredential({
      operator: sessionFixture().operator!,
      credential: secret,
      secret_status: "revealed",
    });
    api.suspend();
  });
  const dialog = await screen.findByRole("dialog");
  expect(
    (within(dialog).getByLabelText("Sign-in credential") as HTMLInputElement)
      .value,
  ).toBe(secret);
  await userEvent
    .setup()
    .click(
      within(dialog).getByRole("button", { name: "I saved the credential" }),
    );
  await within(dialog).findByRole("heading", { name: "Sign in again." });
  expect(api.revealedCredential).toBeNull();
});
it("audit displays coverage and safe changes without raw secret-bearing fields", async () => {
  vi.spyOn(api, "get").mockResolvedValue({
    items: [
      {
        id: "audit_one",
        at: 2,
        actor: { id: "op_alex", type: "operator", name: "Alex Example" },
        action: "operator.update",
        resource: { type: "operator", id: "op_alex" },
        reason: "Offboard access",
        changes: {
          state: "disabled",
          previous_state: "active",
          secret: "must_not_render",
          request: { credential: "must_not_render" },
        },
      },
    ],
    next_cursor: null,
    coverage: { days: 365, started_at: 1, available_since: 1 },
  });
  mount("/settings?view=audit");
  await screen.findByText("Offboard access");
  expect(screen.getByText(/Retained for 365 days/)).toBeTruthy();
  expect(screen.queryByText(/must_not_render/)).toBeNull();
  expect(
    screen.getByRole("link", { name: "op_alex" }).getAttribute("href"),
  ).toBe("/settings?view=operators&operator=op_alex");
});
it("malformed audit actor authority is rejected before rendering", async () => {
  vi.spyOn(api, "get").mockResolvedValue({
    items: [
      {
        id: "a",
        at: 2,
        actor: { id: "op_alex", type: ["operator"], name: "Wrong actor" },
        action: "operator.update",
        resource: { type: "operator", id: "op_alex" },
        reason: null,
        changes: {},
      },
    ],
    next_cursor: null,
    coverage: { days: 365, started_at: 1, available_since: 1 },
  });
  mount("/settings?view=audit");
  await screen.findByText(/Could not load this information/);
  expect(screen.queryByText("Wrong actor")).toBeNull();
});

it.each([
  ["operator.bootstrap", { role: "admin", state: "active" }],
  ["access.configuration", { local_enabled: false }],
  ["recovery.arm", {}],
  ["retention.configure", { previous_days: 30, days: 60 }],
])(
  "renders host %s audit without attributing it to a human",
  async (action, changes) => {
    vi.spyOn(api, "get").mockResolvedValue({
      items: [
        {
          id: "audit_host",
          at: 2,
          actor: {
            id: "installation_configuration",
            type: "installation_configuration",
            name: "Installation configuration",
          },
          action,
          resource: { type: "installation", id: "install_fixture" },
          reason: "Host maintenance",
          changes,
        },
      ],
      next_cursor: null,
      coverage: { days: 365, started_at: 1, available_since: 1 },
    });
    mount("/settings?view=audit");
    await screen.findByText("Host maintenance");
    expect(screen.getByText(/Host configuration/)).toBeTruthy();
    if (action === "access.configuration") {
      expect(screen.getByText("local enabled")).toBeTruthy();
      expect(screen.getByText("false")).toBeTruthy();
    }
    if (action === "retention.configure") {
      expect(screen.getByText("previous days")).toBeTruthy();
      expect(screen.getByText("60")).toBeTruthy();
    }
  },
);
it("requires the app sign-out confirmation and clears the old authority after success", async () => {
  const user = userEvent.setup();
  let revoked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/session" && init.method === "DELETE") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return baseRead(path) ?? json(null);
    }),
  );
  mount("/settings?view=sessions", true);
  await screen.findByRole("heading", { name: "Your sessions" });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  const dialog = screen.getByRole("dialog", { name: "Sign out?" });
  expect(revoked).toBe(false);
  await user.click(
    within(dialog).getByRole("button", { name: "Confirm sign out" }),
  );
  await screen.findByRole("heading", { name: "Sign in to Krine." });
  expect(revoked).toBe(true);
  expect(api.current).toBeNull();
});
it("restricted recovery expires into a new-grant prompt without automatically redeeming another token", async () => {
  const recovery = {
    ...sessionFixture(),
    operator: null,
    actor_id: "recovery:grant_one",
    authentication_method: "installation_recovery",
    capabilities: ["session", "manage_operators"],
    recovery_reason: "Repair access",
    expires_at: Date.now() - 1,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/session") return json(recovery);
      return baseRead(path) ?? json(null);
    }),
  );
  mount("/settings?view=operators", true);
  await screen.findByRole("heading", { name: "Recovery session ended." });
  expect(
    screen.queryByRole("button", { name: "Start restricted recovery" }),
  ).toBeNull();
});
