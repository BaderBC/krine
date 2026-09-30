import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Api, api, ApiError, definitiveMutationFailure } from "./api";
import { DraftController } from "./draft";
import { ownedStorage } from "./operator";
import { authenticateFixture, sessionFixture } from "./operator-test-fixtures";
import { useOperatorChange, type OperatorChange } from "./operator-form";
import { Settings } from "./Settings";

const target = {
  ...sessionFixture("editor", "op_review_target").operator!,
  name: "Review Target",
  sign_in_name: "review_target",
};
const session = {
  id: "os_review",
  created_at: 1,
  expires_at: Date.now() + 3600_000,
  revoked_at: null,
  current: false,
};
function mountAccess() {
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path.startsWith("/operators?"))
      return { items: [target], next_cursor: null } as never;
    if (path === `/operators/${target.id}`) return target as never;
    if (path.includes("/sessions?"))
      return { items: [session], next_cursor: null } as never;
    throw Error(`Unexpected request: ${path}`);
  });
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: "/settings", element: <Settings /> }],
        {
          initialEntries: [`/settings?view=operators&operator=${target.id}`],
        },
      )}
    />,
  );
}
function change(started_at = Date.now()): OperatorChange {
  return {
    kind: "update",
    target: target.id,
    revision: target.revision,
    session_id: null,
    started_at,
    operation: {
      path: `/operators/${target.id}`,
      method: "PUT",
      key: "reviewed-immutable-key",
      owner: api.requireOwner(),
      body: {
        revision: target.revision,
        name: "Reviewed name",
        role: target.role,
        state: target.state,
        reason: "Correct the recorded name",
      },
    },
  };
}
function mountChange(onResult = vi.fn()) {
  let current!: ReturnType<typeof useOperatorChange>;
  function Harness() {
    current = useOperatorChange(onResult);
    return <span>{current.error}</span>;
  }
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: "/", element: <Harness /> }])}
    />,
  );
  return {
    get current() {
      return current;
    },
    onResult,
  };
}
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it.each(["Add operator", "Edit access", "Rotate sign-in credential"])(
  "%s preserves its fields until deliberate cancellation before another mode",
  async (mode) => {
    const user = userEvent.setup();
    mountAccess();
    await screen.findByLabelText("Revocation reason");
    await user.click(screen.getByRole("button", { name: mode }));
    await user.type(
      screen.getByLabelText("Reason"),
      "Preserve this reviewed change",
    );
    const name = screen.queryByLabelText("Name");
    if (name) {
      await user.clear(name);
      await user.type(name, "Unsaved operator name");
    }
    for (const label of [
      "Add operator",
      "Edit access",
      "Rotate sign-in credential",
      "Revoke sessions",
    ]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toHaveProperty("disabled", true);
      await user.click(button);
    }
    expect(screen.getByLabelText("Reason")).toHaveProperty(
      "value",
      "Preserve this reviewed change",
    );
    if (name)
      expect(screen.getByLabelText("Name")).toHaveProperty(
        "value",
        "Unsaved operator name",
      );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Reason")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add operator" }));
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "");
  },
);

it.each(["   ", " Surrounding whitespace ", "é".repeat(300)])(
  "invalid revocation reason %# is explained, focused and never sent",
  async (reason) => {
    const user = userEvent.setup();
    const send = vi.spyOn(api, "run");
    const confirm = vi.spyOn(window, "confirm");
    mountAccess();
    const input = await screen.findByLabelText("Revocation reason");
    fireEvent.change(input, { target: { value: reason } });
    await user.click(screen.getByRole("button", { name: "Revoke sessions" }));
    expect(send).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "1–512 UTF-8 bytes",
    );
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("revocation-error");
    fireEvent.change(input, {
      target: { value: "Reviewed session revocation" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  },
);

it("last-Admin rejection remains recoverable and explains an uncleared stored request", async () => {
  const hook = mountChange();
  const operation = change();
  const storage = ownedStorage(sessionStorage, api.requireOwner());
  vi.spyOn(api, "run").mockRejectedValue(
    new ApiError(409, "last_admin", "Last administrator"),
  );
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("Storage disabled", "SecurityError");
  });
  await act(async () => {
    await hook.current.send(operation);
  });
  expect(hook.current.busy).toBe(false);
  expect(hook.current.pending).toBeNull();
  expect(hook.current.error).toContain("last active Admin");
  expect(hook.current.error).toContain(
    "browser recovery record could not be cleared",
  );
  expect(JSON.parse(storage.getItem("operator-change:v1")!)).toEqual(operation);
  expect(hook.onResult).not.toHaveBeenCalled();
});

