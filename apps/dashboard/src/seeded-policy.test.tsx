import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { CheckPage } from "./Checks";
import { readPolicy } from "./policy-response";
import { sameJson } from "./policy";

// Generator v1's captured can_claim_trial policy, including its omitted inputs.
const historical = {
  schema_version: 1,
  rules: [
    {
      id: "shared_client",
      condition: {
        op: "compare",
        left: { source: "metric", name: "client.user_count_30d", version: 1 },
        comparison: "gte",
        value: 3,
      },
      then: "DENY",
      on_unknown: "DENY",
    },
  ],
  otherwise: "ALLOW",
};
let draft: unknown;
let description: string;
let revision: number;
let invalid = false;
let saves: Record<string, unknown>[];
function check() {
  return {
    name: "can_claim_trial",
    description,
    active_version: 1,
    draft_revision: revision,
    updated_at: 100,
    has_draft_changes: !sameJson(readPolicy(draft), readPolicy(historical)),
    draft: invalid ? { schema_version: 1, inputs: null } : draft,
  };
}
function mount(search: string) {
  const router = createMemoryRouter(
    [{ path: "/inspect/check", element: <CheckPage /> }],
    { initialEntries: [`/inspect/check?name=can_claim_trial&${search}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  sessionStorage.clear();
  draft = structuredClone(historical);
  description = "Seeded check";
  revision = 1;
  invalid = false;
  saves = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      let body: unknown;
      if (path.includes("/metrics")) body = { items: [], next_cursor: null };
      else if (path.includes("/restorations")) {
        draft = structuredClone(historical);
        revision++;
        body = check();
      } else if (path.includes("/draft")) {
        const saved = JSON.parse(init.body as string);
        saves.push(saved);
        draft = saved.policy;
        description = saved.description;
        revision++;
        body = check();
      } else if (path.includes("/versions/1"))
        body = { version: 1, published_at: 100, policy: historical };
      else if (path.includes("/versions?"))
        body = {
          items: [{ version: 1, published_at: 100, policy: historical }],
          next_cursor: null,
        };
      else body = check();
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads a captured seeded version, restores it, and edits without a crash or false policy change", async () => {
  const user = userEvent.setup();
  mount("version=1");
  await screen.findByText("Policy v1 · Read-only version");
  expect(
    await screen.findByText(/client.user_count_30d v1 is at least 3/),
  ).toBeTruthy();
  expect(saves).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Restore this policy" }));
  await user.click(
    screen.getByRole("button", { name: "Replace draft with this version" }),
  );
  const input = await screen.findByLabelText(/Description/);
  expect(
    (await screen.findByLabelText("Otherwise")) as HTMLSelectElement,
  ).toHaveProperty("value", "ALLOW");
  await user.clear(input);
  await user.type(input, "Description changed only");
  await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 });
  expect(saves[0]!.policy).toEqual({ ...historical, inputs: {} });
  await screen.findByText("Draft saved. Requests continue to use v1.");
  expect(screen.queryByText(/Draft differs from/)).toBeNull();
  expect(Object.hasOwn(historical, "inputs")).toBe(false);
});

it("expands all defaults safely in the editable draft", async () => {
  draft = { schema_version: 1 };
  mount("view=draft");
  expect(
    (await screen.findByLabelText("Otherwise")) as HTMLSelectElement,
  ).toHaveProperty("value", "DENY");
  expect(saves).toHaveLength(0);
});

it("shows a retryable read error for malformed policy data and never opens an editor", async () => {
  invalid = true;
  mount("view=draft");
  await screen.findByText(/Could not load this information from Krine/);
  expect(screen.queryByLabelText("Otherwise")).toBeNull();
  expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  expect(saves).toHaveLength(0);
});
