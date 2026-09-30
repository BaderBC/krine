import { methodsFixture, sessionFixture } from "./operator-test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { Settings } from "./Settings";
import { api, Api } from "./api";
import type { Provider } from "./types";

const initial: Provider = {
  capability: "verification",
  provider: "turnstile",
  enabled: true,
  revision: 2,
  config: { site_key: "old_site" },
  has_secret: true,
  status: "configuration_checked",
  message: "Live pairing is untested.",
  checked_at: 1,
  dependent_checks: [],
  dependent_versions: [],
  dependents_token: "empty",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  api.csrf = "";
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.csrf = "";
});

it.each([401])(
  "recovers a committed provider save after %i through the mounted reauthentication dialog",
  async (status) => {
    const user = userEvent.setup();
    let current = structuredClone(initial);
    const puts: RequestInit[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/auth/methods") return json(methodsFixture);
      if (path === "/session")
        return json({
          ...sessionFixture(),
          csrf_token: init.method === "POST" ? "renewed_csrf" : "expired_csrf",
          expires_at: Date.now() + 60_000,
        });
      if (path === "/setup")
        return json({
          public_key: "pk_fixture",
          browser_credential_id: "cred_browser",
          active_credentials: { browser: 1, server: 1 },
          browser_url: "http://fixture",
          server_url: "http://fixture",
          allowed_origins: [],
          sdk: {
            browser_package: "@krine/browser",
            server_package: "@krine/server",
          },
        });
      if (path === "/providers") return json({ items: [current] });
      if (path.endsWith("/tests"))
        return json({
          status: "configuration_checked",
          checked_at: Date.now(),
          message: "Live pairing is untested.",
          test_token: "pt_fixture",
        });
      if (path === "/providers/verification" && init.method === "PUT") {
        puts.push(structuredClone(init));
        if (puts.length === 1) {
          current = {
            ...current,
            revision: 3,
            config: { site_key: "old_site" },
          };
          throw new TypeError("Committed response lost");
        }
        if (puts.length === 2)
          return json(
            {
              error: {
                code: status === 401 ? "unauthenticated" : "forbidden",
                message: "Authorization failed before replay lookup",
              },
            },
            status,
          );
        return json(current);
      }
      throw new Error(`Unexpected fixture request ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const router = createMemoryRouter(
      [
        {
          element: <App />,
          children: [{ path: "/settings", element: <Settings /> }],
        },
      ],
      {
        initialEntries: ["/settings?provider=verification#providers"],
      },
    );
    render(<RouterProvider router={router} />);
    const secret = await screen.findByLabelText("Secret key");
    const providerPanel = secret.closest("details");
    await user.type(secret, "fixture_candidate_secret");
    await user.click(
      screen.getByRole("button", { name: "Test configuration" }),
    );
    await screen.findByText("Configuration checked.");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(
      await screen.findByRole("button", { name: "Save configuration" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Retry same save" }),
    );
    await screen.findByRole("heading", { name: "Sign in again." });
    expect(document.querySelector("details.provider")).toBe(providerPanel);
    expect(screen.queryByLabelText("Secret key")).toBeNull();
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Sign-in credential"),
      "fixture_admin_password",
    );
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await user.click(
      await screen.findByRole("button", { name: "Retry same save" }),
    );
    await screen.findByText("Configuration saved for new attempts.");
    expect(document.querySelector("details.provider")).toBe(providerPanel);
    expect(
      (screen.getByLabelText("Secret key") as HTMLInputElement).value,
    ).toBe("");
    expect(puts).toHaveLength(3);
    expect(JSON.parse(puts[2]!.body as string).config.secret).toBe(
      "fixture_candidate_secret",
    );
    for (const request of puts) {
      expect(request.body).toBe(puts[0]!.body);
      expect(
        (request.headers as Record<string, string>)["Idempotency-Key"],
      ).toBe((puts[0]!.headers as Record<string, string>)["Idempotency-Key"]);
    }
    expect((puts[2]!.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "renewed_csrf",
    );
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  },
);

it.each([401])(
  "opens in-place reauthentication even when a %i error body is unreadable",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unreadable", { status })),
    );
    const transport = new Api();
    transport.onUnauthorized = vi.fn();
    await expect(transport.get("/checks")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(transport.onUnauthorized).toHaveBeenCalledOnce();
  },
);

it.each([
  null,
  {},
  { csrf_token: 5, expires_at: 1 },
  { csrf_token: "", expires_at: 1 },
])(
  "does not replace an existing CSRF token with a malformed session acknowledgement",
  async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    const transport = new Api();
    transport.csrf = "known_csrf";
    await expect(
      transport.session({
        sign_in_name: "fixture",
        credential: "fixture_password",
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(transport.csrf).toBe("known_csrf");
  },
);

it.each([401])(
  "recovers credential creation after a malformed committed response and %i without losing its original request",
  async (status) => {
    const user = userEvent.setup();
    const requests: RequestInit[] = [];
    const credential = {
      id: "cred_recovery",
      kind: "server",
      label: "Recovery test",
      source: "administrator",
      public_key: null,
      created_at: 1,
      revoked_at: null,
      revoked_by: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const path = url.replace("/v1/admin", "");
        if (path === "/auth/methods") return json(methodsFixture);
        if (path === "/session")
          return json({
            ...sessionFixture(),
            csrf_token:
              init.method === "POST" ? "renewed_csrf" : "original_csrf",
            expires_at: Date.now() + 60_000,
          });
        if (path === "/setup")
          return json({
            public_key: "pk_fixture",
            browser_credential_id: "cred_browser",
            active_credentials: { browser: 1, server: 1 },
            browser_url: "https://fixture.example",
            server_url: "https://fixture.example",
            allowed_origins: [],
            sdk: {
              browser_package: "@krine/browser",
              server_package: "@krine/server",
            },
          });
        if (path === "/providers") return json({ items: [] });
        if (path.startsWith("/credentials?"))
          return json({
            items: requests.length ? [credential] : [],
            next_cursor: null,
          });
        if (path === "/credentials" && init.method === "POST") {
          requests.push(structuredClone(init));
          if (requests.length === 1) return json(null);
          if (requests.length === 2)
            return json(
              { error: { code: "unauthenticated", message: "Sign in again" } },
              status,
            );
          return json({
            credential,
            secret: null,
            secret_status: "unrecoverable",
          });
        }
        throw new Error(`Unexpected fixture request ${path}`);
      }),
    );
    const router = createMemoryRouter(
      [
        {
          element: <App />,
          children: [{ path: "/settings", element: <Settings /> }],
        },
      ],
      { initialEntries: ["/settings"] },
    );
    render(<RouterProvider router={router} />);
    await user.click(
      await screen.findByText("Application credentials", {
        selector: "summary",
      }),
    );
    const panel = document.querySelector("#credentials");
    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.selectOptions(
      screen.getByLabelText("Credential type"),
      "server",
    );
    await user.type(screen.getByLabelText("Label"), "Recovery test");
    await user.click(
      screen.getByRole("button", { name: "Create server secret" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Retry same request" }),
    );
    await screen.findByRole("heading", { name: "Sign in again." });
    expect(document.querySelector("#credentials")).toBe(panel);
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Sign-in credential"),
      "fixture_admin_password",
    );
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await user.click(
      await screen.findByRole("button", { name: "Retry same request" }),
    );
    await screen.findByText(
      /The credential was created, but its secret cannot be recovered/,
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.body).toBe(requests[0]!.body);
      expect(
        (request.headers as Record<string, string>)["Idempotency-Key"],
      ).toBe(
        (requests[0]!.headers as Record<string, string>)["Idempotency-Key"],
      );
    }
    expect(
      (requests[2]!.headers as Record<string, string>)["X-CSRF-Token"],
    ).toBe("renewed_csrf");
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  },
);
