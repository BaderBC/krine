import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { CredentialForm } from "./credential-form";
import type { Credential } from "./types";

const server: Credential = {
  id: "cred_server",
  kind: "server",
  label: "Application",
  source: "administrator",
  public_key: null,
  created_at: 123,
  revoked_at: null,
  revoked_by: null,
};
const secret = `sk_${"S".repeat(43)}`;
const revealed = { credential: server, secret, secret_status: "revealed" };
const recovered = {
  credential: server,
  secret: null,
  secret_status: "unrecoverable",
};
beforeEach(() => {
  sessionStorage.clear();
});
function client() {
  return { run: vi.fn() };
}

describe("credential mutation recovery", () => {
  it.each([
    null,
    undefined,
    {},
    { ...revealed, credential: { ...server, kind: "browser" } },
    { ...revealed, secret: null },
  ])(
    "preserves a malformed committed creation acknowledgement %#",
    async (response) => {
      const api = client();
      api.run.mockResolvedValueOnce(response).mockResolvedValueOnce(recovered);
      const form = new CredentialForm(api);
      await form.create("server", "Application");
      expect(form.getSnapshot().pending).not.toBeNull();
      expect(form.getSnapshot().busy).toBe(false);
      await form.retry();
      expect(api.run.mock.calls[1]![0]).toEqual(api.run.mock.calls[0]![0]);
      expect(form.getSnapshot().result).toEqual(recovered);
      expect(sessionStorage.length).toBe(0);
    },
  );
  it.each([401, 403, 408, 429, 503])(
    "keeps the same intent across a lost response and status %i, including reopening",
    async (status) => {
      const api = client();
      api.run.mockRejectedValueOnce(new ApiError(0, "lost", "lost"));
      const first = new CredentialForm(api);
      await first.create("server", "Application");
      first.dispose();
      const retry = new CredentialForm(api);
      api.run
        .mockRejectedValueOnce(new ApiError(status, "failure", "failure"))
        .mockResolvedValueOnce(recovered);
      await retry.retry();
      expect(retry.getSnapshot().pending).not.toBeNull();
      await retry.retry();
      expect(api.run.mock.calls.map(([op]) => op)).toEqual(
        Array(3).fill(api.run.mock.calls[0]![0]),
      );
      expect(retry.getSnapshot().result?.secret_status).toBe("unrecoverable");
    },
  );
  it("persists the intent before dispatch, prevents double submission, and never persists a returned secret", async () => {
    let finish!: (value: unknown) => void;
    const api = client();
    api.run.mockImplementation(() => {
      expect(sessionStorage.getItem("krine:credential-mutation:v1")).toContain(
        '"label":"Application"',
      );
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const form = new CredentialForm(api);
    const saving = form.create("server", "Application");
    await form.create("server", "duplicate");
    await form.retry();
    expect(api.run).toHaveBeenCalledTimes(1);
    finish(revealed);
    await saving;
    expect(sessionStorage.length).toBe(0);
    expect(form.getSnapshot().result?.secret).toBe(secret);
    form.dismiss();
    expect(JSON.stringify(form.getSnapshot())).not.toContain(secret);
  });
  it("does not let a response from an unmounted form remove another form's recovery", async () => {
    let finish!: (value: unknown) => void;
    const api = client();
    api.run.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const old = new CredentialForm(api);
    const saving = old.create("server", "Application");
    old.dispose();
    const current = new CredentialForm(api);
    finish(revealed);
    await saving;
    expect(new CredentialForm(api).getSnapshot().pending).toEqual(
      current.getSnapshot().pending,
    );
    api.run.mockResolvedValueOnce(recovered);
    await current.retry();
    expect(current.getSnapshot().result?.secret_status).toBe("unrecoverable");
  });
  it("recovers current revoked metadata without presenting it as usable", async () => {
    const api = client();
    api.run.mockResolvedValueOnce({
      ...recovered,
      credential: { ...server, revoked_at: 234, revoked_by: "administrator" },
    });
    const form = new CredentialForm(api);
    await form.create("server", "Application");
    expect(form.getSnapshot().result?.credential.revoked_at).toBe(234);
    expect(form.getSnapshot().result?.secret).toBeNull();
  });
  it("removes the visible secret after a refreshed record confirms revocation elsewhere", async () => {
    const api = client();
    api.run.mockResolvedValueOnce(revealed);
    const form = new CredentialForm(api);
    await form.create("server", "Application");
    form.observe([{ ...server, revoked_at: 234, revoked_by: "administrator" }]);
    expect(form.getSnapshot().result?.secret).toBeNull();
    expect(form.getSnapshot().result?.credential.revoked_at).toBe(234);
  });
  it("keeps an ambiguous revocation until the exact revoked credential is acknowledged", async () => {
    const api = client();
    api.run
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce({
        ...server,
        id: "cred_other",
        revoked_at: 234,
        revoked_by: "administrator",
      })
      .mockResolvedValueOnce({
        ...server,
        revoked_at: 234,
        revoked_by: "administrator",
      });
    const form = new CredentialForm(api);
    await form.revoke(server);
    await form.retry();
    expect(form.getSnapshot().pending?.id).toBe(server.id);
    await form.retry();
    expect(form.getSnapshot().pending).toBeNull();
    expect(api.run.mock.calls.map(([op]) => op)).toEqual(
      Array(3).fill(api.run.mock.calls[0]![0]),
    );
  });
  it("retains a safe in-memory retry when browser storage is blocked", async () => {
    const storage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const api = client();
    api.run
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(recovered);
    const form = new CredentialForm(api, storage);
    await form.create("server", "Application");
    await form.retry();
    expect(form.getSnapshot().storageUnavailable).toBe(true);
    expect(api.run.mock.calls[0]![0]).toEqual(api.run.mock.calls[1]![0]);
  });
  it("never replays an expired creation intent after the backend's retention window", async () => {
    const api = client();
    api.run.mockRejectedValueOnce(new Error("lost"));
    const form = new CredentialForm(api);
    await form.create("server", "Application");
    const text = JSON.parse(
      sessionStorage.getItem("krine:credential-mutation:v1")!,
    );
    text.startedAt = Date.now() - 24 * 60 * 60 * 1000;
    sessionStorage.setItem(
      "krine:credential-mutation:v1",
      JSON.stringify(text),
    );
    const reopened = new CredentialForm(api);
    await reopened.retry();
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(reopened.getSnapshot().expired).toBe(true);
    reopened.acknowledgeExpired();
    expect(reopened.getSnapshot().pending).toBeNull();
  });
  it("rejects recovery records aimed at other admin endpoints", () => {
    sessionStorage.setItem(
      "krine:credential-mutation:v1",
      JSON.stringify({
        operation: {
          method: "POST",
          path: "/providers/verification",
          key: crypto.randomUUID(),
          body: {},
        },
        startedAt: Date.now(),
        kind: "server",
        label: "Application",
        id: "cred_other",
      }),
    );
    const api = client();
    const form = new CredentialForm(api);
    expect(form.getSnapshot().pending).toBeNull();
    expect(form.getSnapshot().error).toBeTruthy();
    expect(api.run).not.toHaveBeenCalled();
  });
});

it("retains known revocation across pages, stale active rows, dismissal and delayed acknowledgements", async () => {
  const api = client();
  let finish!: (value: unknown) => void;
  api.run.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const form = new CredentialForm(api);
  const sending = form.create("server", "Application");
  const revoked: Credential = {
    ...server,
    revoked_at: 234,
    revoked_by: "administrator",
  };
  form.observe([revoked]);
  form.observe([]);
  form.observe([server]);
  finish(revealed);
  await sending;
  expect(form.getSnapshot().result).toEqual({
    credential: revoked,
    secret: null,
    secret_status: "not_applicable",
  });
  expect(form.currentCredential(server)).toEqual(revoked);
  form.dismiss();
  form.observe([server]);
  api.run.mockResolvedValueOnce(revealed);
  await form.create("server", "Application");
  expect(form.getSnapshot().result?.secret).toBeNull();
  expect(form.getSnapshot().result?.credential.revoked_at).toBe(234);
});

it("does not reconcile unrelated IDs into a pending creation or repeatedly update a resolved result", async () => {
  const api = client();
  let finish!: (value: unknown) => void;
  api.run.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const form = new CredentialForm(api);
  const sending = form.create("server", "Application");
  const pending = form.getSnapshot().pending;
  const persisted = sessionStorage.getItem("krine:credential-mutation:v1");
  const unrelated: Credential = {
    ...server,
    id: "cred_unrelated",
    revoked_at: 234,
    revoked_by: "administrator",
  };
  form.observe([unrelated]);
  expect(form.getSnapshot().pending).toBe(pending);
  expect(sessionStorage.getItem("krine:credential-mutation:v1")).toBe(
    persisted,
  );
  finish(revealed);
  await sending;
  expect(form.getSnapshot().result?.secret).toBe(secret);
  const changed = vi.fn();
  form.subscribe(changed);
  form.observe([unrelated, server]);
  expect(changed).not.toHaveBeenCalled();
  form.observe([{ ...server, revoked_at: 345, revoked_by: "administrator" }]);
  expect(changed).toHaveBeenCalledTimes(1);
  form.observe([server]);
  form.observe([]);
  form.observe([{ ...server, revoked_at: 345, revoked_by: "administrator" }]);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(form.getSnapshot().result?.secret).toBeNull();
});
