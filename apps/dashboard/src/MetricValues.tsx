import { InvestigationLink as Link } from "./navigation";
import { encode } from "./api";
import { scalarLabel } from "./policy";
import { Time } from "./shared";
import type { MetricObservation } from "./types";
const reasonLabel = (value: string) => value.replaceAll("_", " ");

export function MetricValues({
  metrics,
}: {
  metrics: Record<string, MetricObservation>;
}) {
  return (
    <dl className="metric-values">
      {Object.entries(metrics).map(([name, observation]) => (
        <div key={name}>
          <dt>
            <Link
              translate="no"
              to={`/metrics/${encode(name)}?version=${observation.version}`}
            >
              {name} v{observation.version}
            </Link>
          </dt>
          <dd>
            {observation.state.status === "known"
              ? scalarLabel(observation.state.value)
              : `Unknown · ${reasonLabel(observation.state.reason)}`}
            <p className="help">
              {reasonLabel(observation.provenance.source)} · Observed{" "}
              <Time at={observation.provenance.observed_at} />
            </p>
          </dd>
        </div>
      ))}
    </dl>
  );
}