it("expired recovery stays visible after removal fails and can be cleared once storage recovers", () => {
  const operation = change(Date.now() - 24 * 3600_000);
  const storage = ownedStorage(sessionStorage, api.requireOwner());
  storage.setItem("operator-change:v1", JSON.stringify(operation));
  const hook = mountChange();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
  act(() => hook.current.acknowledgeExpired());
  expect(hook.current.pending).toEqual(operation);
  expect(hook.current.expired).toBe(true);
  expect(hook.current.error).toContain("It remains stored");
  expect(JSON.parse(storage.getItem("operator-change:v1")!)).toEqual(operation);
  remove.mockRestore();
  act(() => hook.current.acknowledgeExpired());
  expect(hook.current.pending).toBeNull();
  expect(hook.current.error).toBeNull();
  expect(storage.getItem("operator-change:v1")).toBeNull();
});

it("confirmed lifecycle results survive failure to remove their recovery record", async () => {
  const hook = mountChange();
  const operation = change();
  const result = {
    ...target,
    name: "Reviewed name",
    revision: target.revision + 1,
  };
  vi.spyOn(api, "run").mockResolvedValue(result);
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("Storage disabled", "SecurityError");
  });
  await act(async () => {
    await hook.current.send(operation);
  });
  expect(hook.onResult).toHaveBeenCalledExactlyOnceWith(operation, result);
  expect(hook.current.pending).toBeNull();
  expect(hook.current.busy).toBe(false);
  expect(hook.current.error).toContain("The change is confirmed");
});

const diagnostic = { code: "invalid_input", message: "Invalid policy" };
it.each([
  null,
  {},
  { error: [] },
  { error: { ...diagnostic, code: ["invalid_input"] } },
  { error: { ...diagnostic, code: "" } },
  { error: { code: "invalid_input" } },
  { error: { ...diagnostic, message: { text: "Invalid policy" } } },
  { error: { ...diagnostic, details: null } },
  { error: { ...diagnostic, details: { path: "draft", message: "Invalid" } } },
  { error: { ...diagnostic, details: [null] } },
  {
    error: {
      ...diagnostic,
      details: [{ path: ["draft"], message: "Invalid" }],
    },
  },
  {
    error: {
      ...diagnostic,
      details: [{ path: "draft", message: ["Invalid"] }],
    },
  },
])(
  "malformed error envelope %# cannot become a definitive mutation failure",
  async (body) => {
    const client = new Api();
    authenticateFixture(client);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 422 })),
    );
    const error = await client
      .run(change().operation)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      status: 422,
      code: "invalid_response",
      details: [],
    });
    expect(definitiveMutationFailure(error)).toBe(false);
  },
);

it("validated policy diagnostics remain actionable definitive failures", async () => {
  const client = new Api();
  authenticateFixture(client);
  const details = [{ path: "draft.rules[0]", message: "Choose an outcome" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { ...diagnostic, details } }), {
          status: 422,
        }),
    ),
  );
  const error = await client
    .run(change().operation)
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({
    status: 422,
    code: "invalid_input",
    message: "Invalid policy",
    details,
  });
  expect(definitiveMutationFailure(error)).toBe(true);
});

it("a malformed diagnostic preserves the draft's exact actor, body and key through an explicit retry", async () => {
  const client = new Api();
  authenticateFixture(client);
  const initial = {
    name: "review_check",
    description: "",
    active_version: 1,
    draft_revision: 1,
    has_draft_changes: false,
    updated_at: 1,
    draft: {
      schema_version: 1 as const,
      inputs: {},
      rules: [],
      otherwise: "DENY" as const,
    },
  };
  const firstPolicy = { ...initial.draft, otherwise: "ALLOW" as const };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { ...diagnostic, details: {} } }), {
        status: 422,
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...initial,
          draft_revision: 2,
          draft: firstPolicy,
          has_draft_changes: true,
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const model = new DraftController(client, initial, sessionStorage);
  model.edit(firstPolicy);
  await model.save();
  expect(model.state.status).toBe("failed");
  const storage = ownedStorage(sessionStorage, client.requireOwner());
  const record = JSON.parse(storage.getItem("krine:draft:review_check")!);
  expect(record.intent).toMatchObject({
    kind: "save",
    owner: client.requireOwner(),
  });
  model.edit({ ...firstPolicy, otherwise: "DENY" });
  await model.save();
  expect(fetch).toHaveBeenCalledTimes(2);
  const firstRequest = fetch.mock.calls[0]![1] as RequestInit;
  const retriedRequest = fetch.mock.calls[1]![1] as RequestInit;
  expect(retriedRequest.body).toBe(firstRequest.body);
  expect(retriedRequest.headers).toEqual(firstRequest.headers);
  expect(model.state.policy.otherwise).toBe("DENY");
  expect(model.state.status).toBe("changed");
  expect(
    JSON.parse(storage.getItem("krine:draft:review_check")!).intent,
  ).toBeNull();
  model.dispose();
});

