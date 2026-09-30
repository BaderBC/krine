import { operatorStorage } from "./operator-test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  RelationshipForm,
  validReason,
  validRelationshipDetail,
  validRelationshipSummary,
  validRelationships,
} from "./relationship-form";
import type { Relationship } from "./types";

const original: Relationship = {
  id: "association_one",
  kind: "backend",
  client_id: "cli_one",
  session_id: "ses_one",
  user_id: "user_one",
  ip: null,
  first_seen: 100,
  last_seen: 100,
  source: "backend",
  credential_id: "cred_one",
  last_credential_id: "cred_one",
  first_source: "backend",
  last_source: "backend",
  first_event_id: null,
  last_event_id: null,
  revision: 1,
  revoked_at: null,
  revocation_reason: null,
  revoked_by: null,
  metadata: { private: "not needed in recovery" },
};
const corrected: Relationship = {
  ...original,
  revision: 2,
  revoked_at: 200,
  revocation_reason: "Wrong account",
  revoked_by: "administrator",
};
const observed: Relationship = {
  ...original,
  id: "ip_observation",
  kind: "observed_ip",
  user_id: null,
  ip: "192.0.2.2",
  source: "browser_observation",
  first_source: "browser.context",
  last_source: "browser.context",
};
const receipt = {
  relationship: corrected,
  audit_id: "audit_one",
  recalculation: "complete",
};
beforeEach(() => {
  sessionStorage.clear();
});

describe("reviewed relationship request recovery", () => {
  it.each([401, 403, 408, 429, 503])(
    "replays the exact request after lost acknowledgement, reload and %i",
    async (status) => {
      const client = {
        run: vi.fn().mockRejectedValueOnce(new ApiError(0, "lost", "lost")),
      };
      const model = new RelationshipForm(client);
      await model.submit(original, "correct", "Wrong account");
      const intent = client.run.mock.calls[0]![0];
      expect(intent.body).toEqual({ revision: 1, reason: "Wrong account" });
      expect(
        operatorStorage.getItem("krine:relationship-mutation:v1"),
      ).not.toContain("not needed in recovery");
      model.dispose();
      const recovered = new RelationshipForm(client);
      client.run
        .mockRejectedValueOnce(
          new ApiError(status, "unavailable", "unavailable"),
        )
        .mockResolvedValueOnce(receipt);
      await recovered.retry();
      expect(recovered.getSnapshot().pending).not.toBeNull();
      await recovered.submit(
        { ...original, revision: 7 },
        "correct",
        "Different reason",
      );
      await recovered.retry();
      expect(client.run.mock.calls.map(([operation]) => operation)).toEqual([
        intent,
        intent,
        intent,
      ]);
      expect(recovered.getSnapshot().receipt).toEqual(receipt);
      expect(sessionStorage.length).toBe(0);
    },
  );
  it.each([
    null,
    {},
    { ...receipt, recalculation: "pending" },
    { ...receipt, relationship: { ...corrected, revision: 7 } },
    { ...receipt, relationship: { ...corrected, user_id: "other" } },
    { ...receipt, relationship: { ...corrected, revoked_at: null } },
    { ...receipt, relationship: { ...corrected, first_source: ["backend"] } },
    { ...receipt, relationship: { ...corrected, last_source: ["backend"] } },
  ])(
    "keeps ambiguous malformed acknowledgement %# retryable",
    async (response) => {
      const client = {
        run: vi
          .fn()
          .mockResolvedValueOnce(response)
          .mockResolvedValueOnce(receipt),
      };
      const model = new RelationshipForm(client);
      await model.submit(original, "correct", "Wrong account");
      expect(model.getSnapshot().pending).not.toBeNull();
      await model.retry();
      expect(client.run.mock.calls[1]![0]).toEqual(
        client.run.mock.calls[0]![0],
      );
      expect(model.getSnapshot().receipt).toEqual(receipt);
    },
  );
  it.each([
    "revision_conflict",
    "relationship_state_conflict",
    "relationship_active",
    "input_conflict",
  ])("does not silently adopt a new revision after %s", async (code) => {
    const client = {
      run: vi.fn().mockRejectedValue(new ApiError(409, code, code)),
    };
    const model = new RelationshipForm(client);
    await model.submit(corrected, "restore", "Reviewed original evidence");
    expect(model.getSnapshot().pending).toBeNull();
    expect(model.getSnapshot().conflict).toBe(true);
    await model.retry();
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });
  it("persists before dispatch and coalesces duplicate confirmation and retry", async () => {
    let finish!: (value: unknown) => void;
    const client = {
      run: vi.fn().mockImplementation(() => {
        expect(
          JSON.parse(operatorStorage.getItem("krine:relationship-mutation:v1")!)
            .operation.body,
        ).toEqual({ revision: 1, reason: "Wrong account" });
        return new Promise((resolve) => {
          finish = resolve;
        });
      }),
    };
    const model = new RelationshipForm(client);
    const sending = model.submit(original, "correct", "Wrong account");
    await model.submit(original, "correct", "Wrong account");
    await model.retry();
    expect(client.run).toHaveBeenCalledTimes(1);
    finish(receipt);
    await sending;
  });
  it("leaves persisted intent untouched when an unmounted request finishes", async () => {
    let finish!: (value: unknown) => void;
    const client = {
      run: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      ),
    };
    const model = new RelationshipForm(client);
    const sending = model.submit(original, "correct", "Wrong account");
    model.dispose();
    const recovered = new RelationshipForm(client);
    finish(receipt);
    await sending;
    expect(new RelationshipForm(client).getSnapshot().pending).toEqual(
      recovered.getSnapshot().pending,
    );
  });
  it("stops exact retries before backend replay expiry and requires reconciliation", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const client = {
      run: vi.fn().mockRejectedValue(new ApiError(0, "lost", "lost")),
    };
    const model = new RelationshipForm(client);
    await model.submit(original, "correct", "Wrong account");
    clock.mockReturnValue(now + 23 * 60 * 60 * 1000);
    await model.retry();
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().expired).toBe(true);
    model.acknowledgeExpired();
    expect(model.getSnapshot().pending).toBeNull();
    clock.mockRestore();
  });
  it("rejects a stored intent with altered endpoints or body without sending it", async () => {
    const client = {
      run: vi.fn().mockRejectedValue(new ApiError(0, "lost", "lost")),
    };
    await new RelationshipForm(client).submit(
      original,
      "correct",
      "Wrong account",
    );
    const saved = JSON.parse(
      operatorStorage.getItem("krine:relationship-mutation:v1")!,
    );
    saved.operation.path = "/credentials";
    operatorStorage.setItem(
      "krine:relationship-mutation:v1",
      JSON.stringify(saved),
    );
    const model = new RelationshipForm(client);
    await model.retry();
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().storageUnavailable).toBe(true);
  });
  it.each(["kind", "first_source", "last_source"] as const)(
    "refuses to replay persisted recovery with an array %s",
    async (field) => {
      const client = {
        run: vi.fn().mockRejectedValue(new ApiError(0, "lost", "lost")),
      };
      const model = new RelationshipForm(client);
      await model.submit(observed, "correct", "Wrong observation");
      const key = "krine:relationship-mutation:v1";
      const saved = JSON.parse(operatorStorage.getItem(key)!);
      saved.relationship[field] = [saved.relationship[field]];
      operatorStorage.setItem(key, JSON.stringify(saved));
      model.dispose();
      const recovered = new RelationshipForm(client);
      await recovered.retry();
      expect(recovered.getSnapshot().pending).toBeNull();
      expect(recovered.getSnapshot().storageUnavailable).toBe(true);
      expect(recovered.getSnapshot().error).toContain(
        "Request recovery could not be read",
      );
      expect(client.run).toHaveBeenCalledTimes(1);
    },
  );
});

