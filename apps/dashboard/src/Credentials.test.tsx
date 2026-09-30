import { operatorStorage } from "./operator-test-fixtures";
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
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, ApiError } from "./api";
import type { Mutation } from "./api";
import { Settings } from "./Settings";
import type { Credential, Setup } from "./types";

const initial: Credential = {
  id: "cred_initial",
  kind: "browser",
  label: "Initial browser key",
  source: "bootstrap",
  public_key: "pk_public",
  created_at: 1,
  revoked_at: null,
  revoked_by: null,
};
let records: Credential[];
let setup: Setup;
const secret = `sk_${"S".repeat(43)}`;
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  records = [structuredClone(initial)];
  setup = {
    browser_url: "https://krine.example",
    server_url: "https://krine.example",
    public_key: initial.public_key,
    browser_credential_id: initial.id,
    active_credentials: { browser: 1, server: 0 },
    allowed_origins: ["https://app.example"],
    sdk: { browser_package: "@krine/browser", server_package: "@krine/server" },
  };
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
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
      if (path === "/setup" || path.startsWith("/setup?"))
        return {
          ...structuredClone(setup),
          observations: {
            tracked_since: 1,
            check: new URLSearchParams(path.split("?")[1]).get("check"),
            client_evidence: null,
            backend_event: null,
            check_attempt: null,
          },
          history_retention: {
            days: 30,
            requested_days: 30,
            applying: false,
            available_since: 0,
          },
        } as T;
      if (path === "/providers") return { items: [] } as T;
      if (path.startsWith("/credentials?"))
        return { items: structuredClone(records), next_cursor: null } as T;
      throw new Error(`Unexpected ${path}`);
    },
  );
  vi.spyOn(api, "run").mockImplementation(
    async <T,>(operation: Mutation): Promise<T> => {
      if (operation.path === "/credentials") {
        const body = operation.body as {
          kind: Credential["kind"];
          label: string;
        };
        const credential = {
          ...initial,
          ...body,
          id: "cred_created",
          source: "administrator" as const,
          public_key: body.kind === "browser" ? "pk_created" : null,
          created_at: 2,
        };
        records.unshift(credential);
        setup.active_credentials[body.kind]++;
        if (body.kind === "browser" && !setup.public_key) {
          setup.public_key = credential.public_key;
          setup.browser_credential_id = credential.id;
        }
        return {
          credential,
          secret: body.kind === "server" ? secret : null,
          secret_status: body.kind === "server" ? "revealed" : "not_applicable",
        } as T;
      }
      const record = records.find(
        (item) => operation.path === `/credentials/${item.id}/revocations`,
      )!;
      record.revoked_at = 3;
      record.revoked_by = "administrator";
      setup.active_credentials[record.kind]--;
      if (record.id === setup.browser_credential_id) {
        setup.public_key = null;
        setup.browser_credential_id = null;
      }
      return structuredClone(record) as T;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(path = "/settings?check=can_claim") {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: <Settings /> },
      { path: "/checks/:name", element: <h1>Check</h1> },
      { path: "/inspect/check", element: <h1>Check</h1> },
    ],
    { initialEntries: [path] },
  );
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return router;
}
async function open() {
  await screen.findByText("Application credentials");
  await userEvent.click(
    screen.getByText("Application credentials", { selector: "summary" }),
  );
}
async function createServer() {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole("button", { name: "Create credential" }));
  await user.selectOptions(screen.getByLabelText("Credential type"), "server");
  await user.type(screen.getByLabelText("Label"), "Application");
  await user.click(
    screen.getByRole("button", { name: "Create server secret" }),
  );
  return user;
}

