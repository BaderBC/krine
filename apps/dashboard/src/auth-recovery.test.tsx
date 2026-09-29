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

it.each([401, 403])(
  "recovers a committed provider save after %i through the mounted reauthentication dialog",
  async (status) => {
    const user = userEvent.setup();
    let current = structuredClone(initial);
    const puts: RequestInit[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("/v1/admin", "");
      if (path === "/session")
        return json({
          csrf_token: init.method === "POST" ? "renewed_csrf" : "expired_csrf",
          expires_at: Date.now() + 60_000,
        });
      if (path === "/setup")
        return json({
          public_key: "pk_fixture",
          browser_url: "http://fixture",
          server_url: "http://fixture",
          allowed_origins: [],
          sdk: {},
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
      within(dialog).getByLabelText("Administrator password"),
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

it.each([401, 403])(
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
    await expect(transport.session("fixture_password")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(transport.csrf).toBe("known_csrf");
  },
);
