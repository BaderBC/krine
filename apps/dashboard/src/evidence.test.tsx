import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, ApiError, readErrorMessage } from "./api";
import { DecisionPage, EntityPage } from "./Activity";
import type { DecisionDetail, Entity } from "./types";

const original: DecisionDetail = {
  decision_id: "decision",
  operation_id: "operation",
  check: "can_claim",
  policy_version: 1,
  outcome: "ALLOW",
  reason: "otherwise",
  accepted_at: 1000,
  completed_at: 1001,
  client_id: "client",
  session_id: "session",
  user_id: null,
  ip: "127.0.0.1",
  source: "evaluation",
  policy: {
    schema_version: 1,
    inputs: {},
    rules: [
      {
        id: "velocity",
        condition: {
          op: "compare",
          left: {
            source: "metric",
            name: "session.event_count_5m",
            version: 1,
          },
          comparison: "gte",
          value: 1,
        },
        then: "DENY",
        on_unknown: "NEXT",
      },
    ],
    otherwise: "ALLOW",
  },
  evaluation: {
    outcome: "ALLOW",
    reason: "otherwise",
    rule_id: null,
    trace: [
      {
        rule_id: "velocity",
        route: "next",
        condition: {
          result: "false",
          reference: {
            source: "metric",
            name: "session.event_count_5m",
            version: 1,
          },
          observed: { status: "known", value: 0 },
        },
      },
    ],
  },
  snapshot: {
    inputs: {},
    metrics: {
      "session.event_count_5m": {
        version: 1,
        state: { status: "known", value: 0 },
        provenance: { source: "backend", observed_at: 1000 },
      },
    },
  },
};
let record: DecisionDetail;
beforeEach(() => {
  record = structuredClone(original);
  vi.spyOn(api, "get").mockImplementation(
    async <T,>(): Promise<T> => record as T,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(path = "/activity/decisions/decision") {
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          { path: "/activity/decisions/:id", element: <DecisionPage /> },
          { path: "/entities/:kind/:id", element: <EntityPage /> },
        ],
        { initialEntries: [path] },
      )}
    />,
  );
}
describe("captured evidence and verification", () => {
  it("explains the Otherwise outcome with historical values before the collapsed path", async () => {
    mount();
    await screen.findByRole("heading", { name: "can_claim → Allow" });
    const evidence = document.querySelector(
      '[aria-label="Otherwise captured evidence"]',
    )!;
    expect(evidence.textContent).toContain(
      "Every rule continued. Otherwise Allow",
    );
    expect(evidence.textContent).toContain(
      "Condition false; evaluation continued",
    );
    expect(evidence.textContent).toContain(
      "session.event_count_5m v1 is at least 1",
    );
    expect(evidence.textContent).toContain("0 → false");
    expect(
      document.querySelector<HTMLDetailsElement>("#policy-path")!.open,
    ).toBe(false);
    expect(
      within(evidence as HTMLElement)
        .getByRole("link", { name: "session.event_count_5m v1" })
        .getAttribute("href"),
    ).toBe("/metrics/session.event_count_5m?version=1");
  });
  it("does not describe an explicit unknown continuation as a false or safe value", async () => {
    record.evaluation!.trace[0]!.condition = {
      result: "unknown",
      reference: {
        source: "metric",
        name: "session.event_count_5m",
        version: 1,
      },
      observed: { status: "unknown", reason: "unavailable" },
    };
    mount();
    await screen.findByRole("heading", { name: "can_claim → Allow" });
    const evidence = document.querySelector(
      '[aria-label="Otherwise captured evidence"]',
    )!;
    expect(evidence.textContent).toContain(
      "Condition unknown; the policy explicitly continued",
    );
    expect(evidence.textContent).toContain("Unknown: unavailable");
    expect(evidence.textContent).not.toContain("Condition false");
  });
  it("explains a policy with no rules without inventing evidence", async () => {
    record.policy!.rules = [];
    record.evaluation!.trace = [];
    mount();
    await screen.findByText("This policy has no rules. Otherwise Allow.");
    expect(
      document.querySelector('[aria-label="Otherwise captured evidence"]')!
        .textContent,
    ).not.toContain("Rule 1");
  });
  it("bounds the leading summary while preserving the full path", async () => {
    record.policy!.rules = Array.from({ length: 8 }, (_, at) => ({
      ...original.policy!.rules[0]!,
      id: `rule_${at}`,
    }));
    record.evaluation!.trace = record.policy!.rules.map((rule) => ({
      ...original.evaluation!.trace[0]!,
      rule_id: rule.id,
    }));
    mount();
    await screen.findByRole("heading", { name: "can_claim → Allow" });
    expect(document.querySelectorAll(".continuation-evidence")).toHaveLength(3);
    expect(
      screen.getByText(
        "5 further rules continued. Inspect the full policy path below.",
      ),
    ).toBeTruthy();
    expect(document.querySelectorAll("#policy-path .rules > li")).toHaveLength(
      8,
    );
  });
  it("shows sequential verification transitions without treating a passed step as authorization", async () => {
    record.outcome = "DENY";
    record.reason = "verification_failed";
    record.verification_transitions = [
      {
        sequence: 1,
        at: 1000,
        challenge_id: "first",
        state: "pending",
        detail: "verification_required",
      },
      {
        sequence: 2,
        at: 1100,
        challenge_id: "first",
        state: "passed",
        detail: "verification_passed",
      },
      {
        sequence: 3,
        at: 1200,
        challenge_id: "second",
        state: "pending",
        detail: "verification_required",
      },
      {
        sequence: 4,
        at: 1300,
        challenge_id: "second",
        state: "failed",
        detail: "binding_mismatch",
      },
    ];
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "can_claim → Deny" });
    expect(
      screen.getByText(/binding mismatch. The policy denied this attempt/),
    ).toBeTruthy();
    await user.click(
      screen.getByText("Verification steps", { selector: "summary" }),
    );
    const history = document.querySelector("#verification-steps")!;
    expect(history.textContent).toContain(
      "only a final Allow authorizes the action",
    );
    expect(history.textContent).toContain(
      "Step 1 · Verified; continued to the next rule",
    );
    expect(history.textContent).toContain("Step 2 · Verification failed");
  });
  it("keeps abandoned verification pending instead of deriving expiry from the current time", async () => {
    record.outcome = "CHALLENGE_REQUIRED";
    record.reason = "verification_required";
    record.verification_transitions = [
      {
        sequence: 1,
        at: 1,
        challenge_id: "step",
        state: "pending",
        detail: "verification_required",
      },
    ];
    mount();
    await screen.findByText(
      /This is the last recorded state; it is not a final authorization/,
    );
    expect(document.body.textContent).not.toContain("Verification expired");
  });
  it("exposes captured provider contribution separately from current provider settings", async () => {
    record.provider_revisions = {
      ip_intelligence: { revision: 4, enabled: true },
    };
    record.provider_observations = {
      ip_intelligence: {
        revision: 4,
        status: "partial",
        detail: "provider_warning",
        observed_at: 999,
      },
    };
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByText("Evidence captured for this decision", {
        selector: "summary",
      }),
    );
    expect(
      screen.getByText("IP intelligence · Configuration revision 4"),
    ).toBeTruthy();
    expect(document.querySelector("#evidence")!.textContent).toContain(
      "partial · provider warning",
    );
    expect(
      screen
        .getByRole("link", { name: "Provider settings" })
        .getAttribute("href"),
    ).toBe("/settings?provider=ip_intelligence#providers");
  });
  it.each(["client", "session", "user", "ip"])(
    "shows only metrics applicable to a %s entity, retaining relevant unknowns",
    async (kind) => {
      const observation = {
        version: 1,
        state: { status: "unknown", reason: "unavailable" } as const,
        provenance: { source: "krine", observed_at: 1 },
      };
      const entity: Entity = {
        kind,
        id: "entity",
        first_seen: 1,
        metadata: {},
        associations: [],
        associations_next_cursor: null,
        recent_decisions: [],
        recent_events: [],
        metrics: {
          "client.age_seconds": observation,
          "session.age_seconds": observation,
          "browser.automation_observed": observation,
          "ip.risk": observation,
        },
      };
      vi.mocked(api.get).mockResolvedValue(entity);
      mount(`/entities/${kind}/entity`);
      await screen.findByRole("heading", { name: "Current metrics" });
      const names = [...document.querySelectorAll(".metric-values dt")].map(
        (value) => value.textContent,
      );
      expect(names).toEqual(
        kind === "client"
          ? ["client.age_seconds v1"]
          : kind === "session"
            ? ["session.age_seconds v1", "browser.automation_observed v1"]
            : kind === "ip"
              ? ["ip.risk v1"]
              : [],
      );
      if (kind !== "user")
        expect(document.querySelector(".metric-values")!.textContent).toContain(
          "Unknown · unavailable",
        );
    },
  );
  it("uses read-specific recovery copy rather than mutation identity instructions", () => {
    expect(
      readErrorMessage(
        new ApiError(
          503,
          "unavailable",
          "Retry with the same request identity.",
        ),
      ),
    ).toBe(
      "Could not load this information from Krine. Retry when the connection is available.",
    );
  });
});