describe("application credential interface", () => {
  it("shows the new secret once, offers copying, keeps it out of browser storage and snippets, and warns before leaving", async () => {
    const router = mount();
    const user = await createServer();
    const field = (await screen.findByLabelText(
      "New server secret",
    )) as HTMLInputElement;
    expect(field.value).toBe(secret);
    expect(document.querySelector("pre")?.textContent).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    await user.click(
      screen.getByRole("link", { name: "Back to check · can_claim" }),
    );
    await screen.findByText("Leave without this server secret?");
    expect(router.state.location.pathname).toBe("/settings");
    await user.click(
      screen.getByRole("button", { name: "Stay with configuration" }),
    );
    await user.click(
      screen.getByRole("button", { name: "I have saved the secret" }),
    );
    expect(screen.queryByLabelText("New server secret")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);
    await user.click(
      screen.getByRole("link", { name: "Back to check · can_claim" }),
    );
    await screen.findByRole("heading", { name: "Check" });
  });
  it("recovers a lost server-secret response without creating a second credential", async () => {
    const original = vi.mocked(api.run).getMockImplementation()!;
    let result: unknown;
    vi.mocked(api.run).mockImplementationOnce(async (op) => {
      result = await original(op);
      throw new ApiError(0, "lost", "lost");
    });
    mount();
    const user = await createServer();
    await screen.findByRole("button", { name: "Retry same request" });
    const intent = vi.mocked(api.run).mock.calls[0]![0];
    vi.mocked(api.run).mockResolvedValueOnce({
      ...(result as object),
      secret: null,
      secret_status: "unrecoverable",
    });
    await user.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    await screen.findByText(
      /The credential was created, but its secret cannot be recovered/,
    );
    expect(records.filter((item) => item.kind === "server")).toHaveLength(1);
    expect(vi.mocked(api.run).mock.calls[1]![0]).toEqual(intent);
    await user.click(
      within(
        screen.getByRole("region", { name: "Credential result" }),
      ).getByRole("button", { name: "Review revocation" }),
    );
    const review = screen.getByRole("region", {
      name: "Revoke credential review",
    });
    expect(review.textContent).toContain("cred_created");
    expect(review.textContent).toContain("cannot be undone");
    await user.click(
      within(review).getByRole("button", { name: "Revoke credential" }),
    );
    await screen.findByRole("heading", { name: "Credential revoked" });
    expect(records[0]!.revoked_at).toBe(3);
  });
  it("reviews exact credential identity before revocation and reconciles null setup afterward", async () => {
    mount();
    await open();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Review revocation for Initial browser key",
      }),
    );
    expect(api.run).not.toHaveBeenCalled();
    expect(screen.getByText(/last active browser key/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revoke credential" }));
    await screen.findByRole("heading", { name: "Credential revoked" });
    await waitFor(() =>
      expect(
        screen.getByText("No active browser key", { selector: "dd" }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(/Create a browser key in Application credentials/),
    ).toBeTruthy();
    expect(
      document.querySelector("#integration-reference")!.textContent,
    ).not.toContain("publicKey: null");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(
      screen.getByRole("button", { name: "Create browser key" }),
    ).toBeTruthy();
  });
  it("validates byte-bounded labels and focuses the field before dispatch", async () => {
    mount();
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(screen.getByLabelText("Label"), "é".repeat(65));
    await user.click(
      screen.getByRole("button", { name: "Create browser key" }),
    );
    expect(screen.getByRole("alert").textContent).toContain("1–128 bytes");
    expect(document.activeElement).toBe(screen.getByLabelText("Label"));
    expect(api.run).not.toHaveBeenCalled();
  });
  it("keeps pending creation recoverable through navigation and reload, without a second router blocker", async () => {
    vi.mocked(api.run).mockRejectedValue(
      new ApiError(503, "unavailable", "unavailable"),
    );
    const warning = vi.spyOn(console, "warn");
    const router = mount();
    const user = await createServer();
    await screen.findByRole("button", { name: "Retry same request" });
    const intent = vi.mocked(api.run).mock.calls[0]![0];
    await user.click(
      screen.getByRole("link", { name: "Back to check · can_claim" }),
    );
    await screen.findByText("A credential request is unconfirmed.");
    expect(router.state.location.pathname).toBe("/settings");
    expect(
      screen.queryByRole("button", { name: "Discard and leave" }),
    ).toBeNull();
    cleanup();
    mount();
    await screen.findByRole("button", { name: "Retry same request" });
    await user.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    expect(vi.mocked(api.run).mock.calls[1]![0]).toEqual(intent);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("one blocker");
  });
  it("keeps stale list data visible with a retry after a refresh fails", async () => {
    mount();
    await open();
    await screen.findByText("Initial browser key", { selector: "strong" });
    vi.mocked(api.get).mockImplementation(async <T,>(path: string) => {
      if (path === "/setup") return setup as T;
      throw new ApiError(503, "unavailable", "unavailable");
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh credentials" }),
    );
    await screen.findByText(/Showing stale data/);
    expect(
      screen.getByText("Initial browser key", { selector: "strong" }),
    ).toBeTruthy();
  });
  it("stores search and pagination in the URL without dropping the check return context", async () => {
    const original = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async <T,>(path: string) =>
      path.startsWith("/credentials?")
        ? ({
            items: [initial],
            next_cursor: path.includes("cursor") ? null : "page_2",
          } as T)
        : (original(path) as Promise<T>),
    );
    const router = mount();
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search labels"), "Initial");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(
      await screen.findByRole("button", { name: "Next page →" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toContain(
        "credential_cursor=page_2",
      ),
    );
    expect(router.state.location.search).toContain("check=can_claim");
    expect(router.state.location.search).toContain("credential_q=Initial");
    await user.click(await screen.findByRole("button", { name: "First page" }));
    expect(router.state.location.search).not.toContain("credential_cursor");
  });
  it("does not revoke a key that a refreshed list already reports as revoked", async () => {
    mount();
    await open();
    records[0]!.revoked_at = 4;
    records[0]!.revoked_by = "administrator";
    await userEvent.click(
      screen.getByRole("button", {
        name: "Review revocation for Initial browser key",
      }),
    );
    await screen.findByText("This credential is already revoked.");
    expect(
      screen.queryByRole("button", { name: "Revoke credential" }),
    ).toBeNull();
    expect(api.run).not.toHaveBeenCalled();
  });
  it("makes a null initial browser key actionable and refreshes the connection example after creation", async () => {
    setup.public_key = null;
    setup.browser_credential_id = null;
    setup.active_credentials.browser = 0;
    records = [];
    mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Create browser key" }),
    );
    await user.type(screen.getByLabelText("Label"), "Website");
    await user.click(
      screen.getByRole("button", { name: "Create browser key" }),
    );
    await screen.findByRole("heading", { name: "Credential created" });
    await waitFor(() =>
      expect(
        document.querySelector("#integration-reference")!.textContent,
      ).toContain('publicKey: "pk_created"'),
    );
  });
  it.each(["http://localhost:8080", "https://krine.example"])(
    "renders a usable SDK transport configuration for %s",
    async (url) => {
      setup.browser_url = url;
      setup.server_url = url;
      mount();
      await screen.findByText("SDK integration reference");
      const code = [...document.querySelectorAll("pre")]
        .map((node) => node.textContent)
        .join("\n");
      expect(code.match(/allowInsecureHttp: true/g)?.length ?? 0).toBe(
        url.startsWith("http:") ? 2 : 0,
      );
      expect(code).toContain(
        "interaction: { proof: request.proof, check: request.check, ip: request.ip }",
      );
    },
  );
});

it.each([null, {}, { items: [null], next_cursor: null }])(
  "reports a malformed credential list without crashing %#",
  async (body) => {
    const original = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async <T,>(path: string) =>
      path.startsWith("/credentials?")
        ? (body as T)
        : (original(path) as Promise<T>),
    );
    mount();
    await open();
    await screen.findByText(
      "Krine returned an unreadable credential list. Retry to refresh it.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  },
);

it("reports copy failure and focuses the selectable secret without losing it", async () => {
  mount();
  const user = await createServer();
  const field = (await screen.findByLabelText(
    "New server secret",
  )) as HTMLInputElement;
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"));
  await user.click(screen.getByRole("button", { name: "Copy secret" }));
  await screen.findByText(
    "Copy was unavailable. Select and copy the secret field.",
  );
  expect(clipboard).toHaveBeenCalledWith(secret);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe(secret);
});

it.each([null, { browser_url: "https://krine.example" }])(
  "keeps a newly revealed secret and its mounted form after malformed setup refresh %#",
  async (invalid) => {
    const original = vi.mocked(api.get).getMockImplementation()!;
    let failRefresh = true;
    vi.mocked(api.get).mockImplementation(
      async <T,>(path: string): Promise<T> => {
        if (
          path === "/setup" &&
          failRefresh &&
          records.some((item) => item.kind === "server")
        )
          return invalid as T;
        return original(path) as Promise<T>;
      },
    );
    mount();
    const section = (
      await screen.findByText("Application credentials", {
        selector: "summary",
      })
    ).closest("details");
    const user = await createServer();
    await screen.findByText(/Showing stale data/);
    const field = screen.getByLabelText(
      "New server secret",
    ) as HTMLInputElement;
    expect(field.value).toBe(secret);
    expect(field.closest("details")).toBe(section);
    expect(sessionStorage.length).toBe(0);
    expect(document.querySelector("pre")?.textContent).not.toContain(secret);
    failRefresh = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText(/Showing stale data/)).toBeNull(),
    );
    expect(screen.getByLabelText("New server secret")).toBe(field);
    expect(field.value).toBe(secret);
    await user.click(
      screen.getByRole("button", { name: "I have saved the secret" }),
    );
    expect(screen.queryByLabelText("New server secret")).toBeNull();
  },
);

