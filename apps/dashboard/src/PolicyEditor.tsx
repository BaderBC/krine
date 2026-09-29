import { useId, useState } from "react";
import type { FormEvent } from "react";
import { useAddressedParam } from "./addresses";
import { InvestigationLink as Link } from "./navigation";
import { encode } from "./api";
import {
  actionLabel,
  comparisons,
  conditionLabel,
  defaultValue,
  newCondition,
  referenceType,
  usesInput,
} from "./policy";
import type {
  Comparison,
  Condition,
  Metric,
  Policy,
  Reference,
  Rule,
  Scalar,
  ValueType,
} from "./types";

function metricUnit(metric: Metric): string {
  if (metric.name.endsWith(".age_seconds")) return "Seconds";
  if (metric.name === "client.user_count_30d")
    return "Distinct users · 30 days";
  if (metric.name.endsWith(".event_count_5m"))
    return "Distinct backend events · 5 minutes";
  if (metric.name === "ip.risk") return "Risk · 0 to 1";
  if (metric.name === "ip.country") return "Two-letter country code";
  return metric.value_type === "boolean" ? "True or false" : metric.value_type;
}

function ScalarField({
  value,
  type,
  label,
  onChange,
}: {
  value: Scalar;
  type: ValueType;
  label: string;
  onChange: (value: Scalar) => void;
}) {
  return (
    <label>
      {label}
      {type === "boolean" ? (
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value === "true")}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : (
        <input
          autoComplete="off"
          name={label}
          type={type === "number" ? "number" : "text"}
          step="any"
          maxLength={1024}
          value={
            typeof value === "number" && !Number.isFinite(value)
              ? ""
              : String(value ?? "")
          }
          required={type === "number"}
          onChange={(event) =>
            onChange(
              type === "number"
                ? event.target.value === ""
                  ? NaN
                  : Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
    </label>
  );
}

function ConditionEditor({
  condition,
  policy,
  metrics,
  onChange,
  depth = 1,
}: {
  condition: Condition;
  policy: Policy;
  metrics: Metric[];
  onChange: (condition: Condition) => void;
  depth?: number;
}) {
  const id = useId();
  if (condition.op === "all" || condition.op === "any") {
    return (
      <fieldset className="condition-group">
        <legend>Condition group</legend>
        <label>
          Match
          <select
            value={condition.op}
            onChange={(event) =>
              onChange({
                ...condition,
                op: event.target.value as "all" | "any",
              })
            }
          >
            <option value="all">All conditions (AND)</option>
            <option value="any">Any condition (OR)</option>
          </select>
        </label>
        {condition.conditions.map((child, index) => (
          <div className="condition-child" key={index}>
            <ConditionEditor
              condition={child}
              policy={policy}
              metrics={metrics}
              depth={depth + 1}
              onChange={(next) =>
                onChange({
                  ...condition,
                  conditions: condition.conditions.map((value, at) =>
                    at === index ? next : value,
                  ),
                })
              }
            />
            <div className="actions">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => {
                  const children = [...condition.conditions];
                  [children[index - 1], children[index]] = [
                    children[index]!,
                    children[index - 1]!,
                  ];
                  onChange({ ...condition, conditions: children });
                }}
              >
                Move condition up
              </button>
              <button
                type="button"
                onClick={() => {
                  const children = condition.conditions.filter(
                    (_, at) => at !== index,
                  );
                  onChange(
                    children.length === 1
                      ? children[0]!
                      : { ...condition, conditions: children },
                  );
                }}
              >
                Remove condition
              </button>
            </div>
          </div>
        ))}
        <div className="actions">
          <button
            type="button"
            disabled={depth >= 8}
            onClick={() =>
              onChange({
                ...condition,
                conditions: [...condition.conditions, newCondition(metrics)],
              })
            }
          >
            Add condition
          </button>
          <button
            type="button"
            disabled={depth >= 7}
            onClick={() => onChange({ op: "not", condition })}
          >
            Negate group (NOT)
          </button>
        </div>
        <p className="help">
          {condition.op === "all"
            ? "A false condition makes this group false. Otherwise, any unknown condition keeps it unknown."
            : "A true condition makes this group true. Otherwise, any unknown condition keeps it unknown."}
        </p>
      </fieldset>
    );
  }
  if (condition.op === "not" && condition.condition.op !== "known")
    return (
      <fieldset className="condition-group">
        <legend>Not</legend>
        <ConditionEditor
          condition={condition.condition}
          policy={policy}
          metrics={metrics}
          depth={depth + 1}
          onChange={(next) => onChange({ op: "not", condition: next })}
        />
        <p className="help">
          Reverses true and false. Unknown remains unknown.
        </p>
        <button type="button" onClick={() => onChange(condition.condition)}>
          Remove negation
        </button>
      </fieldset>
    );
  const ref =
    condition.op === "not"
      ? (condition.condition as Extract<Condition, { op: "known" }>).value
      : condition.op === "known"
        ? condition.value
        : condition.left;
  const type = referenceType(ref, policy, metrics);
  const metric =
    ref.source === "metric"
      ? metrics.find(
          (value) => value.name === ref.name && value.version === ref.version,
        )
      : undefined;
  const operator =
    condition.op === "compare"
      ? condition.comparison
      : condition.op === "not"
        ? "unknown"
        : condition.op;
  function selectOperator(op: string, nextRef = ref, nextType = type) {
    if (op === "known") onChange({ op: "known", value: nextRef });
    else if (op === "unknown")
      onChange({ op: "not", condition: { op: "known", value: nextRef } });
    else if (op === "between")
      onChange({ op: "between", left: nextRef, min: 0, max: 1 });
    else if (op === "in")
      onChange({ op: "in", left: nextRef, values: [defaultValue(nextType)] });
    else
      onChange({
        op: "compare",
        left: nextRef,
        comparison: op as Comparison,
        value:
          condition.op === "compare" && nextType === type
            ? condition.value
            : defaultValue(nextType),
      });
  }
  return (
    <div className="condition">
      <div className="condition-fields">
        <label htmlFor={`${id}-ref`}>
          Evidence
          <select
            id={`${id}-ref`}
            value={JSON.stringify(
              ref.source === "metric"
                ? { source: ref.source, name: ref.name, version: ref.version }
                : { source: ref.source, name: ref.name },
            )}
            onChange={(event) => {
              const nextRef = JSON.parse(event.target.value) as Reference;
              selectOperator(
                "eq",
                nextRef,
                referenceType(nextRef, policy, metrics),
              );
            }}
          >
            <optgroup label="Metrics">
              {metrics.map((value) => (
                <option
                  key={`${value.name}@${value.version}`}
                  value={JSON.stringify({
                    source: "metric",
                    name: value.name,
                    version: value.version,
                  })}
                >
                  {value.name} · v{value.version}
                </option>
              ))}
            </optgroup>
            {Object.keys(policy.inputs).length > 0 && (
              <optgroup label="Trusted backend inputs">
                {Object.keys(policy.inputs).map((name) => (
                  <option
                    key={name}
                    value={JSON.stringify({ source: "input", name })}
                  >
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label>
          Condition
          <select
            value={operator}
            onChange={(event) => selectOperator(event.target.value)}
          >
            {Object.entries(comparisons)
              .filter(
                ([key]) => type === "number" || key === "eq" || key === "ne",
              )
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            <option value="in">is one of</option>
            {type === "number" && (
              <option value="between">is between (inclusive)</option>
            )}
            <option value="known">is known</option>
            <option value="unknown">is unknown</option>
          </select>
        </label>
        {condition.op === "compare" && (
          <ScalarField
            label="Value"
            value={condition.value}
            type={type}
            onChange={(value) => onChange({ ...condition, value })}
          />
        )}
        {condition.op === "between" && (
          <>
            <ScalarField
              label="Minimum"
              type="number"
              value={condition.min}
              onChange={(min) => onChange({ ...condition, min: min as number })}
            />
            <ScalarField
              label="Maximum"
              type="number"
              value={condition.max}
              onChange={(max) => onChange({ ...condition, max: max as number })}
            />
          </>
        )}
      </div>
      {condition.op === "in" && (
        <div className="membership">
          {condition.values.map((value, index) => (
            <div className="inline-fields" key={index}>
              <ScalarField
                label={`Value ${index + 1}`}
                type={type}
                value={value}
                onChange={(next) =>
                  onChange({
                    ...condition,
                    values: condition.values.map((item, at) =>
                      at === index ? next : item,
                    ),
                  })
                }
              />
              <button
                type="button"
                disabled={condition.values.length === 1}
                onClick={() =>
                  onChange({
                    ...condition,
                    values: condition.values.filter((_, at) => index !== at),
                  })
                }
              >
                Remove value {index + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={condition.values.length >= 32}
            onClick={() =>
              onChange({
                ...condition,
                values: [...condition.values, defaultValue(type)],
              })
            }
          >
            Add value
          </button>
        </div>
      )}
      {metric ? (
        <div className="metric-help">
          <p>{metric.description}</p>
          <p className="help">
            {metricUnit(metric)} · v{metric.version}. {metric.missing}{" "}
            <Link
              to={`/metrics/${encode(metric.name)}?version=${metric.version}`}
            >
              Definition
            </Link>
          </p>
        </div>
      ) : (
        <p className="help">
          A {type} supplied by your application backend. A missing input is
          unknown; an undeclared or wrong-type input rejects the request.
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={depth >= 8}
          onClick={() =>
            onChange({
              op: "all",
              conditions: [condition, newCondition(metrics)],
            })
          }
        >
          Add condition
        </button>
        {condition.op !== "not" && (
          <button
            type="button"
            disabled={depth >= 8}
            onClick={() => onChange({ op: "not", condition })}
          >
            Negate (NOT)
          </button>
        )}
      </div>
    </div>
  );
}

export function PolicyRead({ policy }: { policy: Policy }) {
  return (
    <div className="policy-read">
      {Object.keys(policy.inputs).length > 0 && (
        <p className="help">
          Trusted inputs:{" "}
          {Object.entries(policy.inputs)
            .map(([name, type]) => `${name} (${type})`)
            .join(", ")}
        </p>
      )}
      <ol className="rules">
        {policy.rules.map((rule) => (
          <li key={rule.id}>
            <p>
              When <strong>{conditionLabel(rule.condition)}</strong>
            </p>
            <p>
              Then <strong>{actionLabel(rule.then)}</strong>
            </p>
            <p className="help">If unknown: {actionLabel(rule.on_unknown)}.</p>
            {(rule.then === "CHALLENGE" || rule.on_unknown === "CHALLENGE") && (
              <VerificationBranches />
            )}
          </li>
        ))}
      </ol>
      <p className="otherwise">
        Otherwise <strong>{actionLabel(policy.otherwise)}</strong>
      </p>
    </div>
  );
}
export function VerificationBranches() {
  return (
    <p className="help verification-branches">
      Verified → continue to the next rule.
      <br />
      Failed, expired or provider unavailable → deny.
    </p>
  );
}

export function PolicyEditor({
  policy,
  metrics,
  onChange,
}: {
  policy: Policy;
  metrics: Metric[];
  onChange: (policy: Policy) => void;
}) {
  const name = useAddressedParam("name");
  const [expanded, setExpanded] = useState<string | null>(
    policy.rules[0]?.id ?? null,
  );
  const [inputError, setInputError] = useState<string | null>(null);
  function updateRule(index: number, change: Partial<Rule>) {
    onChange({
      ...policy,
      rules: policy.rules.map((rule, at) =>
        index === at ? { ...rule, ...change } : rule,
      ),
    });
  }
  function move(index: number, by: number) {
    const rules = [...policy.rules];
    [rules[index], rules[index + by]] = [rules[index + by]!, rules[index]!];
    onChange({ ...policy, rules });
  }
  function addInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("input_name") ?? "");
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name)) {
      setInputError(
        "Use 1–128 letters, numbers, underscores, dots, colons or hyphens.",
      );
      event.currentTarget.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    if (Object.hasOwn(policy.inputs, name)) {
      setInputError("An input with this name already exists.");
      return;
    }
    onChange({
      ...policy,
      inputs: { ...policy.inputs, [name]: data.get("input_type") as ValueType },
    });
    setInputError(null);
    event.currentTarget.reset();
  }
  return (
    <>
      <ol className="rules editable">
        {policy.rules.map((rule, index) => (
          <li key={rule.id}>
            <div className="rule-heading">
              <button
                className="rule-toggle"
                aria-expanded={expanded === rule.id}
                onClick={() =>
                  setExpanded(expanded === rule.id ? null : rule.id)
                }
              >
                {expanded === rule.id
                  ? `Rule ${index + 1}`
                  : `When ${conditionLabel(rule.condition)} → ${actionLabel(rule.then)}`}
              </button>
              <div className="actions">
                <button
                  aria-label={`Move rule ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`Move rule ${index + 1} down`}
                  disabled={index === policy.rules.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  onClick={() => {
                    onChange({
                      ...policy,
                      rules: policy.rules.filter((_, at) => index !== at),
                    });
                  }}
                >
                  Remove rule {index + 1}
                </button>
              </div>
            </div>
            {expanded === rule.id ? (
              <>
                <ConditionEditor
                  condition={rule.condition}
                  policy={policy}
                  metrics={metrics}
                  onChange={(condition) => updateRule(index, { condition })}
                />
                <div className="inline-fields outcomes">
                  <label>
                    Then
                    <select
                      value={rule.then}
                      onChange={(event) =>
                        updateRule(index, {
                          then: event.target.value as Rule["then"],
                        })
                      }
                    >
                      {(["DENY", "ALLOW", "CHALLENGE"] as const).map(
                        (value) => (
                          <option key={value} value={value}>
                            {actionLabel(value)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    If condition is unknown
                    <select
                      value={rule.on_unknown}
                      onChange={(event) =>
                        updateRule(index, {
                          on_unknown: event.target.value as Rule["on_unknown"],
                        })
                      }
                    >
                      {(["DENY", "CHALLENGE", "NEXT"] as const).map((value) => (
                        <option key={value} value={value}>
                          {actionLabel(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {rule.on_unknown === "NEXT" && (
                  <p className="help">
                    Unknown evidence continues, including to Otherwise{" "}
                    {actionLabel(policy.otherwise)} if no later rule stops it.
                  </p>
                )}
              </>
            ) : (
              <p className="help">
                If unknown: {actionLabel(rule.on_unknown)}.
              </p>
            )}
            {(rule.then === "CHALLENGE" || rule.on_unknown === "CHALLENGE") && (
              <>
                <VerificationBranches />
                <Link
                  className="small"
                  to={`/settings?provider=verification${name ? `&check=${encode(name)}` : ""}#providers`}
                >
                  Configure verification
                </Link>
              </>
            )}
          </li>
        ))}
      </ol>
      <button
        disabled={policy.rules.length >= 32 || !metrics.length}
        onClick={() => {
          const id = `rule_${crypto.randomUUID()}`;
          onChange({
            ...policy,
            rules: [
              ...policy.rules,
              {
                id,
                condition: newCondition(metrics),
                then: "DENY",
                on_unknown: "DENY",
              },
            ],
          });
          setExpanded(id);
        }}
      >
        Add rule
      </button>
      <div className="otherwise">
        <label>
          Otherwise
          <select
            value={policy.otherwise}
            onChange={(event) =>
              onChange({
                ...policy,
                otherwise: event.target.value as Policy["otherwise"],
              })
            }
          >
            <option value="DENY">Deny</option>
            <option value="ALLOW">Allow</option>
          </select>
        </label>
        <p className="help">
          Applies after every rule continues. A matched Allow or Deny ends
          evaluation.
        </p>
      </div>
      <details>
        <summary>Trusted backend inputs</summary>
        <p className="help">
          Declare only inputs your backend supplies. Client properties are never
          authoritative policy inputs.
        </p>
        {Object.entries(policy.inputs).map(([name, type]) => (
          <div className="input-declaration" key={name}>
            <span>
              <code>{name}</code> · {type}
            </span>
            <button
              disabled={policy.rules.some((rule) =>
                usesInput(rule.condition, name),
              )}
              onClick={() => {
                const inputs = { ...policy.inputs };
                delete inputs[name];
                onChange({ ...policy, inputs });
              }}
            >
              Remove {name}
            </button>
          </div>
        ))}
        <p className="help">
          Remove an input’s conditions before removing its declaration.
        </p>
        <form className="inline-fields" onSubmit={addInput}>
          <label>
            Name
            <input
              name="input_name"
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              required
              placeholder="amount…"
            />
          </label>
          <label>
            Type
            <select name="input_type">
              <option value="number">Number</option>
              <option value="string">String</option>
              <option value="boolean">Boolean</option>
            </select>
          </label>
          <button
            disabled={Object.keys(policy.inputs).length >= 32}
            type="submit"
          >
            Add input
          </button>
        </form>
        {inputError && (
          <p role="alert" className="error">
            {inputError}
          </p>
        )}
      </details>
    </>
  );
}
