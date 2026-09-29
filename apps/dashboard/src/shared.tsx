import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { InvestigationLink as Link } from "./navigation";
import { api, encode, readErrorMessage } from "./api";
import type { Page } from "./types";

export function useResource<T>(path: string | null) {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error: string | null;
    loading: boolean;
    refreshed: number | null;
  }>({ path, error: null, loading: Boolean(path), refreshed: null });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!path) {
      setState({ path, loading: false, error: null, refreshed: null });
      return;
    }
    setState((previous) =>
      previous.path === path
        ? { ...previous, loading: true, error: null }
        : { path, loading: true, error: null, refreshed: null },
    );
    try {
      const data = await api.get<T>(path);
      if (current === generation.current)
        setState({
          path,
          data,
          loading: false,
          error: null,
          refreshed: Date.now(),
        });
    } catch (error) {
      if (current === generation.current)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: readErrorMessage(error),
        }));
    }
  }, [path]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return {
    ...state,
    data: state.path === path ? state.data : undefined,
    loading: state.path === path ? state.loading : Boolean(path),
    error: state.path === path ? state.error : null,
    refreshed: state.path === path ? state.refreshed : null,
    refresh,
  };
}
export function Notice({
  children,
  retry,
}: {
  children: ReactNode;
  retry?: () => void;
}) {
  return (
    <div className="notice" role="alert">
      <div>{children}</div>
      {retry && <button onClick={retry}>Retry</button>}
    </div>
  );
}
export function ResourceError({
  resource,
}: {
  resource: {
    error: string | null;
    data: unknown;
    refreshed: number | null;
    refresh: () => Promise<void>;
  };
}) {
  return resource.error ? (
    <Notice retry={() => void resource.refresh()}>
      {resource.error}
      {resource.data !== undefined && resource.refreshed !== null && (
        <p className="help">
          Showing stale data. Last successful refresh:{" "}
          <Time at={resource.refreshed} />.
        </p>
      )}
    </Notice>
  ) : null;
}
export function Loading() {
  return (
    <p className="muted" role="status">
      Loading…
    </p>
  );
}
export function Time({ at }: { at: number | null | undefined }) {
  if (at == null) return <>Not recorded</>;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return <>Invalid timestamp</>;
  const exact = `${date.toISOString()} (UTC)`;
  const readable = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return (
    <time
      className="timestamp"
      tabIndex={0}
      dateTime={date.toISOString()}
      title={exact}
      aria-label={exact}
    >
      <span aria-hidden="true">{readable}</span>
      <span className="timestamp-exact" aria-hidden="true">
        {exact}
      </span>
    </time>
  );
}
export function PageTitle({
  title,
  children,
  eyebrow,
}: {
  title: string;
  children?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="page-title">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <div className="title-row">
        <h1>{title}</h1>
        <div className="actions">{children}</div>
      </div>
    </header>
  );
}
export function JsonDetails({
  title = "Properties",
  value,
}: {
  title?: string;
  value: unknown;
}) {
  return (
    <details>
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function EntityLink({
  kind,
  id,
}: {
  kind: string;
  id: string | null | undefined;
}) {
  return id ? (
    <Link
      translate="no"
      className="identifier"
      to={`/entities/${encode(kind)}/${encode(id)}`}
    >
      {id}
    </Link>
  ) : (
    <span className="muted">Not provided</span>
  );
}
export function Identifiers({
  record,
}: {
  record: {
    client_id?: string | null;
    session_id?: string | null;
    user_id?: string | null;
    ip?: string | null;
  };
}) {
  return (
    <dl className="facts">
      {(["client", "user", "ip", "session"] as const).map((kind) => {
        const key = kind === "ip" ? "ip" : (`${kind}_id` as const);
        const value = record[key];
        return value ? (
          <div key={kind}>
            <dt>
              {kind === "ip" ? "IP" : kind[0]!.toUpperCase() + kind.slice(1)}
            </dt>
            <dd>
              <EntityLink kind={kind} id={value} />
            </dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}
export function Pagination({
  page,
  onNext,
}: {
  page: Page<unknown>;
  onNext: (cursor: string) => void;
}) {
  return page.next_cursor ? (
    <div className="pagination">
      <button onClick={() => onNext(page.next_cursor!)}>Next page →</button>
    </div>
  ) : null;
}
