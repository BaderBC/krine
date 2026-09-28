import type {
  Condition,
  Metric,
  Policy,
  Reference,
  Scalar,
  ValueType,
} from "./types";

export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  if (Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return (
    Object.keys(leftRecord).length === Object.keys(rightRecord).length &&
    Object.keys(leftRecord).every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        sameJson(leftRecord[key], rightRecord[key]),
    )
  );
}

export const actionLabel = (value: string) =>
  ({
    ALLOW: "Allow",
    DENY: "Deny",
    CHALLENGE: "Require verification",
    CHALLENGE_REQUIRED: "Awaiting verification",
    NEXT: "Continue to next rule",
  })[value] ?? value.replaceAll("_", " ");
export const comparisons = {
  eq: "equals",
  ne: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};
export const refLabel = (ref: Reference) =>
  ref.source === "metric" ? `${ref.name} v${ref.version}` : `Input ${ref.name}`;
export const scalarLabel = (value: Scalar) =>
  typeof value === "string" ? `“${value}”` : String(value);
export function conditionLabel(condition: Condition): string {
  switch (condition.op) {
    case "compare":
      return `${refLabel(condition.left)} ${comparisons[condition.comparison]} ${scalarLabel(condition.value)}`;
    case "in":
      return `${refLabel(condition.left)} is one of ${condition.values.map(scalarLabel).join(", ")}`;
    case "between":
      return `${refLabel(condition.left)} is between ${condition.min} and ${condition.max}, inclusive`;
    case "known":
      return `${refLabel(condition.value)} is known`;
    case "not":
      return condition.condition.op === "known"
        ? `${refLabel(condition.condition.value)} is unknown`
        : `Not (${conditionLabel(condition.condition)})`;
    case "all":
    case "any":
      return `(${condition.conditions.map(conditionLabel).join(condition.op === "all" ? " and " : " or ")})`;
  }
}
export function referenceType(
  ref: Reference,
  policy: Policy,
  metrics: Metric[],
): ValueType {
  return ref.source === "input"
    ? (policy.inputs[ref.name] ?? "string")
    : (metrics.find(
        (metric) => metric.name === ref.name && metric.version === ref.version,
      )?.value_type ?? "number");
}
export const defaultValue = (type: ValueType): Scalar =>
  type === "number" ? 0 : type === "boolean" ? true : "";
export function newCondition(metrics: Metric[]): Condition {
  const metric = metrics[0];
  return {
    op: "compare",
    left: {
      source: "metric",
      name: metric?.name ?? "client.age_seconds",
      version: metric?.version ?? 1,
    },
    comparison: "eq",
    value: defaultValue(metric?.value_type ?? "number"),
  };
}
export function usesInput(condition: Condition, name: string): boolean {
  if (condition.op === "all" || condition.op === "any")
    return condition.conditions.some((child) => usesInput(child, name));
  if (condition.op === "not") return usesInput(condition.condition, name);
  const ref = condition.op === "known" ? condition.value : condition.left;
  return ref.source === "input" && ref.name === name;
}
export function policyChanges(
  before: Policy | undefined,
  after: Policy,
): string[] {
  if (!before)
    return ["First publication. The complete policy below becomes active."];
  const changes: string[] = [];
  const oldIds = before.rules.map((rule) => rule.id);
  const newIds = after.rules.map((rule) => rule.id);
  before.rules.forEach((rule, index) => {
    if (!newIds.includes(rule.id))
      changes.push(
        `Removed previous rule ${index + 1}: ${conditionLabel(rule.condition)}.`,
      );
  });
  after.rules.forEach((rule, index) => {
    const oldIndex = oldIds.indexOf(rule.id);
    const old = before.rules[oldIndex];
    if (!old) {
      changes.push(`Added rule ${index + 1}.`);
      return;
    }
    if (oldIndex !== index)
      changes.push(`Rule ${oldIndex + 1} moves to position ${index + 1}.`);
    if (!sameJson(old.condition, rule.condition))
      changes.push(
        `Rule ${index + 1} condition: ${conditionLabel(old.condition)} → ${conditionLabel(rule.condition)}.`,
      );
    if (old.then !== rule.then)
      changes.push(
        `Rule ${index + 1} result: ${actionLabel(old.then)} → ${actionLabel(rule.then)}.`,
      );
    if (old.on_unknown !== rule.on_unknown)
      changes.push(
        `Rule ${index + 1} unknown path: ${actionLabel(old.on_unknown)} → ${actionLabel(rule.on_unknown)}.`,
      );
  });
  if (before.otherwise !== after.otherwise)
    changes.push(
      `Otherwise: ${actionLabel(before.otherwise)} → ${actionLabel(after.otherwise)}.`,
    );
  if (!sameJson(before.inputs, after.inputs))
    changes.push(
      "Trusted backend input declarations changed. Check the declarations below before publishing.",
    );
  return changes.length ? changes : ["Policy behavior is unchanged."];
}

export function policyError(policy: Policy): string | null {
  let nodes = 0;
  const scalarValid = (value: unknown) =>
    typeof value === "boolean" ||
    (typeof value === "string" &&
      new TextEncoder().encode(value).length <= 1024) ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER);
  function valid(condition: Condition, depth: number): boolean {
    if (++nodes > 256 || depth > 8) return false;
    if (condition.op === "all" || condition.op === "any")
      return (
        condition.conditions.length > 0 &&
        condition.conditions.every((child) => valid(child, depth + 1))
      );
    if (condition.op === "not") return valid(condition.condition, depth + 1);
    if (condition.op === "compare") return scalarValid(condition.value);
    if (condition.op === "between")
      return (
        scalarValid(condition.min) &&
        scalarValid(condition.max) &&
        condition.min <= condition.max
      );
    if (condition.op === "in")
      return (
        condition.values.length >= 1 &&
        condition.values.length <= 32 &&
        condition.values.every(scalarValid)
      );
    return true;
  }
  return policy.rules.every((rule) => valid(rule.condition, 1))
    ? null
    : "Complete every condition with valid values. Ranges must be ordered; lists support 1–32 values; nesting supports 8 levels and 256 conditions.";
}
