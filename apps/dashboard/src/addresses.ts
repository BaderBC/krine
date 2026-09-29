import { useLocation, useParams } from "react-router-dom";

// Keep caller-owned identifiers in query values: even percent-encoded dot path
// segments are normalized by browsers before the request reaches Krine.
const query = (values: Record<string, string>) =>
  new URLSearchParams(values).toString();
export const checkPath = (name: string, suffix = "") =>
  `/lookup/checks${suffix}?${query({ name })}`;
export const eventPath = (id: string) => `/lookup/events?${query({ id })}`;
export const entityPath = (kind: string, id: string, suffix = "") =>
  `/lookup/entities${suffix}?${query({ kind, id })}`;
export const relationshipPath = (
  item: { kind: string; id: string },
  suffix = "",
) =>
  `/lookup/relationships${suffix}?${query({ kind: item.kind, id: item.id })}`;
export const checkUrl = (name: string) => `/inspect/check?${query({ name })}`;
export const eventUrl = (id: string) => `/inspect/event?${query({ id })}`;
export const entityUrl = (kind: string, id: string) =>
  `/inspect/entity?${query({ kind, id })}`;

/** Legacy links remain readable; canonical selectors are unique and decoded once. */
export function useAddressedParam(key: string): string {
  const params = useParams();
  const location = useLocation();
  if (!location.pathname.startsWith("/inspect/")) return params[key] ?? "";
  return uniqueSelector(new URLSearchParams(location.search), key);
}
export function changeSearch(
  params: URLSearchParams,
  changes: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

export function uniqueSelector(params: URLSearchParams, key: string): string {
  const values = params.getAll(key);
  return values.length === 1 ? values[0]! : "";
}
