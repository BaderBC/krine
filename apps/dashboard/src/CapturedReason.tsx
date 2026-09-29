import { encode } from "./api";
import { InvestigationLink as Link } from "./navigation";
import { comparisons, refLabel, scalarLabel } from "./policy";
import type { Decision, ReasonEvidence, ReasonSummary } from "./types";

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  new TextEncoder().encode(value).length <= 128;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const truth = (value: unknown) =>
  typeof value === "string" && ["true", "false", "unknown"].includes(value);
const scalar = (value: unknown) =>
  typeof value === "boolean" ||
  (typeof value === "string" && new TextEncoder().encode(value).length <= 64) ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER);
function validEvidence(value: unknown): value is ReasonEvidence {
  if (
    !object(value) ||
    !object(value.reference) ||
    !object(value.observed) ||
    !object(value.test)
  )
    return false;
  const ref = value.reference;
  const observed = value.observed;
  const test = value.test;
  const validTest =
    test.op === "known" ||
    (test.op === "compare" &&
      typeof test.comparison === "string" &&
      Object.hasOwn(comparisons, test.comparison) &&
      scalar(test.value)) ||
    (test.op === "in" &&
      Array.isArray(test.values) &&
      test.values.length <= 3 &&
      test.values.every(scalar)) ||
    (test.op === "between" &&
      typeof test.min === "number" &&
      scalar(test.min) &&
      typeof test.max === "number" &&
      scalar(test.max) &&
      test.min <= test.max);
  return (
    text(ref.name) &&
    (ref.source === "input" ||
      (ref.source === "metric" && integer(ref.version) && ref.version > 0)) &&
    Array.isArray(value.path) &&
    value.path.length <= 8 &&
    value.path.every((index) => integer(index) && index < 256) &&
    ((observed.status === "known" && scalar(observed.value)) ||
      (observed.status === "unknown" && text(observed.reason))) &&
    typeof value.observed_truncated === "boolean" &&
    typeof value.test_truncated === "boolean" &&
    truth(value.result) &&
    validTest &&
    (value.provenance === null ||
      (object(value.provenance) &&
        text(value.provenance.source) &&
        integer(value.provenance.observed_at) &&
        value.provenance.observed_at <= 8.64e15))
  );
}
function consistentReason(value: ReasonSummary) {
  if (value.scope === "otherwise")
    return (
      value.reason === "otherwise" &&
      (value.outcome === "ALLOW" || value.outcome === "DENY") &&
      (value.rules.length > 0 ||
        (!value.rules_truncated && !value.truncated)) &&
      value.rules.every((rule) =>
        rule.route === "next"
          ? rule.result === "false" || rule.result === "unknown"
          : rule.route === "verification_passed" && rule.result !== "false",
      )
    );
  const rule = value.rules[0]!;
  // These are evaluator metadata invariants, not a reevaluation of sampled leaves.
  switch (value.reason) {
    case "rule_matched":
      return (
        rule.result === "true" &&
        ((value.outcome === "ALLOW" && rule.route === "allow") ||
          (value.outcome === "DENY" && rule.route === "deny"))
      );
    case "unknown_denied":
      return (
        value.outcome === "DENY" &&
        rule.route === "deny" &&
        rule.result === "unknown"
      );
    case "verification_required":
      return (
        value.outcome === "CHALLENGE_REQUIRED" &&
        rule.route === "challenge" &&
        rule.result !== "false"
      );
    case "verification_failed":
    case "verification_expired":
    case "verification_unavailable":
      return (
        value.outcome === "DENY" &&
        rule.route === value.reason &&
        rule.result !== "false"
      );
    default:
      return false;
  }
}
export function validReasonSummary(
  value: unknown,
  decision: Pick<Decision, "reason" | "outcome">,
): value is ReasonSummary {
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    !text(value.reason) ||
    value.reason !== decision.reason ||
    value.outcome !== decision.outcome ||
    typeof value.outcome !== "string" ||
    !["ALLOW", "DENY", "CHALLENGE_REQUIRED"].includes(value.outcome) ||
    !Array.isArray(value.rules) ||
    value.rules.length > 3 ||
    typeof value.rules_truncated !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    !object(value.provider_revisions)
  )
    return false;
  if (
    value.scope === "decisive_rule"
      ? !text(value.rule_id) ||
        value.rules.length !== 1 ||
        value.rules[0]?.rule_id !== value.rule_id
      : value.scope !== "otherwise" || value.rule_id !== null
  )
    return false;
  let leaves = 0;
  for (const rule of value.rules) {
    if (
      !object(rule) ||
      !text(rule.rule_id) ||
      !integer(rule.position) ||
      rule.position < 1 ||
      rule.position > 32 ||
      typeof rule.route !== "string" ||
      ![
        "next",
        "allow",
        "deny",
        "challenge",
        "verification_passed",
        "verification_failed",
        "verification_expired",
        "verification_unavailable",
      ].includes(rule.route) ||
      !truth(rule.result) ||
      typeof rule.compound !== "boolean" ||
      typeof rule.evidence_truncated !== "boolean" ||
      !Array.isArray(rule.evidence) ||
      rule.evidence.length > 4 ||
      (rule.evidence.length === 0 && !rule.evidence_truncated) ||
      !rule.evidence.every(validEvidence)
    )
      return false;
    leaves += rule.evidence.length;
  }
  const pins = Object.entries(value.provider_revisions);
  return (
    leaves <= 4 &&
    pins.length <= 8 &&
    pins.every(
      ([capability, pin]) =>
        text(capability) &&
        object(pin) &&
        integer(pin.revision) &&
        (pin.revision > 0 || pin.enabled === false) &&
        typeof pin.enabled === "boolean",
    ) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 8192 &&
    consistentReason(value as unknown as ReasonSummary)
  );
}
const reasonText = (value: string) => value.replaceAll("_", " ");
export function CapturedReason({ decision }: { decision: Decision }) {
  const value = decision.reason_summary;
  if (value == null)
    return (
      <p className="help">
        {reasonText(decision.reason)} · Captured evidence summary not recorded.
      </p>
    );
  if (!validReasonSummary(value, decision))
    return (
      <p className="help">
        Captured reason summary could not be read. Open the decision for its
        recorded explanation.
      </p>
    );
  const rule = value.scope === "decisive_rule" ? value.rules[0] : undefined;
  const leaf = rule?.evidence[0];
  const partial =
    value.truncated ||
    value.rules_truncated ||
    value.rules.some(
      (item) =>
        item.evidence_truncated ||
        item.evidence.some(
          (item) => item.observed_truncated || item.test_truncated,
        ),
    );
  const headline =
    value.scope === "otherwise"
      ? value.rules.some((item) => item.route === "verification_passed")
        ? "Otherwise · verification passed, then continued"
        : value.rules.length === 0
          ? "Otherwise · no rules"
          : "Otherwise"
      : value.reason === "unknown_denied"
        ? `Rule ${rule!.position} denied when unknown`
        : value.reason.startsWith("verification_")
          ? `Rule ${rule!.position} · ${reasonText(value.reason)}`
          : `Rule ${rule!.position} matched`;
  return (
    <p className="help captured-reason">
      {headline}
      {leaf && (
        <span className="captured-value">
          {leaf.reference.source === "metric" ? (
            <Link
              to={`/metrics/${encode(leaf.reference.name)}?version=${leaf.reference.version}`}
            >
              {refLabel(leaf.reference)}
            </Link>
          ) : (
            <span translate="no">{refLabel(leaf.reference)}</span>
          )}
          {" = "}
          {leaf.observed.status === "known"
            ? scalarLabel(leaf.observed.value)
            : `Unknown: ${reasonText(leaf.observed.reason)}`}
          {leaf.observed_truncated && " (preview)"}
        </span>
      )}
      {(partial || (leaf && rule?.compound)) && (
        <span className="receipt-basis">
          {leaf && rule?.compound
            ? `${partial ? "Partial compound" : "Compound"} sample; see full condition.`
            : value.scope === "otherwise"
              ? "Partial captured path."
              : "Partial captured sample."}
        </span>
      )}
    </p>
  );
}
