import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { api } from "./api";
import { DecisionRows } from "./Activity";
import { validReasonSummary } from "./CapturedReason";
import type { Decision, ReasonSummary } from "./types";
const original: ReasonSummary = {
  schema_version: 1,
  reason: "rule_matched",
  outcome: "DENY",
  scope: "decisive_rule",
  rule_id: "count",
  rules: [
    {
      rule_id: "count",
      position: 2,
      route: "deny",
      result: "true",
      compound: false,
      evidence: [
        {
          path: [],
          reference: {
            source: "metric",
            name: "client.user_count_30d",
            version: 1,
          },
          observed: { status: "known", value: 7 },
          observed_truncated: false,
          test: { op: "compare", comparison: "gt", value: 3 },
          test_truncated: false,
          result: "true",
          provenance: { source: "backend", observed_at: 1000 },
        },
      ],
      evidence_truncated: false,
    },
  ],
  rules_truncated: false,
  provider_revisions: {},
  truncated: false,
};
const base: Decision = {
  decision_id: "dec_one",
  operation_id: "op_one",
  check: "..",
  policy_version: 3,
  outcome: "DENY",
  reason: "rule_matched",
  accepted_at: 1000,
  completed_at: 2000,
  client_id: "cli_one",
  session_id: "ses_one",
  user_id: " user ",
  ip: "203.0.113.1",
  source: "evaluation",
};
const scope =
  "/activity?entity=+user+&entity_kind=user&from=100&to=200&cursor=older";