it.each([
  new ApiError(401, "unauthenticated", "Sign in again."),
  new ApiError(403, "insufficient_privilege", "Access changed."),
  new ApiError(408, "timeout", "The request timed out."),
  new ApiError(0, "connection_failed", "Could not reach Krine."),
  null,
])(
  "unpersisted request %# keeps its recovery warning through ambiguous outcomes and explicit retries",
  async (failure) => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    const run = vi.spyOn(api, "run");
    if (failure) run.mockRejectedValue(failure);
    else run.mockResolvedValue({});
    const hook = mountChange();
    const operation = change();
    await act(async () => {
      await hook.current.send(operation);
    });
    expect(hook.current.busy).toBe(false);
    expect(hook.current.pending).toEqual(operation);
    expect(hook.current.error).toContain("Browser recovery is unavailable");
    expect(hook.current.error).toContain("Keep this page open");
    expect(hook.current.error).toContain(
      "reloading may lose the exact retry request",
    );
    expect(screen.getByText(/Keep this page open/)).toBeTruthy();
    expect(
      ownedStorage(sessionStorage, operation.operation.owner).getItem(
        "operator-change:v1",
      ),
    ).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      await hook.current.send(hook.current.pending!);
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0]).toEqual(operation.operation);
    expect(run.mock.calls[1]![0]).toEqual(operation.operation);
    expect(hook.current.pending).toEqual(operation);
    expect(hook.current.error).toContain("Keep this page open");
  },
);

it("unavailable storage access keeps the in-memory warning alongside a later transport error", async () => {
  const operation = change();
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("Storage disabled", "SecurityError");
  });
  let reject!: (reason: unknown) => void;
  const run = vi.spyOn(api, "run").mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const hook = mountChange();
  let request!: Promise<void>;
  await act(async () => {
    request = hook.current.send(operation);
    await Promise.resolve();
  });
  expect(hook.current.busy).toBe(true);
  expect(hook.current.error).toContain("Browser recovery is unavailable");
  expect(hook.current.pending).toEqual(operation);
  await act(async () => {
    reject(new ApiError(0, "connection_failed", "Could not reach Krine."));
    await request;
  });
  expect(hook.current.busy).toBe(false);
  expect(hook.current.error).toContain("Could not reach Krine");
  expect(hook.current.error).toContain("Keep this page open");
  expect(hook.current.pending).toEqual(operation);
  expect(run).toHaveBeenCalledExactlyOnceWith(operation.operation);
});

it("a deliberate retry can restore persistence without changing its intent or claiming failure was confirmation", async () => {
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
  let confirm!: (value: unknown) => void;
  const run = vi
    .spyOn(api, "run")
    .mockRejectedValueOnce(
      new ApiError(0, "connection_failed", "Could not reach Krine."),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
  const hook = mountChange();
  const operation = change();
  await act(async () => {
    await hook.current.send(operation);
  });
  expect(hook.current.error).toContain("Keep this page open");
  expect(hook.onResult).not.toHaveBeenCalled();
  write.mockRestore();
  let retry!: Promise<void>;
  await act(async () => {
    retry = hook.current.send(hook.current.pending!);
    await Promise.resolve();
  });
  const storage = ownedStorage(sessionStorage, operation.operation.owner);
  expect(JSON.parse(storage.getItem("operator-change:v1")!)).toEqual(operation);
  expect(hook.current.error).toBeNull();
  expect(hook.current.busy).toBe(true);
  expect(hook.current.pending).toEqual(operation);
  expect(run.mock.calls[0]![0]).toEqual(operation.operation);
  expect(run.mock.calls[1]![0]).toEqual(operation.operation);
  const result = {
    ...target,
    name: "Reviewed name",
    revision: target.revision + 1,
  };
  await act(async () => {
    confirm(result);
    await retry;
  });
  expect(hook.current.pending).toBeNull();
  expect(hook.current.error).toBeNull();
  expect(hook.current.busy).toBe(false);
  expect(hook.onResult).toHaveBeenCalledExactlyOnceWith(operation, result);
  expect(storage.getItem("operator-change:v1")).toBeNull();
});
