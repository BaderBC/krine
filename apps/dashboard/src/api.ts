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
        if (response.status === 401 && path !== "/session")
          this.onUnauthorized?.();
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
      return body as T;
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