it.each([null, { allowed_origins: null, active_credentials: false }])(
  "keeps an ambiguous credential intent mounted through malformed setup refresh %#",
  async (invalid) => {
    const original = vi.mocked(api.get).getMockImplementation()!;
    let failRefresh = false;
    vi.mocked(api.get).mockImplementation(
      async <T,>(path: string): Promise<T> =>
        path === "/setup" && failRefresh
          ? (invalid as T)
          : (original(path) as Promise<T>),
    );
    vi.mocked(api.run).mockRejectedValueOnce(new ApiError(0, "lost", "lost"));
    mount();
    const user = await createServer();
    const retry = await screen.findByRole("button", {
      name: "Retry same request",
    });
    const section = retry.closest("details");
    const intent = vi.mocked(api.run).mock.calls[0]![0];
    failRefresh = true;
    await user.click(
      screen.getByRole("button", { name: "Refresh credentials" }),
    );
    await screen.findByText(/Showing stale data/);
    expect(screen.getByRole("button", { name: "Retry same request" })).toBe(
      retry,
    );
    expect(retry.closest("details")).toBe(section);
    expect(operatorStorage.getItem("krine:credential-mutation:v1")).toContain(
      intent.key,
    );
    vi.mocked(api.run).mockResolvedValueOnce({
      credential: {
        ...initial,
        id: "cred_recovered",
        kind: "server",
        label: "Application",
        source: "administrator",
        public_key: null,
      },
      secret: null,
      secret_status: "unrecoverable",
    });
    await user.click(retry);
    await screen.findByText(
      /The credential was created, but its secret cannot be recovered/,
    );
    expect(vi.mocked(api.run).mock.calls[1]![0]).toEqual(intent);
    expect(document.querySelector("#credentials")).toBe(section);
    expect(sessionStorage.length).toBe(0);
  },
);

