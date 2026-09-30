import { readPolicyResponse } from "./policy-response";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

export interface Mutation {
  path: string;
  method: "POST" | "PUT" | "DELETE";
  body: unknown;
  key: string;
}
export function mutation(
  path: string,
  body: unknown,
  method: Mutation["method"] = "POST",
): Mutation {
  return { path, method, body, key: crypto.randomUUID() };
}

// Authentication, throttling and timeouts can precede a durable replay lookup.
// They cannot establish whether an earlier submission of this intent committed.
export function definitiveMutationFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 429].includes(error.status) &&
    error.code !== "invalid_response"
  );
}

export class Api {
  csrf = "";
  onUnauthorized: (() => void) | undefined;
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/v1/admin${path}`, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json", ...init.headers },
      });
      if ([401, 403].includes(response.status) && path !== "/session")
        this.onUnauthorized?.();
      if (response.status === 204) return undefined as T;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError(
          response.status,
          "invalid_response",
          response.status >= 500
            ? "Krine is unavailable. The request may have succeeded; retry to recover its result."
            : "Krine returned an unreadable response. Retry the request.",
        );
      }
      if (!response.ok) {
        const error = (
          body as {
            error?: {
              code?: string;
              message?: string;
              details?: { path: string; message: string }[];
            };
          }
        )?.error;
        throw new ApiError(
          response.status,
          error?.code ?? "request_failed",
          error?.message ?? `Request failed (${response.status}).`,
          error?.details ?? [],
        );
      }
      try {
        return readPolicyResponse(path, init.method ?? "GET", body) as T;
      } catch {
        throw new ApiError(
          response.status,
          "invalid_response",
          "Krine returned an unreadable policy. Retry to load it or recover the original request.",
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        0,
        "connection_failed",
        "Could not reach Krine. Your changes remain here. Retry when the connection returns.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }
  run<T>(operation: Mutation): Promise<T> {
    return this.request<T>(operation.path, {
      method: operation.method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": this.csrf,
        "Idempotency-Key": operation.key,
      },
      body: JSON.stringify(operation.body),
    });
  }
  async session(password?: string): Promise<void> {
    const session = await this.request<{
      csrf_token: string;
      expires_at: number;
    }>(
      "/session",
      password === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          },
    );
    if (
      !session ||
      typeof session.csrf_token !== "string" ||
      !session.csrf_token ||
      !Number.isSafeInteger(session.expires_at)
    )
      throw new ApiError(
        200,
        "invalid_response",
        "Krine could not confirm your session. Sign in again.",
      );
    this.csrf = session.csrf_token;
  }
}
export const api = new Api();
export const encode = encodeURIComponent;
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request failed. Please retry.";
}

export function readErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "Could not load this information. Retry to refresh the page.";
  if (error.status === 401)
    return "Sign in again, then retry loading this information.";
  if (error.status === 403)
    return "You do not have access to this information.";
  if (error.status === 404)
    return "This record was not found. Check the link or return to the previous page.";
  if (error.status === 429)
    return "Too many requests. Wait briefly, then retry loading this information.";
  if (
    error.status === 0 ||
    error.status >= 500 ||
    error.code === "invalid_response"
  )
    return "Could not load this information from Krine. Retry when the connection is available.";
  return error.message;
}
