import { useLayoutEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import type { LinkProps } from "react-router-dom";

function activityUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== "/activity")
      return null;
    const allowed = new Set([
      "view",
      "check",
      "operation_id",
      "outcome",
      "entity",
      "entity_kind",
      "name",
      "from",
      "to",
      "range",
      "cursor",
    ]);
    for (const key of [...url.searchParams.keys()])
      if (!allowed.has(key)) url.searchParams.delete(key);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
export function useActivityOrigin(): string | null {
  const location = useLocation();
  return location.pathname === "/activity"
    ? activityUrl(`${location.pathname}${location.search}`)
    : activityUrl(new URLSearchParams(location.search).get("return_to"));
}
const scrollKey = (url: string) => `krine:activity-scroll:${url}`;
export function rememberActivityPosition(origin: string | null) {
  if (!origin) return;
  try {
    sessionStorage.setItem(scrollKey(origin), String(window.scrollY));
  } catch {
    /* URL context remains available when browser storage is disabled. */
  }
}

/** Ordinary links carry a bounded, same-origin investigation context across detail pages. */
export function InvestigationLink({ to, onClick, ...props }: LinkProps) {
  const location = useLocation();
  const origin = useActivityOrigin();
  let target = to;
  if (origin && typeof to === "string") {
    const url = new URL(
      to,
      `${window.location.origin}${location.pathname}${location.search}`,
    );
    if (url.origin === window.location.origin && url.pathname !== "/activity") {
      url.searchParams.set("return_to", origin);
      target = `${url.pathname}${url.search}${url.hash}`;
    }
  }
  return (
    <Link
      {...props}
      to={target}
      onClick={(event) => {
        if (location.pathname === "/activity") rememberActivityPosition(origin);
        onClick?.(event);
      }}
    />
  );
}
export function ActivityReturn({ events = false }: { events?: boolean }) {
  const origin = useActivityOrigin();
  return (
    <Link to={origin ?? (events ? "/activity?view=events" : "/activity")}>
      Back to Activity{events ? " · Events" : ""}
    </Link>
  );
}
export function useActivityScroll(ready: boolean) {
  const location = useLocation();
  const restored = useRef<string | null>(null);
  const scope = `${location.pathname}${location.search}`;
  useLayoutEffect(() => {
    if (!ready || restored.current === scope) return;
    restored.current = scope;
    let top = 0;
    try {
      top = Number(sessionStorage.getItem(scrollKey(scope)) ?? 0);
    } catch {
      /* Begin at the top without storage. */
    }
    window.scrollTo({
      top: Number.isFinite(top) && top >= 0 ? top : 0,
      behavior: "instant",
    });
  }, [ready, scope]);
}