it.each([
  () => null,
  () => ({}),
  () => ({ ...setup, browser_url: null }),
  () => ({ ...setup, server_url: "javascript:alert(1)" }),
  () => ({ ...setup, allowed_origins: null }),
  () => ({ ...setup, allowed_origins: [42] }),
  () => ({ ...setup, active_credentials: { browser: -1, server: 0 } }),
  () => ({ ...setup, active_credentials: { browser: 1, server: "1" } }),
  () => ({ ...setup, browser_credential_id: null }),
  () => ({ ...setup, public_key: null }),
  () => ({ ...setup, sdk: null }),
  () => ({ ...setup, sdk: { browser_package: "@krine/browser" } }),
])(
  "reports invalid initial setup and mounts credentials only after a valid retry %#",
  async (invalid) => {
    const original = vi.mocked(api.get).getMockImplementation()!;
    let valid = false;
    vi.mocked(api.get).mockImplementation(
      async <T,>(path: string): Promise<T> =>
        path === "/setup" && !valid
          ? (invalid() as T)
          : (original(path) as Promise<T>),
    );
    mount();
    await screen.findByText(
      "Could not load this information from Krine. Retry when the connection is available.",
    );
    expect(document.querySelector("#credentials")).toBeNull();
    expect(screen.queryByText(/Showing stale data/)).toBeNull();
    valid = true;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Application credentials", { selector: "summary" });
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh receipts" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  },
);

it.each(["retained page", "different search page", "stale active snapshot"])(
  "keeps known revocation ahead of a delayed reveal and failed refresh: %s",
  async (view) => {
    const active: Credential = {
      ...initial,
      id: "cred_delayed",
      kind: "server",
      label: "Application",
      source: "administrator",
      public_key: null,
    };
    const revoked: Credential = {
      ...active,
      revoked_at: 30,
      revoked_by: "administrator",
    };
    let finish!: (value: unknown) => void;
    vi.mocked(api.run).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const original = vi.mocked(api.get).getMockImplementation()!;
    let failRead = false;
    let listReads = 0;
    vi.mocked(api.get).mockImplementation(
      async <T,>(path: string): Promise<T> => {
        if (path.startsWith("/credentials?")) {
          listReads++;
          if (failRead) throw new ApiError(503, "unavailable", "unavailable");
        }
        return original(path) as Promise<T>;
      },
    );
    mount();
    const user = await createServer();
    await screen.findByRole("button", { name: "Submitting…" });
    records = [revoked, structuredClone(initial)];
    await user.click(
      screen.getByRole("button", { name: "Refresh credentials" }),
    );
    await screen.findByText("Server secret · Revoked");
    if (view === "different search page") {
      records = [structuredClone(initial)];
      await user.type(screen.getByLabelText("Search labels"), "Initial");
      await user.click(screen.getByRole("button", { name: "Search" }));
      await waitFor(() =>
        expect(screen.queryByText("Server secret · Revoked")).toBeNull(),
      );
    } else if (view === "stale active snapshot") {
      records = [active, structuredClone(initial)];
      await user.click(
        screen.getByRole("button", { name: "Refresh credentials" }),
      );
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Refresh credentials",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      expect(screen.getByText("Server secret · Revoked")).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: "Review revocation for Application",
        }),
      ).toBeNull();
    }
    failRead = true;
    await act(async () =>
      finish({ credential: active, secret, secret_status: "revealed" }),
    );
    await screen.findByText(/Showing stale data/);
    expect(screen.queryByLabelText("New server secret")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy secret" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Credential revoked" }),
    ).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(listReads).toBeLessThan(8);
  },
);

it("keeps named credential attribution separate from the legacy shared administrator", async () => {
  records = [
    {
      ...initial,
      id: "cred_named",
      label: "Named credential",
      created_by: { id: "op_creator", type: "operator", name: "Alex Creator" },
      revoked_at: 5,
      revoked_by: "op_reviewer",
      revocation_actor: {
        id: "op_reviewer",
        type: "operator",
        name: "Lee Reviewer",
      },
    },
    {
      ...initial,
      id: "cred_legacy",
      label: "Legacy credential",
      revoked_at: 4,
      revoked_by: "administrator",
    },
  ];
  const router = createMemoryRouter(
    [{ path: "/settings", element: <Settings /> }],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  await userEvent
    .setup()
    .click(
      await screen.findByText("Application credentials", {
        selector: "summary",
      }),
    );
  await screen.findByText(/Alex Creator/);
  expect(screen.getByText(/Lee Reviewer/)).toBeTruthy();
  expect(screen.getByText(/Shared administrator \(legacy\)/)).toBeTruthy();
});
