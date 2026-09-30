import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "./api";
import { readPolicy, readPolicyResponse } from "./policy-response";
import { authenticateFixture } from "./operator-test-fixtures";

const legacy = {
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
afterEach(() => vi.unstubAllGlobals());

describe("policy wire compatibility", () => {
  it("expands every serde default without changing the source document", () => {
    const rule = {
      id: "known",
      then: "ALLOW",
      condition: {
        op: "known",
        value: { source: "metric", name: "ip.risk", version: 1 },
      },
    };
    expect(readPolicy({ schema_version: 1 })).toEqual({
      schema_version: 1,
      inputs: {},
      rules: [],
      otherwise: "DENY",
    });
    expect(
      readPolicy({ schema_version: 1, rules: [rule] }).rules[0]!.on_unknown,
    ).toBe("DENY");
    expect(Object.hasOwn(rule, "on_unknown")).toBe(false);
    expect(readPolicy(legacy)).toEqual({ ...legacy, inputs: {} });
    expect(Object.hasOwn(legacy, "inputs")).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { schema_version: 2 },
    { schema_version: 1, inputs: null },
    { schema_version: 1, inputs: [] },
    { schema_version: 1, rules: null },
    { schema_version: 1, otherwise: null },
    { schema_version: 1, otherwise: ["ALLOW"] },
    { schema_version: 1, otherwise: "UNKNOWN" },
    { ...legacy, surprise: true },
    { ...legacy, rules: [null] },
    { ...legacy, rules: [{ ...legacy.rules[0], on_unknown: null }] },
    { ...legacy, rules: [{ ...legacy.rules[0], then: ["ALLOW"] }] },
    {
      ...legacy,
      rules: [
        { ...legacy.rules[0], condition: { op: "not", condition: null } },
      ],
    },
    {
      ...legacy,
      rules: [
        {
          ...legacy.rules[0],
          condition: { ...legacy.rules[0]!.condition, comparison: ["gte"] },
        },
      ],
    },
    {
      ...legacy,
      rules: [
        {
          ...legacy.rules[0],
          condition: { ...legacy.rules[0]!.condition, value: null },
        },
      ],
    },
  ])("rejects malformed values instead of defaulting them: %j", (value) => {
    expect(() => readPolicy(value)).toThrow("Unreadable policy");
  });

  it.each([
    ["/lookup/checks?name=trial", "GET", { draft: legacy }, "draft"],
    ["/checks/trial", "GET", { draft: legacy }, "draft"],
    ["/checks", "POST", { draft: legacy }, "draft"],
    ["/lookup/checks/draft?name=trial", "PUT", { draft: legacy }, "draft"],
    [
      "/lookup/checks/restorations?name=trial",
      "POST",
      { draft: legacy },
      "draft",
    ],
    ["/checks/trial/publications", "POST", { policy: legacy }, "policy"],
    [
      "/lookup/checks/versions/1?name=trial",
      "GET",
      { policy: legacy },
      "policy",
    ],
    ["/activity/decisions/captured", "GET", { policy: legacy }, "policy"],
  ] as const)(
    "normalizes the known response %s",
    (path, method, value, key) => {
      expect(readPolicyResponse(path, method, value)).toEqual({
        [key]: { ...legacy, inputs: {} },
      });
      expect((value as Record<string, unknown>)[key]).toBe(legacy);
    },
  );

  it("normalizes versions but never visits arbitrary customer JSON", () => {
    expect(
      readPolicyResponse("/lookup/checks/versions?name=trial", "GET", {
        items: [{ policy: legacy }],
        next_cursor: null,
      }),
    ).toEqual({
      items: [{ policy: { ...legacy, inputs: {} } }],
      next_cursor: null,
    });
    const event = {
      properties: { policy: legacy, draft: { schema_version: 1 } },
    };
    expect(readPolicyResponse("/lookup/events?id=event", "GET", event)).toBe(
      event,
    );
    const decision = {
      policy: legacy,
      snapshot: { inputs: { policy: { schema_version: 1 } } },
    };
    expect(
      (
        readPolicyResponse(
          "/activity/decisions/captured",
          "GET",
          decision,
        ) as typeof decision
      ).snapshot,
    ).toBe(decision.snapshot);
  });

  it("an invalid successful acknowledgement retains the original mutation for retry", async () => {
    const client = new Api();
    authenticateFixture(client);
    const request = {
      path: "/lookup/checks/draft?name=trial",
      method: "PUT" as const,
      key: "original-key",
      owner: client.requireOwner(),
      body: { revision: 2, description: "Original", policy: legacy },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ draft: { ...legacy, inputs: null } })),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(client.run(request)).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(request.body);
    expect(request.body.policy).toBe(legacy);
  });
});
