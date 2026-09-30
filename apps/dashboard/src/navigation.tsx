import { useLayoutEffect, useRef } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import type { LinkProps } from "react-router-dom";
import { profileScopeError } from "./subject-profile";

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
      "reason",
      "provenance",
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

function profileUrl(value: string | null): string | null {
  if (!value || value.length > 16384) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      url.pathname !== "/inspect/entity" ||
      url.hash
    )
      return null;
    const params = url.searchParams;
    if (
      profileScopeError(
        params,
        params.get("kind") ?? "",
        params.get("id") ?? "",
      ) ||
      !params.has("from") ||
      !params.has("to")
    )
      return null;
    if (params.has("return_to") && !activityUrl(params.get("return_to")))
      return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function useProfileOrigin() {
  const location = useLocation();
  const route = useParams();
  const params = new URLSearchParams(location.search);
  if (location.pathname === "/inspect/entity")
    return profileUrl(`${location.pathname}${location.search}`);
  if (location.pathname.startsWith("/entities/") && route.kind && route.id) {
    params.set("kind", route.kind);
    params.set("id", route.id);
    return profileUrl(`/inspect/entity?${params}`);
  }
  return params.getAll("subject_return").length === 1
    ? profileUrl(params.get("subject_return"))
    : null;
}

export function investigationInterval(url: string | null) {
  if (!url) return null;
  const params = new URL(url, window.location.origin).searchParams;
  const from = params.get("from"),
    to = params.get("to");
  if (
    params.getAll("from").length !== 1 ||
    params.getAll("to").length !== 1 ||
    !/^\d+$/.test(from ?? "") ||
    !/^\d+$/.test(to ?? "") ||
    !Number.isSafeInteger(Number(from)) ||
    !Number.isSafeInteger(Number(to)) ||
    Number(to) > 8.64e15 ||
    Number(from) > Number(to)
  )
    return null;
  return { from: from!, to: to! };
}

/** Carry an exact interval and bounded return destinations through an investigation. */
export function InvestigationLink({ to, onClick, ...props }: LinkProps) {
  const location = useLocation();
  const origin = useActivityOrigin();
  const profile = useProfileOrigin();
  let target = to;
  if (typeof to === "string") {
    const url = new URL(
      to,
      `${window.location.origin}${location.pathname}${location.search}`,
    );
    if (url.origin === window.location.origin && url.pathname !== "/activity") {
      if (origin) url.searchParams.set("return_to", origin);
      if (url.pathname === "/inspect/entity") {
        const interval =
          investigationInterval(profile) ?? investigationInterval(origin);
        if (
          interval &&
          !url.searchParams.has("from") &&
          !url.searchParams.has("to")
        ) {
          url.searchParams.set("from", interval.from);
          url.searchParams.set("to", interval.to);
        }
      } else if (profile) url.searchParams.set("subject_return", profile);
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
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const profile =
    params.getAll("subject_return").length === 1
      ? profileUrl(params.get("subject_return"))
      : null;
  return (
    <span className="investigation-return">
      {profile && <Link to={profile}>Back to subject</Link>}
      <Link to={origin ?? (events ? "/activity?view=events" : "/activity")}>
        Back to Activity{events ? " · Events" : ""}
      </Link>
    </span>
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
