import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Settings } from "./Settings";
import { api, ApiError } from "./api";
import { sessionFixture } from "./operator-test-fixtures";
import { ownedStorage } from "./operator";
const target = {
  ...sessionFixture("editor", "op_qa_target").operator!,
  name: "QA Target",
  sign_in_name: "qa_target",
};
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path.startsWith("/operators?"))
      return { items: [target], next_cursor: null } as never;
    if (path === `/operators/${target.id}`) return target as never;
    if (path.includes("/sessions?"))
      return {
        items: [
          {
            id: "os_qa",
            created_at: 1,
            expires_at: Date.now() + 60000,
            revoked_at: null,
            current: false,
          },
        ],
        next_cursor: null,
      } as never;
    throw Error(`Unexpected ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('QA: an ambiguous unpersisted session revocation cannot disappear on internal navigation',async()=>{
 const user=userEvent.setup();
 vi.spyOn(window,'confirm').mockReturnValue(true);
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Storage full','QuotaExceededError');});
 vi.spyOn(api,'run').mockRejectedValue(new ApiError(0,'connection_failed','Response lost'));
 const router=createMemoryRouter([{path:'/settings',element:<Settings/>}],{initialEntries:['/settings?view=operators&operator=op_qa_target']});
 render(<RouterProvider router={router}/>);
 await user.type(await screen.findByLabelText('Revocation reason'),'Reviewed uncertain revocation');
 await user.click(screen.getByRole('button',{name:'Revoke sessions'}));
 await screen.findByText(/Browser recovery is unavailable/);
 await user.click(screen.getByRole('link',{name:'Application'}));
 expect(router.state.location.search).toBe('?view=operators&operator=op_qa_target');
 expect(screen.getByText(/Browser recovery is unavailable/)).toBeTruthy();
});

it('QA: an ordinary in-flight revocation has the same internal-navigation protection as page unload',async()=>{
 const user=userEvent.setup();
 vi.spyOn(window,'confirm').mockReturnValue(true);
 let fail!:(cause:unknown)=>void;
 vi.spyOn(api,'run').mockImplementation(()=>new Promise((_,reject)=>{fail=reject;}));
 const router=createMemoryRouter([{path:'/settings',element:<Settings/>}],{initialEntries:['/settings?view=operators&operator=op_qa_target']});
 render(<RouterProvider router={router}/>);
 await user.type(await screen.findByLabelText('Revocation reason'),'Reviewed ongoing request');
 await user.click(screen.getByRole('button',{name:'Revoke sessions'}));
 await screen.findByRole('button',{name:'Confirming…'});
 try {
   const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);
   expect(unload.defaultPrevented).toBe(true);
   await user.click(screen.getByRole('link',{name:'Application'}));
   expect(router.state.location.search).toBe('?view=operators&operator=op_qa_target');
   expect(screen.getByRole('button',{name:'Confirming…'})).toBeTruthy();
 } finally {
   await act(async()=>{fail(new ApiError(0,'connection_failed','Response lost'));await Promise.resolve();});
 }
});

const operatorPath = "/settings?view=operators&operator=op_qa_target";
function navigationRouter(previous = "/settings?view=sessions") {
  const router = createMemoryRouter(
    [{ path: "/settings", element: <Settings /> }],
    {
      initialEntries: [previous, operatorPath],
      initialIndex: 1,
    },
  );
  render(<RouterProvider router={router} />);
  return router;
}
function storedRevocation(started_at = Date.now()) {
  const change = {
    kind: "revoke",
    target: target.id,
    revision: target.revision,
    session_id: null,
    started_at,
    operation: {
      path: `/operators/${target.id}/session-revocations`,
      method: "POST",
      key: "navigation-review-key",
      owner: api.requireOwner(),
      body: {
        revision: target.revision,
        reason: "Reviewed session revocation",
      },
    },
  };
  ownedStorage(sessionStorage, change.operation.owner).setItem(
    "operator-change:v1",
    JSON.stringify(change),
  );
  return change;
}

it("restored revocation blocks Back and operator selection without replay or generic discard", async () => {
  const user = userEvent.setup();
  const change = storedRevocation();
  const run = vi.spyOn(api, "run");
  const router = navigationRouter();
  await screen.findByRole("button", { name: "Retry same operator request" });
  expect(run).not.toHaveBeenCalled();
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.search).toBe(
    "?view=operators&operator=op_qa_target",
  );
  expect(screen.getByText(/This operator request is unconfirmed/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Discard and leave" }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Stay here" }),
  );
  await user.click(screen.getByRole("button", { name: "Stay here" }));
  await act(async () => {
    await router.navigate("/settings?view=operators&operator=op_another");
  });
  expect(router.state.location.search).toBe(
    "?view=operators&operator=op_qa_target",
  );
  expect(screen.getByText(/This operator request is unconfirmed/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Discard and leave" }),
  ).toBeNull();
  expect(run).not.toHaveBeenCalled();
  expect(
    JSON.parse(
      ownedStorage(sessionStorage, change.operation.owner).getItem(
        "operator-change:v1",
      )!,
    ),
  ).toEqual(change);
});

it("memory-only revocation remains retryable with its original intent after cancelled navigation", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  const run = vi
    .spyOn(api, "run")
    .mockRejectedValueOnce(
      new ApiError(0, "connection_failed", "Response lost"),
    )
    .mockResolvedValueOnce({
      operator_id: target.id,
      session_id: null,
      revoked: 1,
    });
  const router = navigationRouter();
  await user.type(
    await screen.findByLabelText("Revocation reason"),
    "Reviewed uncertain revocation",
  );
  await user.click(screen.getByRole("button", { name: "Revoke sessions" }));
  await screen.findByText(/Browser recovery is unavailable/);
  const original = run.mock.calls[0]![0];
  const application = screen.getByRole("link", {
    name: "Application",
  });
  await user.click(application);
  expect(router.state.location.search).toBe(
    "?view=operators&operator=op_qa_target",
  );
  expect(
    screen.queryByRole("button", { name: "Discard and leave" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Stay here" }));
  expect(document.activeElement).toBe(application);
  await user.click(
    screen.getByRole("button", { name: "Retry same operator request" }),
  );
  await screen.findByText("Session access revoked.");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0]).toEqual(original);
  expect(router.state.location.search).toBe(
    "?view=operators&operator=op_qa_target",
  );
  await user.click(
    screen.getByRole("link", { name: "Your sessions" }),
  );
  expect(router.state.location.search).toBe("?view=sessions");
});

it("a confirmed in-flight revocation cancels the blocked departure instead of navigating automatically", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let confirm!: (value: unknown) => void;
  const run = vi.spyOn(api, "run").mockImplementation(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const router = navigationRouter();
  await user.type(
    await screen.findByLabelText("Revocation reason"),
    "Reviewed in-flight revocation",
  );
  await user.click(screen.getByRole("button", { name: "Revoke sessions" }));
  await screen.findByRole("button", { name: "Confirming…" });
  await user.click(
    screen.getByRole("link", { name: "Your sessions" }),
  );
  expect(
    screen.getByText(/This operator request is still in progress/),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Discard and leave" }),
  ).toBeNull();
  await act(async () => {
    confirm({ operator_id: target.id, session_id: null, revoked: 1 });
    await Promise.resolve();
  });
  await screen.findByText("Session access revoked.");
  expect(router.state.location.search).toBe(
    "?view=operators&operator=op_qa_target",
  );
  expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("link", { name: "Your sessions" }),
  );
  expect(router.state.location.search).toBe("?view=sessions");
});

it("expired revocation cannot leave until its outcome is explicitly inspected and acknowledged", async () => {
  const user = userEvent.setup();
  const change = storedRevocation(Date.now() - 24 * 3600_000);
  const run = vi.spyOn(api, "run");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const router = navigationRouter();
  await screen.findByRole("button", { name: "I inspected its outcome" });
  await user.click(
    screen.getByRole("link", { name: "Your sessions" }),
  );
  expect(router.state.location.search).toBe(
    "?view=operators&operator=op_qa_target",
  );
  expect(screen.getByText(/its retry window has ended/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Discard and leave" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Stay here" }));
  await user.click(
    screen.getByRole("button", { name: "I inspected its outcome" }),
  );
  expect(
    ownedStorage(sessionStorage, change.operation.owner).getItem(
      "operator-change:v1",
    ),
  ).toBeNull();
  expect(run).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("link", { name: "Your sessions" }),
  );
  expect(router.state.location.search).toBe("?view=sessions");
});
