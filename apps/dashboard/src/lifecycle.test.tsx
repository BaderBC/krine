import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api } from "./api";
import { CheckPage } from "./Checks";
const policy = { schema_version: 1, inputs: {}, rules: [], otherwise: "DENY" };
let current: any;
beforeEach(() => {
  sessionStorage.clear();
  current = {
    name: "qa",
    description: "original",
    active_version: 2,
    draft_revision: 3,
    draft: policy,
    updated_at: 1,
  };
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path.startsWith("/metrics"))
      return { items: [], next_cursor: null } as any;
    if (path.includes("/versions?"))
      return {
        items: [{ version: 1, published_at: 1, policy }],
        next_cursor: null,
      } as any;
    if (path.includes("/versions/"))
      return {
        version: Number(path.split("?")[0]!.split("/").at(-1)),
        published_at: 1,
        policy,
      } as any;
    return structuredClone(current);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("does not erase edits made after leaving an in-flight publication review", async () => {
  const user = userEvent.setup();
  let finish: any;
  vi.spyOn(api, "run").mockImplementation(async (op) => {
    if (op.path.split("?")[0]!.endsWith("/publications"))
      return (await new Promise((resolve) => {
        finish = resolve;
      })) as any;
    const b = op.body as any;
    current = {
      ...current,
      description: b.description,
      draft: b.policy,
      draft_revision: b.revision + 1,
    };
    return current;
  });
  const router = createMemoryRouter(
    [{ path: "/checks/:name", element: <CheckPage /> }],
    { initialEntries: ["/checks/qa?view=draft"] },
  );
  render(<RouterProvider router={router} />);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Review and publish",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "Review and publish" }));
  await user.click(screen.getByRole("button", { name: "Publish version" }));
  await user.click(screen.getByText("Versions", { selector: "summary" }));
  await user.click(screen.getByRole("link", { name: "Version 1" }));
  await user.click(
    await screen.findByRole("link", { name: "Edit current policy" }),
  );
  const desc = await screen.findByLabelText(/Description/);
  await user.clear(desc);
  await user.type(desc, "new work");
  expect((desc as HTMLInputElement).value).toBe("new work");
  await act(async () => finish({ version: 3, published_at: 5, policy }));
  // A late completion must also leave the newer navigation in place.
  expect(router.state.location.search).toBe("?view=draft");
  expect(
    ((await screen.findByLabelText(/Description/)) as HTMLInputElement).value,
  ).toBe("new work");
});
it("does not erase edits made after leaving an in-flight restoration", async () => {
  const user = userEvent.setup();
  let finish: any;
  vi.spyOn(api, "run").mockImplementation(async (op) => {
    if (op.path.split("?")[0]!.endsWith("/restorations"))
      return (await new Promise((resolve) => {
        finish = resolve;
      })) as any;
    const b = op.body as any;
    current = {
      ...current,
      description: b.description,
      draft: b.policy,
      draft_revision: b.revision + 1,
    };
    return current;
  });
  const router = createMemoryRouter(
    [{ path: "/checks/:name", element: <CheckPage /> }],
    { initialEntries: ["/checks/qa?version=1"] },
  );
  render(<RouterProvider router={router} />);
  await user.click(
    await screen.findByRole("button", { name: "Restore this policy" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Replace draft with this version" }),
  );
  await user.click(screen.getByRole("link", { name: "Edit current policy" }));
  const desc = await screen.findByLabelText(/Description/);
  await user.clear(desc);
  await user.type(desc, "newer work");
  expect((desc as HTMLInputElement).value).toBe("newer work");
  await act(async () => finish({ ...current, draft_revision: 4 }));
  expect(
    ((await screen.findByLabelText(/Description/)) as HTMLInputElement).value,
  ).toBe("newer work");
});
it.each(["publications", "restorations"])(
  "old %s response cannot delete recovery after unmount and reopen",
  async (kind) => {
    const user = userEvent.setup();
    let finish: any;
    vi.spyOn(api, "run").mockImplementation(async (op) => {
      if (op.path.split("?")[0]!.endsWith("/" + kind))
        return (await new Promise((resolve) => {
          finish = resolve;
        })) as any;
      const b = op.body as any;
      current = {
        ...current,
        description: b.description,
        draft: b.policy,
        draft_revision: b.revision + 1,
      };
      return current;
    });
    const router = createMemoryRouter(
      [
        { path: "/checks/:name", element: <CheckPage /> },
        { path: "/inspect/check", element: <CheckPage /> },
        { path: "/activity", element: <p>Activity test route</p> },
      ],
      {
        initialEntries: [
          kind === "publications"
            ? "/checks/qa?view=draft"
            : "/checks/qa?version=1",
        ],
      },
    );
    render(<RouterProvider router={router} />);
    if (kind === "publications") {
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
    } else {
      await user.click(
        await screen.findByRole("button", { name: "Restore this policy" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Replace draft with this version" }),
      );
    }
    await user.click(screen.getByRole("link", { name: "View activity" }));
    await screen.findByText("Activity test route");
    await act(async () => router.navigate("/checks/qa?view=draft"));
    const desc = await screen.findByLabelText(/Description/);
    await user.type(desc, " newer unsaved");
    expect(sessionStorage.getItem("krine:draft:qa")).toContain("newer unsaved");
    await act(async () =>
      finish(
        kind === "publications"
          ? { version: 3, published_at: 5, policy }
          : { ...current, draft_revision: 4 },
      ),
    );
    expect(sessionStorage.getItem("krine:draft:qa")).toContain("newer unsaved");
  },
);
import { DraftController } from "./draft";
it("old autosave response cannot delete a reopened controller recovery copy", async () => {
  let finish: any;
  const old = new DraftController(
    {
      run: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    } as any,
    current,
    sessionStorage,
  );
  old.edit({ ...policy, otherwise: "ALLOW" } as any);
  const saving = old.save();
  const reopened = new DraftController(
    { run: vi.fn() } as any,
    current,
    sessionStorage,
  );
  reopened.edit(
    { ...policy, otherwise: "ALLOW" } as any,
    "newer controller edits",
  );
  expect(sessionStorage.getItem("krine:draft:qa")).toContain(
    "newer controller edits",
  );
  finish({
    ...current,
    draft_revision: 4,
    draft: { ...policy, otherwise: "ALLOW" },
  });
  await saving;
  expect(sessionStorage.getItem("krine:draft:qa")).toContain(
    "newer controller edits",
  );
});
