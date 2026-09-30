import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { encode } from "./api";
import {
  Loading,
  Pagination,
  ResourceError,
  Time,
  useResource,
} from "./shared";
import {
  identifier,
  object,
  textValue,
  timestamp,
  validPage,
} from "./operator";
import type { Page } from "./types";
interface AuditItem {
  id: string;
  at: number;
  actor: { id: string; type: string; name: string };
  action: string;
  resource: { type: string; id: string };
  reason: string | null;
  changes: Record<string, unknown>;
}
interface AuditPage extends Page<AuditItem> {
  coverage: { days: number; started_at: number; available_since: number };
}
function validAudit(v: unknown): v is AuditPage {
  return (
    object(v) &&
    object(v.coverage) &&
    v.coverage.days === 365 &&
    timestamp(v.coverage.started_at) &&
    timestamp(v.coverage.available_since) &&
    validPage(
      v,
      (x): x is AuditItem =>
        object(x) &&
        identifier(x.id) &&
        timestamp(x.at) &&
        object(x.actor) &&
        identifier(x.actor.id) &&
        (x.actor.type === "operator" ||
          x.actor.type === "installation_recovery" ||
          x.actor.type === "installation_configuration") &&
        textValue(x.actor.name, 128) &&
        identifier(x.action) &&
        object(x.resource) &&
        identifier(x.resource.type) &&
        identifier(x.resource.id) &&
        (x.reason === null || textValue(x.reason, 512)) &&
        object(x.changes),
    )
  );
}
export function OperatorAudit() {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams({ limit: "50" });
  for (const key of ["actor_id", "resource_type", "resource_id", "cursor"]) {
    const value = params.get(`audit_${key}`);
    if (value) query.set(key, value);
  }
  const resource = useResource<AuditPage>(`/audit?${query}`, validAudit);
  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const key of ["actor_id", "resource_type", "resource_id"]) {
        const value = String(data.get(key) ?? "");
        if (value) next.set(`audit_${key}`, value);
        else next.delete(`audit_${key}`);
      }
      next.delete("audit_cursor");
      return next;
    });
  }
  return (
    <section>
      <h2>Administrative audit</h2>
      <p className="help">
        Attributed configuration and access changes. Legacy resources may have
        no named actor.
      </p>
      <form key={query.toString()} className="audit-filters" onSubmit={filter}>
        {[
          ["actor_id", "Actor ID"],
          ["resource_type", "Resource type"],
          ["resource_id", "Resource ID"],
        ].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              name={key}
              defaultValue={params.get(`audit_${key}`) ?? ""}
              autoComplete="off"
              maxLength={256}
            />
          </label>
        ))}
        <button type="submit">Filter audit</button>
      </form>
      <ResourceError resource={resource} />
      {resource.data ? (
        <>
          <p className="help">
            Retained for {resource.data.coverage.days} days. Coverage began{" "}
            <Time at={resource.data.coverage.started_at} />; available since{" "}
            <Time at={resource.data.coverage.available_since} />.
          </p>
          {resource.data.items.length ? (
            <ol className="audit-list">
              {resource.data.items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>
                      {item.action.replaceAll("_", " ").replaceAll(".", " · ")}
                    </strong>
                    <Time at={item.at} />
                  </div>
                  <p>
                    {item.actor.name}{" "}
                    <span className="help identifier">({item.actor.id})</span> ·{" "}
                    {item.actor.type === "installation_recovery"
                      ? "Host recovery"
                      : item.actor.type === "installation_configuration"
                        ? "Host configuration"
                        : "Operator"}
                  </p>
                  <p>
                    {item.resource.type} ·{" "}
                    {item.resource.type === "operator" &&
                    /^op_[A-Za-z0-9_-]+$/.test(item.resource.id) ? (
                      <Link
                        to={`/settings?view=operators&operator=${encode(item.resource.id)}`}
                      >
                        {item.resource.id}
                      </Link>
                    ) : (
                      <span className="identifier">{item.resource.id}</span>
                    )}
                  </p>
                  {item.reason && <p>{item.reason}</p>}
                  <dl className="audit-changes">
                    {Object.entries(item.changes)
                      .filter(
                        ([key, value]) =>
                          [
                            "revision",
                            "previous_revision",
                            "previous_version",
                            "restored_from_version",
                            "previous_days",
                            "days",
                            "local_enabled",
                            "status",
                            "session_id",
                            "role",
                            "previous_role",
                            "state",
                            "previous_state",
                            "version",
                            "enabled",
                            "provider",
                            "count",
                            "revoked",
                            "label",
                            "kind",
                          ].includes(key) &&
                          (typeof value === "string" ||
                            typeof value === "number" ||
                            typeof value === "boolean" ||
                            value === null),
                      )
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt>{key.replaceAll("_", " ")}</dt>
                          <dd>{value === null ? "Not set" : String(value)}</dd>
                        </div>
                      ))}
                  </dl>
                </li>
              ))}
            </ol>
          ) : (
            <p>No audit entries match this selection.</p>
          )}
          <Pagination
            page={resource.data}
            onNext={(cursor) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("audit_cursor", cursor);
                return next;
              })
            }
          />
        </>
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </section>
  );
}
