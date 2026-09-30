import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import type { Mutation } from "./api";
import { ProviderForm } from "./provider-form";
import type { ProviderTest } from "./provider-form";
import type { Provider, Version } from "./types";

export function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    capability: "verification",
    provider: "turnstile",
    enabled: false,
    revision: 0,
    config: {},
    has_secret: false,
    status: "unconfigured",
    message: "Provider is not configured.",
    checked_at: null,
    dependent_checks: [],
    dependent_versions: [],
    dependents_token: "empty",
    ...overrides,
  };
}
function testResult(overrides: Partial<ProviderTest> = {}): ProviderTest {
  return {
    status: "configuration_checked",
    checked_at: Date.now(),
    message: "Live pairing has not been tested.",
    test_token: "pt_test",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const version: Version = {
  version: 3,
  published_at: 1,
  policy: { schema_version: 1, inputs: {}, rules: [], otherwise: "DENY" },
};
let current: Provider;
beforeEach(() => {
  current = provider();
  vi.spyOn(api, "get").mockImplementation(
    async <T>(path: string): Promise<T> => {
      if (path === "/providers")
        return { items: [structuredClone(current)] } as T;
      if (path === "/lookup/checks/versions/3?name=can_claim")
        return version as T;
      throw new Error(`Unexpected read ${path}`);
    },
  );
});
afterEach(() => vi.restoreAllMocks());
function form() {
  const model = new ProviderForm(current);
  model.edit({ siteKey: "site_key", secret: "sensitive_candidate" });
  return model;
}
async function tested(model: ProviderForm) {
  vi.spyOn(api, "run").mockResolvedValue(testResult());
  await model.test();
}

describe("provider candidate and mutation ownership", () => {
  it("activates the exact tested candidate against reviewed immutable policies, then clears secrets", async () => {
    current = provider({
      revision: 2,
      enabled: true,
      has_secret: true,
      config: { site_key: "old_site" },
      dependent_checks: ["can_claim"],
      dependent_versions: [{ check: "can_claim", version: 3 }],
      dependents_token: "can_claim_v3",
    });
    const model = form();
    const run = vi
      .spyOn(api, "run")
      .mockImplementation(async <T>(operation: Mutation): Promise<T> => {
        if (operation.path.endsWith("/tests")) return testResult() as T;
        current = {
          ...current,
          revision: 3,
          config: { site_key: "site_key" },
          status: "configuration_checked",
        };
        return current as T;
      });
    await model.test();
    await model.review(true);
    expect(model.getSnapshot().review?.checks[0]?.version.version).toBe(3);
    await model.save();
    expect(run.mock.calls[1]![0].body).toEqual({
      revision: 2,
      provider: "turnstile",
      enabled: true,
      config: { site_key: "site_key", secret: "sensitive_candidate" },
      test_token: "pt_test",
      acknowledge_dependents: true,
      reviewed_dependents_token: "can_claim_v3",
    });
    expect(model.getSnapshot().fields.secret).toBe("");
    expect(model.getSnapshot().pending).toBeNull();
    expect(model.getSnapshot().notice).toBe(
      "Configuration saved for new attempts.",
    );
    expect(model.dirty).toBe(false);
  });
  it("does not authorize an edited candidate with a late successful test", async () => {
    const result = deferred<ProviderTest>();
    vi.spyOn(api, "run").mockReturnValue(result.promise);
    const model = form();
    const testing = model.test();
    model.edit({ secret: "new_sensitive_candidate" });
    result.resolve(testResult());
    await testing;
    expect(model.getSnapshot().test).toBeNull();
    expect(model.tested).toBe(false);
    await model.review(true);
    expect(model.getSnapshot().review).toBeNull();
  });
  it("ignores an older failed test after a newer candidate succeeded", async () => {
    const old = deferred<ProviderTest>();
    vi.spyOn(api, "run")
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(testResult({ test_token: "pt_new" }));
    const model = form();
    const first = model.test();
    model.edit({ siteKey: "new_site" });
    await model.test();
    old.reject(new ApiError(409, "revision_conflict", "Old conflict"));
    await first;
    expect(model.getSnapshot().test?.test_token).toBe("pt_new");
    expect(model.getSnapshot().conflict).toBe(false);
  });
  it.each(["ready", "configuration_checked"])(
    "accepts %s without converting a limited test to a live-pairing claim",
    async (status) => {
      const model = form();
      vi.spyOn(api, "run").mockResolvedValue(testResult({ status }));
      await model.test();
      expect(model.tested).toBe(true);
      expect(model.getSnapshot().test?.message).toContain("not been tested");
    },
  );
  it.each(["invalid", "unavailable"])(
    "cannot save after an unsuccessful %s test",
    async (status) => {
      const model = form();
      vi.spyOn(api, "run").mockResolvedValue(
        testResult({ status, test_token: null }),
      );
      await model.test();
      await model.review(true);
      await model.save();
      expect(model.getSnapshot().review).toBeNull();
      expect(api.run).toHaveBeenCalledTimes(1);
    },
  );
  it("expires activation permission before review and before save", async () => {
    const model = form();
    vi.spyOn(api, "run").mockResolvedValue(
      testResult({ checked_at: Date.now() - 600_001 }),
    );
    await model.test();
    await model.review(true);
    expect(model.getSnapshot().review).toBeNull();
    vi.mocked(api.run).mockResolvedValue(testResult());
    await model.test();
    await model.review(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
    await model.save();
    expect(api.run).toHaveBeenCalledTimes(2);
    expect(model.getSnapshot().error).toContain("expired");
  });
  it("freezes an ambiguous save and recovers its original result even after test expiry", async () => {
    const model = form();
    await tested(model);
    await model.review(true);
    const saved = provider({
      revision: 1,
      enabled: true,
      config: { site_key: "site_key" },
      has_secret: true,
    });
    vi.mocked(api.run).mockRejectedValueOnce(
      new ApiError(0, "connection_failed", "lost"),
    );
    await model.save();
    const pending = model.getSnapshot().pending;
    model.edit({ secret: "must_not_replace" });
    expect(model.getSnapshot().fields.secret).toBe("sensitive_candidate");
    current = provider({
      revision: 2,
      enabled: false,
      config: { site_key: "newer_site" },
      has_secret: true,
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
    vi.mocked(api.run).mockResolvedValueOnce(saved);
    await model.save();
    expect(vi.mocked(api.run).mock.calls.at(-1)![0]).toEqual(pending);
    expect(model.getSnapshot().server.revision).toBe(2);
    expect(model.getSnapshot().fields.siteKey).toBe("newer_site");
    expect(model.getSnapshot().notice).toContain(
      "replaced by a newer configuration",
    );
  });
  it("serializes duplicate save clicks", async () => {
    const model = form();
    await tested(model);
    await model.review(true);
    const result = deferred<Provider>();
    vi.mocked(api.run).mockReturnValueOnce(result.promise);
    const saving = model.save();
    await model.save();
    expect(api.run).toHaveBeenCalledTimes(2);
    current = provider({ revision: 1, enabled: true });
    result.resolve(current);
    await saving;
  });
  it("clears secret memory after acknowledgement even if refreshing current state fails", async () => {
    const model = form();
    await tested(model);
    await model.review(true);
    vi.mocked(api.run).mockResolvedValueOnce(
      provider({ revision: 1, enabled: true }),
    );
    vi.mocked(api.get).mockRejectedValueOnce(new Error("unavailable"));
    await model.save();
    expect(model.getSnapshot().fields.secret).toBe("");
    expect(model.getSnapshot().pending).toBeNull();
    expect(model.getSnapshot().needsRefresh).toBe(true);
    await model.save();
    expect(api.run).toHaveBeenCalledTimes(2);
    current = provider({ revision: 2, enabled: false });
    await model.refresh();
    expect(model.getSnapshot().server.revision).toBe(2);
    expect(model.getSnapshot().needsRefresh).toBe(false);
  });
  it("requires loading and explicitly reconciling a changed provider before retesting", async () => {
    const model = form();
    vi.spyOn(api, "run").mockRejectedValueOnce(
      new ApiError(409, "revision_conflict", "conflict"),
    );
    await model.test();
    model.reconcile(true);
    expect(model.getSnapshot().conflict).toBe(true);
    current = provider({
      revision: 5,
      enabled: true,
      has_secret: true,
      config: { site_key: "latest_site" },
    });
    await model.refresh();
    expect(model.getSnapshot().fields.siteKey).toBe("site_key");
    expect(model.getSnapshot().conflict).toBe(true);
    model.reconcile(true);
    expect(model.candidate().revision).toBe(5);
    expect(model.getSnapshot().fields.secret).toBe("sensitive_candidate");
    expect(model.tested).toBe(false);
  });
  it("preserves tested input after dependency conflict, then uses a new mutation for the new reviewed set", async () => {
    const model = form();
    await tested(model);
    await model.review(true);
    vi.mocked(api.run).mockRejectedValueOnce(
      new ApiError(409, "dependent_checks_changed", "changed"),
    );
    await model.save();
    const first = vi.mocked(api.run).mock.calls.at(-1)![0];
    expect(model.getSnapshot().pending).toBeNull();
    expect(model.tested).toBe(true);
    current = {
      ...current,
      dependent_checks: ["can_claim"],
      dependent_versions: [{ check: "can_claim", version: 3 }],
      dependents_token: "new_set",
    };
    await model.review(true);
    vi.mocked(api.run).mockResolvedValueOnce(
      provider({ revision: 1, enabled: true }),
    );
    await model.save();
    const second = vi.mocked(api.run).mock.calls.at(-1)![0];
    expect(second.key).not.toBe(first.key);
    expect(second.body).toMatchObject({
      reviewed_dependents_token: "new_set",
      test_token: "pt_test",
    });
  });
  it("blocks confirmation if a reviewed immutable policy cannot be loaded", async () => {
    current = provider({
      dependent_versions: [{ check: "missing", version: 4 }],
    });
    const model = form();
    await tested(model);
    await model.review(true);
    await model.save();
    expect(model.getSnapshot().review).toBeNull();
    expect(api.run).toHaveBeenCalledTimes(1);
  });
  it("does not present a different returned policy version as the reviewed version", async () => {
    current = provider({
      dependent_versions: [{ check: "can_claim", version: 3 }],
    });
    const model = form();
    await tested(model);
    vi.mocked(api.get)
      .mockResolvedValueOnce({ items: [current] })
      .mockResolvedValueOnce({ ...version, version: 2 });
    await model.review(true);
    expect(model.getSnapshot().review).toBeNull();
  });
  it("invalidates a review still loading when entered values change", async () => {
    const model = form();
    await tested(model);
    const result = deferred<{ items: Provider[] }>();
    vi.mocked(api.get).mockReturnValueOnce(result.promise);
    const reviewing = model.review(true);
    model.edit({ siteKey: "new_site" });
    result.resolve({ items: [current] });
    await reviewing;
    expect(model.getSnapshot().review).toBeNull();
    expect(model.getSnapshot().test).toBeNull();
  });
  it("disconnects the active configuration without sending unsaved replacement secrets", async () => {
    current = provider({
      revision: 4,
      enabled: true,
      has_secret: true,
      config: { site_key: "active_site" },
    });
    const model = form();
    await model.review(false);
    const run = vi.spyOn(api, "run").mockImplementation(async <
      T,
    >(): Promise<T> => {
      current = { ...current, revision: 5, enabled: false };
      return current as T;
    });
    await model.save();
    expect(run.mock.calls[0]![0].body).toEqual({
      revision: 4,
      provider: "turnstile",
      enabled: false,
      config: {},
      acknowledge_dependents: true,
      reviewed_dependents_token: "empty",
    });
  });
  it("distinguishes omitted and explicitly removed provider secrets", () => {
    const model = new ProviderForm(
      provider({
        capability: "ip_intelligence",
        provider: "proxycheck",
        has_secret: true,
      }),
    );
    expect(model.candidate().config).toEqual({});
    model.edit({ clearSecret: true });
    expect(model.candidate().config).toEqual({ secret: null });
  });
  it("never puts candidate secrets into browser storage or arbitrary exception messages", async () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const model = form();
    vi.spyOn(api, "run").mockRejectedValue(
      new Error("failure sensitive_candidate"),
    );
    await model.test();
    expect(model.getSnapshot().error).not.toContain("sensitive_candidate");
    expect(writes).not.toHaveBeenCalled();
  });
  it("does not apply a response to a detached form", async () => {
    const result = deferred<ProviderTest>();
    vi.spyOn(api, "run").mockReturnValue(result.promise);
    const model = form();
    const testing = model.test();
    model.dispose();
    result.resolve(testResult());
    await testing;
    expect(model.getSnapshot().test).toBeNull();
  });
});

describe("provider acknowledgement recovery", () => {
  it.each([401, 403, 408, 429])(
    "retains the exact ambiguous provider save across %i before replay lookup",
    async (status) => {
      const model = form();
      await tested(model);
      await model.review(true);
      vi.mocked(api.run).mockRejectedValueOnce(
        new ApiError(0, "connection_failed", "Lost committed response"),
      );
      await model.save();
      const pending = structuredClone(model.getSnapshot().pending);
      vi.mocked(api.run).mockRejectedValueOnce(
        new ApiError(status, "pre_handler_failure", "Not replayed"),
      );
      await model.save();
      expect(model.getSnapshot().pending).toEqual(pending);
      expect(model.getSnapshot().phase).toBe("idle");
      expect(model.locked).toBe(true);
      expect(model.getSnapshot().fields.secret).toBe("sensitive_candidate");
      current = provider({
        revision: 1,
        enabled: true,
        config: { site_key: "site_key" },
        has_secret: true,
      });
      vi.mocked(api.run).mockResolvedValueOnce(current);
      await model.save();
      expect(vi.mocked(api.run).mock.calls.at(-1)![0]).toEqual(pending);
      expect(model.getSnapshot().pending).toBeNull();
      expect(model.getSnapshot().fields.secret).toBe("");
    },
  );
  it.each([
    ["null", null],
    ["bodyless", undefined],
    ["empty", {}],
    ["incomplete", { revision: 1 }],
    [
      "wrong capability",
      provider({
        capability: "ip_intelligence",
        provider: "proxycheck",
        revision: 1,
        enabled: true,
      }),
    ],
    ["unchanged revision", provider({ revision: 0, enabled: true })],
    [
      "secret-bearing config",
      provider({
        revision: 1,
        enabled: true,
        config: { secret: "must_not_be_accepted" },
      }),
    ],
  ])(
    "keeps a %s save acknowledgement in an actionable same-save retry state",
    async (_label, malformed) => {
      const model = form();
      await tested(model);
      await model.review(true);
      vi.mocked(api.run).mockResolvedValueOnce(malformed);
      await expect(model.save()).resolves.toBeUndefined();
      const pending = structuredClone(model.getSnapshot().pending);
      expect(pending).not.toBeNull();
      expect(model.getSnapshot().phase).toBe("idle");
      expect(model.locked).toBe(true);
      expect(model.getSnapshot().fields.secret).toBe("sensitive_candidate");
      current = provider({
        revision: 1,
        enabled: true,
        config: { site_key: "site_key" },
        has_secret: true,
      });
      vi.mocked(api.run).mockResolvedValueOnce(current);
      await model.save();
      expect(vi.mocked(api.run).mock.calls.at(-1)![0]).toEqual(pending);
      expect(model.getSnapshot().pending).toBeNull();
      expect(model.locked).toBe(false);
      expect(model.getSnapshot().fields.secret).toBe("");
    },
  );
});

it("clears candidate and test secrets when an actor view is disposed", async () => {
  const model = new ProviderForm(provider());
  model.edit({ siteKey: "fixture_site", secret: "old_actor_secret" });
  vi.spyOn(api, "run").mockResolvedValue(testResult());
  await model.test();
  expect(model.getSnapshot().fields.secret).toBe("old_actor_secret");
  model.dispose();
  expect(model.getSnapshot().fields.secret).toBe("");
  expect(model.getSnapshot().test).toBeNull();
  expect(model.getSnapshot().pending).toBeNull();
});
