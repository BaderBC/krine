import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { DraftController } from "./draft";
import { sessionFixture } from "./operator-test-fixtures";
import { ownedStorage } from "./operator";
import type { Check } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it("recovers an actor-bound save through malformed diagnostics, reauthentication and an omitted-default receipt", async () => {
  const legacy = {
    name: "legacy_trial",
    description: "Original description",
    active_version: 1,
    draft_revision: 1,
    has_draft_changes: false,
    updated_at: 1,
    draft: { schema_version: 1 },
  };
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(legacy))
    .mockResolvedValueOnce(
      response({ error: { code: "invalid_input", message: "Invalid", details: {} } }, 422),
    )
    .mockResolvedValueOnce(
      response({ error: { code: "unauthenticated", message: "Sign in again." } }, 401),
    )
    .mockResolvedValueOnce(response({ ...sessionFixture(), csrf_token: "renewed_csrf" }))
    .mockResolvedValueOnce(
      response({ ...legacy, description: "Description only", draft_revision: 2 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const check = await api.get<Check>("/lookup/checks?name=legacy_trial");
  expect(check.draft).toEqual({ schema_version: 1, inputs: {}, rules: [], otherwise: "DENY" });
  const model = new DraftController(api, check, sessionStorage);
  try {
    model.edit(check.draft, "Description only");
    await model.save();
    expect(model.state.status).toBe("failed");
    const storage = ownedStorage(sessionStorage, api.requireOwner());
    const pending = JSON.parse(storage.getItem("krine:draft:legacy_trial")!).intent;
    expect(pending.owner).toEqual(api.requireOwner());
    expect(pending.document.policy).toEqual(check.draft);

    model.edit(check.draft, "A later local description");
    await model.save();
    expect(api.suspended).toBe(true);
    expect(model.state.status).toBe("failed");
    await api.session({ sign_in_name: "fixture", credential: "saved_credential" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.parse(storage.getItem("krine:draft:legacy_trial")!).intent).toEqual(pending);
    await model.save();

    const attempts = [1, 2, 4].map((index) => fetcher.mock.calls[index]![1]!);
    for (const attempt of attempts) {
      expect(attempt.body).toBe(attempts[0]!.body);
      expect(attempt.headers).toMatchObject({
        "X-Krine-Operator-ID": pending.owner.actor_id,
        "Idempotency-Key": pending.key,
      });
    }
    expect(attempts[2]!.headers).toMatchObject({ "X-CSRF-Token": "renewed_csrf" });
    expect(model.state.server.draft_revision).toBe(2);
    expect(model.state.server.has_draft_changes).toBe(false);
    expect(model.state.description).toBe("A later local description");
    expect(model.state.status).toBe("changed");
    expect(JSON.parse(storage.getItem("krine:draft:legacy_trial")!).intent).toBeNull();
    expect(Object.hasOwn(legacy.draft, "inputs")).toBe(false);
  } finally {
    model.dispose();
  }
});
