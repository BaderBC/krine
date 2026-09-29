import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import type { Provider, Version } from "./types";

const initial: Provider = {
  capability: "verification",
  provider: "turnstile",
  enabled: true,
  revision: 2,
  config: { site_key: "stored_site" },
  has_secret: true,
  status: "configuration_checked",
  message:
    "Live site-key and secret pairing has not been tested; verify it through your application.",
  checked_at: 1,
  dependent_checks: ["can_claim"],
  dependent_versions: [{ check: "can_claim", version: 3 }],
  dependents_token: "can_claim_v3",
};
const version: Version = {
  version: 3,
  published_at: 1,
  policy: {
    schema_version: 1,
    inputs: {},
    rules: [
      {
        id: "risk",
        condition: {
          op: "compare",
          left: { source: "metric", name: "ip.risk", version: 1 },
          comparison: "gte",
          value: 0.8,
        },
        then: "CHALLENGE",
        on_unknown: "CHALLENGE",
      },
    ],
    otherwise: "ALLOW",
  },
};
let current: Provider;
beforeEach(() => {
  current = structuredClone(initial);
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
      if (path.startsWith("/credentials?"))
        return { items: [], next_cursor: null } as T;
      if (path === "/providers")
        return { items: [structuredClone(current)] } as T;
      if (path === "/setup")
        return {
          browser_url: "https://krine.example",
          server_url: "https://krine.example",
          public_key: "pk_public",
          browser_credential_id: "cred_browser",
          active_credentials: { browser: 1, server: 1 },
          allowed_origins: ["https://app.example"],
          sdk: {
            browser_package: "@krine/browser",
            server_package: "@krine/server",
          },
        } as T;
      if (path === "/checks/can_claim/versions/3") return version as T;
      throw new Error(`Unexpected ${path}`);
    },
  );
  vi.spyOn(api, "run").mockImplementation(
    async <T,>(operation: Mutation): Promise<T> => {
      if (operation.path.endsWith("/tests"))
        return {
          status: "configuration_checked",
          checked_at: Date.now(),
          message:
            "Configuration format checked. Live site-key and secret pairing has not been tested; verify it through your application.",
          test_token: "pt_test",
          dependent_checks: [],
          dependent_versions: [],
          dependents_token: "can_claim_v3",
        } as T;
      const body = operation.body as {
        enabled: boolean;
        config: { site_key?: string };
      };
      current = {
        ...current,
        enabled: body.enabled,
        revision: current.revision + 1,
        config: body.enabled
          ? { site_key: body.config.site_key }
          : current.config,
      };
      return structuredClone(current) as T;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(
  path = "/settings?provider=verification&check=can_claim#providers",
) {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: <Settings /> },
      { path: "/checks/:name", element: <h1>Policy draft</h1> },
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
describe("provider configuration interface", () => {
  it("keeps the integration tutorial collapsed and preserves the return to the policy draft", async () => {
    sessionStorage.setItem("krine:draft:can_claim", "existing recovery");
    mount();
    await screen.findByLabelText("Site key");
    expect(
      document.querySelector<HTMLDetailsElement>("#integration-reference")!
        .open,
    ).toBe(false);
    expect(
      screen
        .getByRole("link", { name: "Return to policy draft · can_claim" })
        .getAttribute("href"),
    ).toBe("/checks/can_claim?view=draft");
    expect(sessionStorage.getItem("krine:draft:can_claim")).toBe(
      "existing recovery",
    );
  });
  it("checks, reviews affected versions and explicitly saves without exposing a stored or newly saved secret", async () => {
    const user = userEvent.setup();
    mount();
    const secret = (await screen.findByLabelText(
      "Secret key",
    )) as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.type).toBe("password");
    await user.type(secret, "candidate_secret");
    await user.click(
      screen.getByRole("button", { name: "Test configuration" }),
    );
    await screen.findByText("Configuration checked.");
    expect(screen.queryByText("Connected")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    const review = await screen.findByRole("region", {
      name: "Verification change review",
    });
    expect(
      within(review)
        .getByRole("link", { name: "can_claim · v3" })
        .getAttribute("href"),
    ).toBe("/checks/can_claim?version=3");
    expect(review.textContent).toContain(
      "If the condition is unknown: Require verification",
    );
    expect(review.textContent).toContain("unavailable verification denies");
    expect(review.textContent).not.toContain("candidate_secret");
    expect(api.run).toHaveBeenCalledTimes(1);
    await user.click(
      within(review).getByRole("button", { name: "Save configuration" }),
    );
    await screen.findByText("Configuration saved for new attempts.");
    expect(
      (screen.getByLabelText("Secret key") as HTMLInputElement).value,
    ).toBe("");
    expect(vi.mocked(api.run).mock.calls[1]![0].body).toMatchObject({
      revision: 2,
      reviewed_dependents_token: "can_claim_v3",
      config: { secret: "candidate_secret" },
    });
  });
  it("invalidates the successful test immediately after editing a field", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Test configuration" }),
    );
    await screen.findByRole("button", { name: "Review and save" });
    await user.type(screen.getByLabelText("Site key"), "_new");
    expect(
      screen.queryByRole("button", { name: "Review and save" }),
    ).toBeNull();
    expect(screen.queryByText("Configuration checked.")).toBeNull();
  });
  it("makes disconnect consequences explicit before performing any mutation", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Review disconnect" }),
    );
    await screen.findByRole("button", { name: "Confirm disconnect" });
    expect(
      screen.getByText(/New attempts that require verification will be denied/),
    ).toBeTruthy();
    expect(api.run).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Confirm disconnect" }),
    );
    await screen.findByText("Provider disconnected for new attempts.");
  });
  it("preserves the exact save after a lost response and blocks leaving with its outcome unknown", async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.click(
      await screen.findByRole("button", { name: "Test configuration" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review and save" }),
    );
    await screen.findByRole("button", { name: "Save configuration" });
    vi.mocked(api.run).mockRejectedValueOnce(
      new ApiError(0, "connection_failed", "lost"),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    await screen.findByRole("button", { name: "Retry same save" });
    const original = vi.mocked(api.run).mock.calls.at(-1)![0];
    await user.click(
      screen.getByRole("link", { name: "Return to policy draft · can_claim" }),
    );
    await screen.findByText("A provider save is unconfirmed.");
    expect(router.state.location.pathname).toBe("/settings");
    expect(
      screen.queryByRole("button", { name: "Discard and leave" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Stay with configuration" }),
    );
    await user.click(screen.getByRole("button", { name: "Retry same save" }));
    await screen.findByText("Configuration saved for new attempts.");
    expect(vi.mocked(api.run).mock.calls.at(-1)![0]).toEqual(original);
  });
  it("warns before discarding an entered secret and permits explicit discard", async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.type(
      await screen.findByLabelText("Secret key"),
      "private_candidate",
    );
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await user.click(
      screen.getByRole("link", { name: "Return to policy draft · can_claim" }),
    );
    await screen.findByText("Leave with unsaved provider changes?");
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/checks/can_claim"),
    );
    expect(document.body.textContent).not.toContain("private_candidate");
  });
  it("focuses the invalid field and never dispatches an invalid candidate", async () => {
    current = { ...current, revision: 0, config: {}, has_secret: false };
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Test configuration" }),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a Turnstile site key",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Site key"));
    expect(api.run).not.toHaveBeenCalled();
  });
});
