import { useState } from "react";
import { exactUtc, ranges } from "./activity-analytics";

export function ActiveScopeFilters({
  params,
  keys,
  onChange,
}: {
  params: URLSearchParams;
  keys: string[];
  onChange: (params: URLSearchParams) => void;
}) {
  const active = keys.filter((key) => params.has(key));
  const labels: Record<string, string> = {
    check: "Check",
    operation_id: "Operation ID",
    name: "Event name",
    entity: "Entity",
    outcome: "Result",
    reason: "Reason",
    provenance: "Source",
  };
  if (!active.length) return null;
  return (
    <ul className="active-scope-filters" aria-label="Additional active filters">
      {active.map((key) => (
        <li key={key}>
          <span>
            {key === "entity" && params.has("entity_kind")
              ? params.get("entity_kind")
              : labels[key]}
            : <code translate="no">{params.get(key)}</code>
          </span>
          <button
            type="button"
            aria-label={`Remove ${labels[key]} filter`}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete(key);
              next.delete("cursor");
              if (key === "entity") next.delete("entity_kind");
              onChange(next);
            }}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

function fieldTime(value: string | null) {
  if (value === null || !Number.isSafeInteger(Number(value))) return "";
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19) : "";
}

export function ActivityRange({
  params,
  all = false,
}: {
  params: URLSearchParams;
  all?: boolean;
}) {
  const initial = params.get("range") ?? "custom";
  const [selected, setSelected] = useState(initial);
  return (
    <>
      <label>
        Time
        <select
          name="range"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {ranges.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
          <option value="custom">Custom interval</option>
          {all && <option value="all">All retained records</option>}
        </select>
      </label>
      {selected === "custom" && (
        <details className="custom-range" open={initial !== "custom"}>
          <summary>
            {params.has("from") && params.has("to")
              ? `${exactUtc(Number(params.get("from")))} — ${exactUtc(
                  Number(params.get("to")),
                )} · edit`
              : "Edit exact interval · UTC"}
          </summary>
          <fieldset>
            <legend className="sr-only">Exact interval · UTC</legend>
            <label>
              From
              <input
                name="range_from"
                type="datetime-local"
                step="1"
                required
                defaultValue={fieldTime(params.get("from"))}
              />
            </label>
            <label>
              To
              <input
                name="range_to"
                type="datetime-local"
                step="1"
                required
                defaultValue={fieldTime(params.get("to"))}
              />
            </label>
          </fieldset>
        </details>
      )}
    </>
  );
}

/** Preserve sub-second bucket boundaries when unchanged in the seconds editor. */
export function formWindow(
  form: FormData,
  current: URLSearchParams,
  now: number,
) {
  const range = String(form.get("range"));
  const result = new URLSearchParams();
  if (range !== "custom") result.set("range", range);
  if (range === "all") return result;
  if (range === "custom") {
    for (const key of ["from", "to"] as const) {
      const raw = String(form.get(`range_${key}`) ?? "");
      const entered = Date.parse(`${raw}Z`);
      const original = Number(current.get(key));
      const parsed =
        current.has(key) &&
        Number.isSafeInteger(original) &&
        Math.floor(original / 1000) * 1000 === entered
          ? original
          : entered;
      if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error("Enter a valid start and end time in UTC.");
      result.set(key, String(parsed));
    }
  } else {
    const hours = ranges.find(([value]) => value === range)?.[0];
    if (!hours) throw new Error("Choose a supported time interval.");
    if (
      range === current.get("range") &&
      current.has("from") &&
      current.has("to")
    ) {
      result.set("from", current.get("from")!);
      result.set("to", current.get("to")!);
    } else {
      result.set("from", String(Math.max(0, now - Number(hours) * 3_600_000)));
      result.set("to", String(now));
    }
  }
  if (Number(result.get("to")) < Number(result.get("from")))
    throw new Error("The end time must be after the start time.");
  return result;
}
