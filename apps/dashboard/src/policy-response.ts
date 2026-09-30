import type { Condition, Policy, Reference, Rule, Scalar } from "./types";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const scalar = (value: unknown): value is Scalar =>
  typeof value === "boolean" ||
  (typeof value === "string" &&
    new TextEncoder().encode(value).length <= 1024) ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER);
function invalid(): never {
  throw new Error("Unreadable policy response");
}
function reference(value: unknown): Reference {
  if (!object(value) || !identifier(value.name)) return invalid();
  if (value.source === "input" && keys(value, ["source", "name"]))
    return value as Reference;
  if (
    value.source === "metric" &&
    keys(value, ["source", "name", "version"]) &&
    Number.isInteger(value.version) &&
    (value.version as number) >= 0 &&
    (value.version as number) <= 0xffffffff
  )
    return value as Reference;
  return invalid();
}

/** Expand only the defaults defined by krine-core's Policy and Rule wire format. */
export function readPolicy(value: unknown): Policy {
  if (
    !object(value) ||
    !keys(value, ["schema_version", "inputs", "rules", "otherwise"]) ||
    value.schema_version !== 1
  )
    return invalid();
  const inputs = Object.hasOwn(value, "inputs") ? value.inputs : {};
  const rules = Object.hasOwn(value, "rules") ? value.rules : [];
  const otherwise = Object.hasOwn(value, "otherwise")
    ? value.otherwise
    : "DENY";
  if (
    !object(inputs) ||
    Object.keys(inputs).length > 32 ||
    !Object.entries(inputs).every(
      ([name, type]) =>
        identifier(name) &&
        (type === "number" || type === "string" || type === "boolean"),
    ) ||
    !Array.isArray(rules) ||
    rules.length > 32 ||
    (otherwise !== "ALLOW" && otherwise !== "DENY")
  )
    return invalid();
  let nodes = 0;
  function condition(value: unknown, depth: number): Condition {
    if (!object(value) || ++nodes > 256 || depth > 8) return invalid();
    switch (value.op) {
      case "compare":
        if (
          !keys(value, ["op", "left", "comparison", "value"]) ||
          typeof value.comparison !== "string" ||
          !["eq", "ne", "gt", "gte", "lt", "lte"].includes(value.comparison) ||
          !scalar(value.value)
        )
          return invalid();
        return { ...value, left: reference(value.left) } as Condition;
      case "known":
        if (!keys(value, ["op", "value"])) return invalid();
        return { op: "known", value: reference(value.value) };
      case "between":
        if (
          !keys(value, ["op", "left", "min", "max"]) ||
          typeof value.min !== "number" ||
          typeof value.max !== "number" ||
          !scalar(value.min) ||
          !scalar(value.max) ||
          value.min > value.max
        )
          return invalid();
        return {
          op: "between",
          left: reference(value.left),
          min: value.min,
          max: value.max,
        };
      case "in":
        if (
          !keys(value, ["op", "left", "values"]) ||
          !Array.isArray(value.values) ||
          !value.values.length ||
          value.values.length > 32 ||
          !value.values.every(scalar)
        )
          return invalid();
        return { op: "in", left: reference(value.left), values: value.values };
      case "not":
        if (!keys(value, ["op", "condition"])) return invalid();
        return { op: "not", condition: condition(value.condition, depth + 1) };
      case "all":
      case "any":
        if (
          !keys(value, ["op", "conditions"]) ||
          !Array.isArray(value.conditions) ||
          !value.conditions.length ||
          value.conditions.length > 256
        )
          return invalid();
        return {
          op: value.op,
          conditions: value.conditions.map((child) =>
            condition(child, depth + 1),
          ),
        };
      default:
        return invalid();
    }
  }
  const ids = new Set<string>();
  const normalized = rules.map((rule): Rule => {
    if (
      !object(rule) ||
      !keys(rule, ["id", "condition", "then", "on_unknown"]) ||
      !identifier(rule.id) ||
      ids.has(rule.id) ||
      (rule.then !== "ALLOW" &&
        rule.then !== "DENY" &&
        rule.then !== "CHALLENGE")
    )
      return invalid();
    ids.add(rule.id);
    const unknown = Object.hasOwn(rule, "on_unknown")
      ? rule.on_unknown
      : "DENY";
    if (unknown !== "DENY" && unknown !== "NEXT" && unknown !== "CHALLENGE")
      return invalid();
    return {
      id: rule.id,
      condition: condition(rule.condition, 1),
      then: rule.then,
      on_unknown: unknown,
    };
  });
  return {
    schema_version: 1,
    inputs: inputs as Policy["inputs"],
    rules: normalized,
    otherwise,
  };
}

// Select known response contracts. Never walk arbitrary event properties,
// provider configuration, captured input values, or other customer JSON.
export function readPolicyResponse(
  path: string,
  method: string,
  value: unknown,
): unknown {
  const pathname = path.split("?")[0]!;
  const check = /^\/(?:lookup\/checks|checks\/[^/]+)(.*)$/.exec(pathname);
  function field(value: unknown, key: "policy" | "draft") {
    if (!object(value)) return invalid();
    return { ...value, [key]: readPolicy(value[key]) };
  }
  if (pathname === "/checks" && method === "POST") return field(value, "draft");
  if (check) {
    const suffix = check[1];
    if (suffix === "" || suffix === "/draft" || suffix === "/restorations")
      return field(value, "draft");
    if (suffix === "/publications" || /^\/versions\/\d+$/.test(suffix!))
      return field(value, "policy");
    if (suffix === "/versions") {
      if (!object(value) || !Array.isArray(value.items)) return invalid();
      return {
        ...value,
        items: value.items.map((item) => field(item, "policy")),
      };
    }
  }
  if (
    /^\/activity\/decisions\/[^/]+$/.test(pathname) &&
    object(value) &&
    Object.hasOwn(value, "policy") &&
    value.policy !== null
  )
    return field(value, "policy");
  return value;
}
