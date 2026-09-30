import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { entityUrl } from "./addresses";
import { AnalyticsPanel, useAnalytics } from "./Analytics";
import { refreshedWindow, useActivityWindow } from "./activity-analytics";
import { Notice, PageTitle, useResource } from "./shared";
import { ActiveScopeFilters, ActivityRange, formWindow } from "./ActivityRange";
import { rememberActivityPosition, useActivityOrigin } from "./navigation";

export function EntityLookup({ params }: { params?: URLSearchParams }) {
  const navigate = useNavigate();
  const origin = useActivityOrigin();
  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get("entity_id") ?? "");
    if (id) {
      const context = new URLSearchParams();
      for (const key of ["from", "to"]) {
        if (params?.has(key)) context.set(key, params.get(key)!);
      }
      if (origin) context.set("return_to", origin);
      rememberActivityPosition(origin);
      const target = entityUrl(String(form.get("entity_kind")), id);
      navigate(context.size ? `${target}&${context}` : target);
    }
  }
  return (
    <form className="entity-lookup" onSubmit={open}>
      <div>
        <h2>Investigate a subject</h2>
        <p className="help">
          Start with an exact identifier from your application or an activity
          record.
        </p>
      </div>
      <label>
        <span className="sr-only">Subject type</span>
        <select name="entity_kind" defaultValue="user">
          <option value="user">User</option>
          <option value="client">Client</option>
          <option value="session">Session</option>
          <option value="ip">IP address</option>
        </select>
      </label>
      <label>
        <span className="sr-only">Exact subject identifier</span>
        <input
          name="entity_id"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={256}
          placeholder="Exact user or context ID…"
        />
      </label>
      <button type="submit">Investigate →</button>
    </form>
  );
}

interface Installation {
  sample_data: null | {
    dataset_id: string;
    generator_version: string;
    from: number;
    to: number;
    seed: string;
    completed_at: number;
  };
}
function validInstallation(value: unknown): value is Installation {
  if (!value || typeof value !== "object" || !("sample_data" in value))
    return false;
  const sample = value.sample_data;
  if (sample === null) return true;
  if (!sample || typeof sample !== "object") return false;
  const record = sample as Record<string, unknown>;
  return (
    ["dataset_id", "generator_version", "seed"].every(
      (key) => typeof record[key] === "string",
    ) &&
    ["from", "to", "completed_at"].every(
      (key) =>
        Number.isSafeInteger(record[key]) &&
        Number(record[key]) >= 0 &&
        Number(record[key]) <= 8.64e15,
    ) &&
    Number(record.from) <= Number(record.to)
  );
}
export function InstallationContext() {
  const resource = useResource<Installation>(
    "/installation",
    validInstallation,
  );
  const sample = resource.data?.sample_data;
  if (resource.error)
    return (
      <p className="installation-context">
        Installation context could not be checked.{" "}
        <button onClick={() => void resource.refresh()}>Retry</button>
      </p>
    );
  if (!sample) return null;
  return (
    <aside
      className="installation-context sample-context"
      aria-label="Sample installation"
    >
      <strong>Sample data</strong>
      <span>This installation contains generated activity.</span>
      <Link
        to={`/?${new URLSearchParams({
          from: String(sample.from),
          to: String(sample.to),
        })}`}
      >
        Explore sample period →
      </Link>
    </aside>
  );
}

export function Overview() {
  const { params, setParams, ready, scopeError } =
    useActivityWindow("decision");
  const resource = useAnalytics(
    ready ? params : new URLSearchParams(),
    "decision",
  );
  const [error, setError] = useState<string | null>(null);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams(params);
    const check = String(form.get("check") ?? "").trim();
    if (check) next.set("check", check);
    else next.delete("check");
    try {
      const window = formWindow(form, params, Date.now());
      for (const key of ["from", "to", "range"]) next.delete(key);
      for (const [key, value] of window) next.set(key, value);
      if (Number(next.get("to")) - Number(next.get("from")) >= 31 * 86_400_000)
        throw new Error("Choose up to 31 days for this overview.");
      setError(null);
      setParams(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function refresh() {
    const next = refreshedWindow(params, Date.now());
    if (next.toString() !== params.toString()) setParams(next);
    else void resource.refresh();
  }
  if (scopeError)
    return (
      <div className="overview-page">
        <PageTitle title="Overview" />
        <Notice>
          <p>{scopeError}</p>
          <button onClick={() => setParams(new URLSearchParams())}>
            Reset filters
          </button>
        </Notice>
      </div>
    );
  return (
    <div className="overview-page">
      <PageTitle title="Overview">
        <button disabled={resource.loading || !ready} onClick={refresh}>
          {resource.loading && resource.data ? "Refreshing…" : "Refresh"}
        </button>
      </PageTitle>
      <div className="overview-intro">
        <p>Trust decisions across your application.</p>
        <details className="quick-lookup">
          <summary>Find a user or context</summary>
          <EntityLookup params={params} />
        </details>
      </div>
      <form
        className="overview-filters"
        onSubmit={apply}
        key={params.toString()}
      >
        <label>
          Check
          <input
            name="check"
            defaultValue={params.get("check") ?? ""}
            placeholder="All protected actions…"
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
          />
        </label>
        <ActivityRange params={params} />
        <button type="submit">Apply</button>
        <span className="time-zone-label">UTC</span>
      </form>
      <ActiveScopeFilters
        params={params}
        keys={["operation_id", "entity", "outcome", "reason"]}
        onChange={setParams}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {ready && resource.path === null && (
        <p className="notice" role="alert">
          Choose a valid interval of up to 31 days to see this overview.
        </p>
      )}
      <AnalyticsPanel resource={resource} summaries breakdowns />
      <p className="help">
        <Link to="/settings#connection">Application connection →</Link>
      </p>
    </div>
  );
}
