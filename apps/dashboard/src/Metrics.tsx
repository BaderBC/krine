import { useParams, useSearchParams } from "react-router-dom";
import {
  InvestigationLink as Link,
  ActivityReturn,
  useActivityOrigin,
} from "./navigation";
import { encode } from "./api";
import { Loading, ResourceError, PageTitle, useResource } from "./shared";
import type { Metric, Page } from "./types";

export function Metrics() {
  const [params, setParams] = useSearchParams();
  const resource = useResource<Page<Metric>>("/metrics?limit=100");
  const search = (params.get("q") ?? "").toLowerCase();
  const kind = params.get("kind") ?? "";
  const items = resource.data?.items.filter(
    (metric) =>
      (!kind || metric.kind === kind) &&
      `${metric.name} ${metric.description}`.toLowerCase().includes(search),
  );
  return (
    <>
      <PageTitle title="Metrics" />
      <p className="intro">
        Read what a policy can know, where the evidence comes from, and what
        missing data means.
      </p>
      <form
        className="inline-fields"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setParams({
            q: String(data.get("q") ?? ""),
            kind: String(data.get("kind") ?? ""),
          });
        }}
      >
        <label>
          Search metrics
          <input
            name="q"
            type="search"
            autoComplete="off"
            defaultValue={params.get("q") ?? ""}
            placeholder="Name or meaning…"
          />
        </label>
        <label>
          Kind
          <select name="kind" defaultValue={kind}>
            <option value="">All metrics</option>
            <option value="primitive">Primitive</option>
            <option value="derived">Derived</option>
          </select>
        </label>
        <button type="submit">Find</button>
      </form>
      {resource.error && <ResourceError resource={resource} />}
      {items ? (
        <ul className="catalog">
          {items.map((metric) => (
            <li key={`${metric.name}@${metric.version}`}>
              <div className="catalog-heading">
                <Link
                  className="record-name"
                  to={`/metrics/${encode(metric.name)}?version=${metric.version}`}
                >
                  {metric.name}
                </Link>
                <span className="help">
                  {metric.kind} · v{metric.version}
                </span>
              </div>
              <p>{metric.description}</p>
            </li>
          ))}
          {items.length === 0 && (
            <li>No matching metrics. Change the name, meaning or kind.</li>
          )}
        </ul>
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </>
  );
}

export function MetricPage() {
  const origin = useActivityOrigin();
  const { name = "" } = useParams();
  const [params] = useSearchParams();
  const resource = useResource<Metric>(
    `/metrics/${encode(name)}/versions/${encode(params.get("version") ?? "1")}`,
  );
  const metric = resource.data;
  return (
    <>
      {resource.error && <ResourceError resource={resource} />}
      {metric ? (
        <article className="reference">
          {origin && <ActivityReturn />}
          <PageTitle
            title={metric.name}
            eyebrow={<Link to="/metrics">Metrics</Link>}
          />
          <p className="lead">{metric.description}</p>
          <dl className="facts">
            <div>
              <dt>Version</dt>
              <dd>{metric.version}</dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{metric.kind}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>
                {metric.value_type}
                {metric.range && ` · ${metric.range[0]} to ${metric.range[1]}`}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{metric.source.replaceAll("_", " ")}</dd>
            </div>
          </dl>
          <h2>Missing data</h2>
          <p>{metric.missing}</p>
          {metric.dependencies.length > 0 && (
            <>
              <h2>Dependencies</h2>
              <ul>
                {metric.dependencies.map((dependency) => {
                  const [metricName, version] = dependency.split("@");
                  return (
                    <li key={dependency}>
                      <Link
                        to={`/metrics/${encode(metricName!)}?version=${version}`}
                      >
                        {dependency}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <h2>Examples</h2>
          <ul>
            {metric.examples.map((example) => (
              <li key={example}>{example}</li>
            ))}
          </ul>
          {(metric.source === "ip_intelligence" ||
            metric.source === "verification") && (
            <Link to="/settings#providers">Provider settings →</Link>
          )}
          <p className="help footnote">
            Policies pin metric versions. Reading a definition never changes a
            running policy.
          </p>
        </article>
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </>
  );
}
