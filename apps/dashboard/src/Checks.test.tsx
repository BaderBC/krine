import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ApiError, api } from "./api";
import type { Mutation } from "./api";
import { CheckPage } from "./Checks";
import type { Check, Metric, Policy, Version } from "./types";

const policy: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [],
  otherwise: "DENY",
};
const initial: Check = {
  name: "can_claim_trial",
  description: "Original description",
  active_version: 2,
  draft_revision: 3,
  has_draft_changes: false,
  draft: policy,
  updated_at: 1,
};
const metric: Metric = {
  name: "ip.risk",
  version: 1,
  kind: "primitive",
  value_type: "number",
  range: [0, 1],
  description: "Normalized IP risk.",
  dependencies: [],
  source: "ip_intelligence",
  missing: "Unknown when unavailable.",
  examples: [],
};
let current: Check;
beforeEach(() => {
  sessionStorage.clear();
  current = structuredClone(initial);
  vi.spyOn(api, "get").mockImplementation(
    async <T,>(path: string): Promise<T> => {
      if (path.startsWith("/metrics"))
        return { items: [metric], next_cursor: null } as T;
      if (/\/versions\/\d+(?:\?|$)/.test(path))
        return {
          version: Number(path.split("?")[0]!.split("/").at(-1)),
          published_at: 1,
          policy,
        } as T;
      if (path.includes("/versions?"))
        return {
          items: [
            { version: 2, published_at: 1, policy },
            { version: 1, published_at: 1, policy },
          ],
          next_cursor: null,
        } as T;
      return structuredClone(current) as T;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(path = "/checks/can_claim_trial?view=draft") {
  const router = createMemoryRouter(
    [
      { path: "/checks/:name", element: <CheckPage /> },
      { path: "/inspect/check", element: <CheckPage /> },
      { path: "/activity", element: <h1>Activity</h1> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("check workflows", () => {
  it("keeps edits and blocks publication after a failed save, with navigation protection and explicit retry", async () => {
    const user = userEvent.setup();
    const run = vi
      .spyOn(api, "run")
      .mockRejectedValueOnce(
        new ApiError(0, "connection_failed", "Connection lost"),
      )
      .mockImplementation(async <T,>(operation: Mutation): Promise<T> => {
        const body = operation.body as {
          policy: Policy;
          revision: number;
          description: string;
        };
        current = {
          ...current,
          draft: body.policy,
          draft_revision: body.revision + 1,
          description: body.description,
        };
        return current as T;
      });
    mount();
    await user.selectOptions(
      await screen.findByLabelText("Otherwise"),
      "ALLOW",
    );
    await screen.findByText("Save failed. Local work preserved.");
    expect(
      (screen.getByLabelText("Otherwise") as HTMLSelectElement).value,
    ).toBe("ALLOW");
    expect(
      (
        screen.getByRole("button", {
          name: "Review and publish",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("link", { name: "View activity" }));
    await screen.findByText("Leave with unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Stay and save" }));
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Draft saved. Requests continue to use v2.");
    expect(run.mock.calls[1]![0]).toEqual(run.mock.calls[0]![0]);
    expect(
      (
        screen.getByRole("button", {
          name: "Review and publish",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("publishes the reviewed draft and active revision atomically, and preserves the draft on stale publication", async () => {
    const user = userEvent.setup();
    const run = vi
      .spyOn(api, "run")
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict"));
    mount();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Review and publish",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(
      screen.getByRole("button", { name: "Review and publish" }),
    );
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    await screen.findByText(/The shared draft or active version changed/);
    expect(run.mock.calls[0]![0].body).toEqual({
      revision: 3,
      expected_active_version: 2,
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Back to editing",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    current = {
      ...current,
      draft_revision: 4,
      draft: { ...policy, otherwise: "ALLOW" },
    };
    await user.click(
      screen.getByRole("button", { name: "Compare current draft" }),
    );
    await screen.findByText("Reconcile the shared draft");
    expect(screen.getByText("Your local draft")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("a stale restoration remains cancellable and preserves the existing draft", async () => {
    const user = userEvent.setup();
    current = { ...current, draft: { ...policy, otherwise: "ALLOW" } };
    const run = vi
      .spyOn(api, "run")
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict"));
    mount("/checks/can_claim_trial?version=1");
    await user.click(
      await screen.findByRole("button", { name: "Restore this policy" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Replace draft with this version" }),
    );
    await screen.findByText(/The shared draft or active version changed/);
    expect(run.mock.calls[0]![0].body).toEqual({
      version: 1,
      revision: 3,
      replace_draft: true,
    });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    await user.click(cancel);
    await user.click(screen.getByRole("link", { name: "Edit current policy" }));
    expect(
      ((await screen.findByLabelText("Otherwise")) as HTMLSelectElement).value,
    ).toBe("ALLOW");
  });
  it("retries a lost publication response using the same intent and publishes only once", async () => {
    const user = userEvent.setup();
    const version: Version = { version: 3, published_at: 5, policy };
    const run = vi
      .spyOn(api, "run")
      .mockRejectedValueOnce(
        new ApiError(0, "connection_failed", "Response lost"),
      )
      .mockResolvedValue(version);
    const origin = "/activity?check=can_claim_trial&outcome=DENY&cursor=page2";
    const router = mount(
      `/checks/can_claim_trial?view=draft&return_to=${encodeURIComponent(origin)}`,
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Review and publish",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(
      screen.getByRole("button", { name: "Review and publish" }),
    );
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    await screen.findByText("Response lost");
    expect(
      (
        screen.getByRole("button", {
          name: "Back to editing",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    await screen.findByText(/Version 3 published/);
    expect(run.mock.calls[1]![0]).toEqual(run.mock.calls[0]![0]);
    expect(
      new URLSearchParams(router.state.location.search).get("return_to"),
    ).toBe(origin);
    expect(
      screen
        .getByRole("link", { name: "Back to Activity" })
        .getAttribute("href"),
    ).toBe(origin);
  });
});

it.each([".", ".."])(
  "keeps the canonical check selector and unrelated query context while changing views for %s",
  async (name) => {
    current.name = name;
    const user = userEvent.setup();
    const scope =
      "/activity?entity=user&entity_kind=user&from=100&to=200&cursor=older";
    const router = mount(
      `/inspect/check?name=${name}&version=1&extra=retained&return_to=${encodeURIComponent(scope)}`,
    );
    await user.click(
      await screen.findByRole("link", { name: "Edit current policy" }),
    );
    expect(router.state.location.pathname).toBe("/inspect/check");
    let selected = new URLSearchParams(router.state.location.search);
    expect(selected.get("name")).toBe(name);
    expect(selected.get("view")).toBe("draft");
    expect(selected.has("version")).toBe(false);
    expect(selected.get("return_to")).toBe(scope);
    expect(selected.get("extra")).toBe("retained");
    await user.click(screen.getByRole("link", { name: "Version 1" }));
    selected = new URLSearchParams(router.state.location.search);
    expect(selected.get("name")).toBe(name);
    expect(selected.get("version")).toBe("1");
    expect(selected.has("view")).toBe(false);
    expect(selected.get("return_to")).toBe(scope);
    expect(api.get).toHaveBeenCalledWith(
      `/lookup/checks/versions/1?name=${name}`,
    );
  },
);
it("rejects repeated canonical check selectors without reading either target", async () => {
  mount("/inspect/check?name=.&name=..");
  await screen.findByText("Provide one check name in the address.");
  expect(
    vi
      .mocked(api.get)
      .mock.calls.every(([path]) => path.startsWith("/metrics")),
  ).toBe(true);
});