it.each(["kind", "first_source", "last_source"] as const)(
  "rejects an array %s before displaying or submitting a relationship",
  async (field) => {
    // An IP observation must not become a backend-assertion destination through coercion.
    const malformed = { ...observed, [field]: ["backend"] };
    expect(validRelationshipSummary(malformed)).toBe(false);
    expect(validRelationships({ items: [malformed], next_cursor: null })).toBe(
      false,
    );
    expect(
      validRelationshipDetail({
        relationship: malformed,
        recalculation: "complete",
        audit: { items: [], next_cursor: null },
      }),
    ).toBe(false);
    const client = { run: vi.fn() };
    const model = new RelationshipForm(client);
    await model.submit(
      malformed as unknown as Relationship,
      "correct",
      "Wrong observation",
    );
    expect(client.run).not.toHaveBeenCalled();
    expect(model.getSnapshot().pending).toBeNull();
    expect(sessionStorage.length).toBe(0);
  },
);

it("validates the backend byte and control-character reason contract", () => {
  expect(validReason("é".repeat(256))).toBe(true);
  expect(validReason("é".repeat(257))).toBe(false);
  for (const reason of [
    "",
    " leading",
    "trailing ",
    "line\nbreak",
    "control\u0085char",
  ])
    expect(validReason(reason)).toBe(false);
});
it("accepts nullable legacy audit fields but rejects malformed source and history reads", () => {
  const value = {
    relationship: original,
    recalculation: "complete",
    audit: {
      items: [
        {
          id: "legacy",
          at: 10,
          action: "correct",
          reason: "Historical correction",
          actor: null,
          revision: null,
          relationship: null,
        },
      ],
      next_cursor: null,
    },
  };
  expect(validRelationshipDetail(value)).toBe(true);
  for (const invalid of [
    null,
    {},
    { ...value, relationship: null },
    { ...value, audit: { items: [null], next_cursor: null } },
  ])
    expect(validRelationshipDetail(invalid)).toBe(false);
});

it.each(["correct", "restore"] as const)(
  "keeps a legacy %s operation byte-for-byte on recovery",
  async (action) => {
    const run = vi.fn().mockRejectedValue(new ApiError(0, "lost", "Lost"));
    const model = new RelationshipForm({ run });
    await model.submit(
      action === "correct" ? original : corrected,
      action,
      "Reviewed original evidence",
    );
    const stored = JSON.parse(
      operatorStorage.getItem("krine:relationship-mutation:v1")!,
    );
    stored.operation.path = `/relationships/backend/association_one/${action === "correct" ? "corrections" : "restorations"}`;
    operatorStorage.setItem(
      "krine:relationship-mutation:v1",
      JSON.stringify(stored),
    );
    model.dispose();
    const replay = vi
      .fn()
      .mockRejectedValue(new ApiError(403, "csrf", "Reauthenticate"));
    const reopened = new RelationshipForm({ run: replay });
    await reopened.retry();
    expect(replay.mock.calls[0]![0]).toEqual(stored.operation);
    expect(reopened.getSnapshot().pending).toEqual(stored);
  },
);
it.each([".", ".."])(
  "keeps %s as a literal relationship selector through ambiguous correction recovery",
  async (id) => {
    const run = vi.fn().mockResolvedValue(null);
    const model = new RelationshipForm({ run });
    await model.submit({ ...original, id }, "correct", "Wrong account");
    const request = run.mock.calls[0]![0];
    expect(request.path).toBe(
      `/lookup/relationships/corrections?kind=backend&id=${id}`,
    );
    model.dispose();
    const reopened = new RelationshipForm({ run });
    await reopened.retry();
    expect(run.mock.calls[1]![0]).toEqual(request);
  },
);