function mount(summary: unknown, change: Partial<Decision> = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/activity",
        element: (
          <DecisionRows
            items={[{ ...base, reason_summary: summary, ...change }]}
          />
        ),
      },
      { path: "/metrics/:name", element: <h1>Metric definition</h1> },
      { path: "/activity/decisions/:id", element: <h1>Recorded decision</h1> },
    ],
    { initialEntries: [scope] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders the captured metric value and version without reading current metrics, and keeps investigation scope", async () => {
  const get = vi.spyOn(api, "get");
  const router = mount(original);
  expect(screen.getByText("Rule 2 matched")).toBeTruthy();
  expect(document.querySelector(".captured-value")?.textContent).toContain(
    "= 7",
  );
  expect(screen.queryByText(/Captured test:/)).toBeNull();
  expect(get).not.toHaveBeenCalled();
  const metric = screen.getByRole("link", { name: "client.user_count_30d v1" });
  await userEvent.click(metric);
  expect(router.state.location.pathname).toBe("/metrics/client.user_count_30d");
  const params = new URLSearchParams(router.state.location.search);
  expect(params.get("version")).toBe("1");
  expect(params.get("return_to")).toBe(scope);
});
it("keeps original Unknown cause and accepts disabled provider revision zero without expanding provider detail", () => {
  const sample = structuredClone(original);
  sample.reason = "unknown_denied";
  sample.rules[0]!.result = "unknown";
  sample.rules[0]!.evidence[0]!.observed = {
    status: "unknown",
    reason: "provider_unconfigured",
  };
  sample.rules[0]!.evidence[0]!.result = "unknown";
  sample.provider_revisions = {
    ip_intelligence: { revision: 0, enabled: false },
  };
  mount(sample, { reason: "unknown_denied" });
  expect(screen.getByText("Rule 2 denied when unknown")).toBeTruthy();
  expect(document.querySelector(".captured-value")?.textContent).toContain(
    "Unknown: provider unconfigured",
  );
  expect(screen.queryByText(/Captured source:|ip intelligence/)).toBeNull();
});
it.each([
  "verification_required",
  "verification_failed",
  "verification_expired",
  "verification_unavailable",
])("keeps %s distinct from ordinary policy matching", (reason) => {
  const sample = structuredClone(original);
  sample.reason = reason;
  sample.outcome =
    reason === "verification_required" ? "CHALLENGE_REQUIRED" : "DENY";
  sample.rules[0]!.route =
    reason === "verification_required" ? "challenge" : reason;
  sample.provider_revisions.verification = { revision: 4, enabled: true };
  mount(sample, { reason, outcome: sample.outcome });
  expect(
    screen.getByText(`Rule 2 · ${reason.replaceAll("_", " ")}`),
  ).toBeTruthy();
  expect(screen.queryByText("Rule 2 matched")).toBeNull();
  expect(screen.queryByText(/verification revision 4/)).toBeNull();
});
it("keeps Otherwise continuation compact without presenting a previous rule's leaf as the final reason", async () => {
  const sample = structuredClone(original);
  sample.scope = "otherwise";
  sample.rule_id = null;
  sample.reason = "otherwise";
  sample.outcome = "ALLOW";
  sample.rules[0]!.compound = true;
  sample.rules[0]!.route = "verification_passed";
  sample.rules[0]!.evidence_truncated = true;
  sample.rules_truncated = true;
  sample.truncated = true;
  const router = mount(sample, { reason: "otherwise", outcome: "ALLOW" });
  expect(
    screen.getByText("Otherwise · verification passed, then continued"),
  ).toBeTruthy();
  expect(screen.getByText("Partial captured path.")).toBeTruthy();
  expect(document.querySelector(".captured-value")).toBeNull();
  expect(
    screen.queryByText(/Captured source:|Captured test:|revision/),
  ).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: "Allow" }));
  expect(router.state.location.pathname).toBe("/activity/decisions/dec_one");
  expect(
    new URLSearchParams(router.state.location.search).get("return_to"),
  ).toBe(scope);
});
it("marks observed and test previews and safely renders hostile captured string values", () => {
  const sample = structuredClone(original);
  const leaf = sample.rules[0]!.evidence[0]!;
  const hostile = '<img src=x onerror="alert(1)">';
  leaf.reference = { source: "input", name: "text" };
  leaf.observed = { status: "known", value: hostile };
  leaf.observed_truncated = true;
  leaf.test = { op: "in", values: [hostile, "other", "third"] };
  leaf.test_truncated = true;
  sample.truncated = true;
  mount(sample);
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain(hostile);
  expect(document.body.textContent).toContain("(preview)");
  expect(screen.queryByText(/Captured test:/)).toBeNull();
  expect(screen.getByText(/Partial captured sample/)).toBeTruthy();
});
it.each([{ op: "between", min: 1, max: 8 }, { op: "known" }] as const)(
  "accepts the captured %s test while keeping its full comparison in decision detail",
  (test) => {
    const sample = structuredClone(original);
    sample.rules[0]!.evidence[0]!.test = test;
    mount(sample);
    expect(validReasonSummary(sample, base)).toBe(true);
    expect(screen.queryByText(/Captured test:/)).toBeNull();
    expect(screen.getByRole("link", { name: "Deny" })).toBeTruthy();
  },
);
it("does not call an empty Otherwise policy a matched rule", () => {
  mount(
    {
      ...original,
      scope: "otherwise",
      rule_id: null,
      rules: [],
      reason: "otherwise",
    },
    { reason: "otherwise" },
  );
  expect(screen.getByText("Otherwise · no rules")).toBeTruthy();
  expect(screen.queryByText(/Rule 2/)).toBeNull();
});
it.each([
  { rules_truncated: true, truncated: true },
  { rules_truncated: false, truncated: true },
  { rules_truncated: true, truncated: false },
])(
  "does not claim no rules for an empty truncated Otherwise sample %j",
  (flags) => {
    const sample: ReasonSummary = {
      ...original,
      scope: "otherwise",
      rule_id: null,
      rules: [],
      reason: "otherwise",
      ...flags,
    };
    expect(validReasonSummary(sample, sample)).toBe(false);
    mount(sample, { reason: "otherwise" });
    expect(
      screen.getByText(/Captured reason summary could not be read/),
    ).toBeTruthy();
    expect(screen.queryByText("Otherwise · no rules")).toBeNull();
  },
);
it.each([null, undefined])(
  "labels legacy summary %s as unrecorded without replacing its reason",
  (summary) => {
    mount(summary);
    expect(
      screen.getByText(
        "rule matched · Captured evidence summary not recorded.",
      ),
    ).toBeTruthy();
  },
);
it.each([
  {},
  { ...original, outcome: "ALLOW" },
  { ...original, reason: "otherwise" },
  { ...original, rule_id: "wrong" },
  {
    ...original,
    rules: [
      {
        ...original.rules[0],
        evidence: [
          {
            ...original.rules[0]!.evidence[0],
            observed: { status: "known", value: {} },
          },
        ],
      },
    ],
  },
  {
    ...original,
    rules: [
      {
        ...original.rules[0],
        evidence: [
          {
            ...original.rules[0]!.evidence[0],
            test: { op: "compare", comparison: "mystery", value: 3 },
          },
        ],
      },
    ],
  },
  { ...original, rules: [{ ...original.rules[0], evidence: [] }] },
  {
    ...original,
    provider_revisions: { verification: { revision: -1, enabled: true } },
  },
])(
  "rejects malformed/mismatched summary %# without crashing the row or fabricating values",
  (summary) => {
    mount(summary);
    expect(
      screen.getByText(/Captured reason summary could not be read/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Deny" })).toBeTruthy();
    expect(document.querySelector(".captured-value")).toBeNull();
  },
);
it("bounds input size and evidence before rendering", () => {
  const sample = structuredClone(original);
  sample.rules[0]!.evidence = Array(5).fill(sample.rules[0]!.evidence[0]);
  expect(validReasonSummary(sample, base)).toBe(false);
  expect(
    validReasonSummary(
      { ...original, rules: Array(4).fill(original.rules[0]) },
      base,
    ),
  ).toBe(false);
});

it.each([true, false, ["true"]])(
  "rejects coerced leaf truth %j instead of displaying the opposite result",
  (result) => {
    const sample = structuredClone(original) as unknown as {
      rules: { evidence: { result: unknown }[] }[];
    };
    sample.rules[0]!.evidence[0]!.result = result;
    mount(sample);
    expect(
      screen.getByText(/Captured reason summary could not be read/),
    ).toBeTruthy();
  },
);

it.each([
  [
    "Unknown cannot allow",
    (sample: ReasonSummary) => {
      sample.reason = "unknown_denied";
      sample.outcome = "ALLOW";
    },
  ],
  [
    "Otherwise cannot require verification",
    (sample: ReasonSummary) => {
      sample.scope = "otherwise";
      sample.rule_id = null;
      sample.rules = [];
      sample.reason = "verification_required";
      sample.outcome = "CHALLENGE_REQUIRED";
    },
  ],
  [
    "decisive rule cannot be Otherwise",
    (sample: ReasonSummary) => {
      sample.reason = "otherwise";
    },
  ],
  [
    "continuation is not a matched decisive rule",
    (sample: ReasonSummary) => {
      sample.rules[0]!.route = "next";
      sample.rules[0]!.result = "false";
    },
  ],
  [
    "unsupported reason is not a match",
    (sample: ReasonSummary) => {
      sample.reason = "unrecognized_future_reason";
    },
  ],
] as const)("rejects impossible captured metadata: %s", (_name, change) => {
  const sample = structuredClone(original);
  change(sample);
  expect(validReasonSummary(sample, sample)).toBe(false);
  mount(sample, { reason: sample.reason, outcome: sample.outcome });
  expect(
    screen.getByText(/Captured reason summary could not be read/),
  ).toBeTruthy();
  expect(screen.queryByText(/Rule 2 matched|denied when unknown/)).toBeNull();
});

it.each([
  ["rule_matched", "ALLOW", "allow", "true"],
  ["rule_matched", "DENY", "deny", "true"],
  ["unknown_denied", "DENY", "deny", "unknown"],
  ["verification_required", "CHALLENGE_REQUIRED", "challenge", "true"],
  ["verification_required", "CHALLENGE_REQUIRED", "challenge", "unknown"],
  ["verification_failed", "DENY", "verification_failed", "true"],
  ["verification_failed", "DENY", "verification_failed", "unknown"],
  ["verification_expired", "DENY", "verification_expired", "true"],
  ["verification_expired", "DENY", "verification_expired", "unknown"],
  ["verification_unavailable", "DENY", "verification_unavailable", "true"],
  ["verification_unavailable", "DENY", "verification_unavailable", "unknown"],
] as const)(
  "accepts evaluator route %s %s %s %s and rejects inconsistent metadata",
  (reason, outcome, route, result) => {
    const sample = structuredClone(original);
    sample.reason = reason;
    sample.outcome = outcome;
    sample.rules[0]!.route = route;
    sample.rules[0]!.result = result;
    expect(validReasonSummary(sample, sample)).toBe(true);
    for (const wrongOutcome of [
      "ALLOW",
      "DENY",
      "CHALLENGE_REQUIRED",
    ] as const) {
      if (wrongOutcome !== outcome) {
        const invalid = { ...sample, outcome: wrongOutcome };
        expect(validReasonSummary(invalid, invalid)).toBe(false);
      }
    }
    sample.rules[0]!.result = "false";
    expect(validReasonSummary(sample, sample)).toBe(false);
  },
);

it.each([
  ["next", "false", true],
  ["next", "unknown", true],
  ["verification_passed", "true", true],
  ["verification_passed", "unknown", true],
  ["next", "true", false],
  ["verification_passed", "false", false],
  ["allow", "true", false],
  ["deny", "true", false],
  ["challenge", "unknown", false],
] as const)(
  "validates Otherwise continuation %s %s as %s",
  (route, result, valid) => {
    const sample = structuredClone(original);
    sample.reason = "otherwise";
    sample.scope = "otherwise";
    sample.rule_id = null;
    sample.rules[0]!.route = route;
    sample.rules[0]!.result = result;
    expect(validReasonSummary(sample, sample)).toBe(valid);
  },
);

it("preserves a true compound rule with a false sampled leaf without treating the sample as the whole condition", () => {
  const sample = structuredClone(original);
  sample.rules[0]!.compound = true;
  sample.rules[0]!.evidence[0]!.result = "false";
  sample.rules[0]!.evidence[0]!.test = {
    op: "compare",
    comparison: "gt",
    value: 10,
  };
  sample.rules[0]!.evidence_truncated = true;
  sample.truncated = true;
  mount(sample);
  expect(screen.getByText("Rule 2 matched")).toBeTruthy();
  expect(
    screen.getByText("Partial compound sample; see full condition."),
  ).toBeTruthy();
  expect(screen.queryByText(/could not be read/)).toBeNull();
});

it("retains exact long check and subject links without abbreviating their identifiers", () => {
  const user = `user_${"a".repeat(123)}`;
  const check = `check_${"b".repeat(122)}`;
  mount(original, { user_id: user, check });
  expect(screen.getByRole("link", { name: user }).getAttribute("href")).toBe(
    `/inspect/entity?kind=user&id=${user}&return_to=${encodeURIComponent(scope)}`,
  );
  expect(screen.getByRole("link", { name: check }).getAttribute("href")).toBe(
    `/inspect/check?name=${check}&return_to=${encodeURIComponent(scope)}`,
  );
});
