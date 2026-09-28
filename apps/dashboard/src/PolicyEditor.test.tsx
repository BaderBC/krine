import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { PolicyEditor, PolicyRead } from "./PolicyEditor";
import { policyChanges } from "./policy";
import type { Metric, Policy } from "./types";

const metrics: Metric[] = [
  {
    name: "ip.risk",
    version: 1,
    kind: "primitive",
    value_type: "number",
    range: [0, 1],
    description: "Normalized IP risk.",
    dependencies: [],
    source: "ip_intelligence",
    missing: "Unknown when unavailable.",
    examples: [],
  },
  {
    name: "browser.automation_observed",
    version: 1,
    kind: "primitive",
    value_type: "boolean",
    range: null,
    description: "Untrusted browser evidence.",
    dependencies: [],
    source: "untrusted_browser",
    missing: "Unknown when missing.",
    examples: [],
  },
];
const initial: Policy = {
  schema_version: 1,
  inputs: {},
  rules: [],
  otherwise: "DENY",
};
afterEach(cleanup);
function Harness() {
  const [policy, setPolicy] = useState(initial);
  return (
    <MemoryRouter>
      <PolicyEditor policy={policy} metrics={metrics} onChange={setPolicy} />
      <output data-testid="policy">{JSON.stringify(policy)}</output>
    </MemoryRouter>
  );
}
function currentPolicy(): Policy {
  return JSON.parse(screen.getByTestId("policy").textContent!);
}

describe("no-code policy authoring", () => {
  it("shows the correct reference when server JSON object keys arrive reordered", () => {
    const policy: Policy = {
      ...initial,
      rules: [
        {
          id: "r",
          condition: {
            op: "known",
            value: {
              name: "browser.automation_observed",
              version: 1,
              source: "metric",
            },
          },
          then: "DENY",
          on_unknown: "DENY",
        },
      ],
    };
    render(
      <MemoryRouter>
        <PolicyEditor policy={policy} metrics={metrics} onChange={() => {}} />
      </MemoryRouter>,
    );
    expect(
      (screen.getByLabelText("Evidence") as HTMLSelectElement)
        .selectedOptions[0]!.text,
    ).toBe("browser.automation_observed · v1");
  });
  it("supports explicit unknown, boolean operators and keyboard rule ordering", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(
      (screen.getByLabelText("Otherwise") as HTMLSelectElement).value,
    ).toBe("DENY");
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(currentPolicy().rules[0]!.on_unknown).toBe("DENY");
    await user.selectOptions(
      screen.getByLabelText("Condition", { exact: true }),
      "unknown",
    );
    expect(currentPolicy().rules[0]!.condition.op).toBe("not");
    await user.selectOptions(
      screen.getByLabelText("If condition is unknown"),
      "NEXT",
    );
    expect(screen.getByText(/Unknown evidence continues/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.selectOptions(screen.getByLabelText("Match"), "any");
    expect(currentPolicy().rules[0]!.condition.op).toBe("any");
    const firstId = currentPolicy().rules[0]!.id;
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    const move = screen.getByRole("button", { name: "Move rule 2 up" });
    move.focus();
    await user.keyboard("{Enter}");
    expect(currentPolicy().rules[1]!.id).toBe(firstId);
  });
  it("declares authoritative inputs and restricts scalar comparisons by type", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Trusted backend inputs"));
    await user.type(
      screen.getByLabelText("Name", { exact: true }),
      "paid_customer",
    );
    await user.selectOptions(
      screen.getByLabelText("Type", { exact: true }),
      "boolean",
    );
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.selectOptions(
      screen.getByLabelText("Evidence"),
      JSON.stringify({ source: "input", name: "paid_customer" }),
    );
    expect(
      screen.queryByRole("option", { name: "is greater than" }),
    ).toBeNull();
    expect((screen.getByLabelText("Value") as HTMLSelectElement).value).toBe(
      "true",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Remove paid_customer",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("makes verification continuation and failure branches visible", () => {
    render(
      <PolicyRead
        policy={{
          ...initial,
          rules: [
            {
              id: "r",
              condition: {
                op: "known",
                value: { source: "input", name: "amount" },
              },
              then: "CHALLENGE",
              on_unknown: "DENY",
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(/Verified → continue to the next rule/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Failed, expired or provider unavailable → deny/),
    ).toBeTruthy();
  });
  it("publication review exposes order, unknown routes and metric-version changes", () => {
    const before: Policy = {
      ...initial,
      rules: [
        {
          id: "a",
          condition: {
            op: "known",
            value: { source: "metric", name: "ip.risk", version: 1 },
          },
          then: "DENY",
          on_unknown: "DENY",
        },
        {
          id: "b",
          condition: {
            op: "known",
            value: { source: "input", name: "amount" },
          },
          then: "ALLOW",
          on_unknown: "DENY",
        },
      ],
    };
    const after: Policy = {
      ...before,
      rules: [
        before.rules[1]!,
        {
          ...before.rules[0]!,
          condition: {
            op: "known",
            value: { source: "metric", name: "ip.risk", version: 2 },
          },
          on_unknown: "NEXT",
        },
      ],
      otherwise: "ALLOW",
    };
    const review = policyChanges(before, after).join("\n");
    expect(review).toContain("Rule 2 moves to position 1");
    expect(review).toContain("ip.risk v1");
    expect(review).toContain("ip.risk v2");
    expect(review).toContain("unknown path: Deny → Continue");
    expect(review).toContain("Otherwise: Deny → Allow");
  });
});
