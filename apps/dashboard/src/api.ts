import { object, validMethods, validSession, sameOwner } from "./operator";
import type {
  AuthMethods,
  OperatorSession,
  IntentOwner,
  OperatorReveal,
} from "./operator";
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

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}
function validErrorResponse(body: unknown): body is ErrorResponse {
  if (!object(body) || !object(body.error)) return false;
  const error = body.error;
  return (
    typeof error.code === "string" &&
    error.code.length > 0 &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    (error.details === undefined ||
      (Array.isArray(error.details) &&
        error.details.every(
          (detail) =>
            object(detail) &&
            typeof detail.path === "string" &&
            typeof detail.message === "string",
        )))
  );
}

export interface Mutation {
  path: string;
  method: "POST" | "PUT" | "DELETE";
  body: unknown;
  key: string;
  owner: IntentOwner;
}
export function mutation(
  path: string,
  body: unknown,
  method: Mutation["method"] = "POST",
): Mutation {
  return {
    path,
    method,
    body,
    key: crypto.randomUUID(),
    owner: api.requireOwner(),
  };
}

// Authentication, throttling and timeouts can precede a durable replay lookup.
// They cannot establish whether an earlier submission of this intent committed.
export function definitiveMutationFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 429].includes(error.status) &&
    !["invalid_response", "actor_changed", "stale_authority"].includes(
      error.code,
    )
  );
}

export class Api {
  csrf = "";
  onUnauthorized: (() => void) | undefined;
  onPrivilegeChanged: (() => void) | undefined;
  methods: AuthMethods | null = null;
  current: OperatorSession | null = null;
  suspended = false;
  revealedCredential: OperatorReveal | null = null;
  private epoch = 0;
  private responseGeneration = 0;
  private authSequence = 0;
  private requests = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private snapshot = {
    session: this.current,
    suspended: false,
    epoch: 0,
    revealedCredential: this.revealedCredential,
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private notify() {
    this.snapshot = {
      session: this.current,
      suspended: this.suspended,
      epoch: this.epoch,
      revealedCredential: this.revealedCredential,
    };
    this.listeners.forEach((fn) => fn());
  }
  revealCredential(value: OperatorReveal | null) {
    this.revealedCredential = value;
    this.notify();
  }
  owner(): IntentOwner | null {
    return this.methods && this.current
      ? {
          installation_id: this.methods.installation_id,
          actor_id: this.current.actor_id,
        }
      : null;
  }
  requireOwner(): IntentOwner {
    const owner = this.owner();
    if (!owner)
      throw new ApiError(
        401,
        "unauthenticated",
        "Sign in before making changes.",
      );
    return owner;
  }
  suspend() {
    if (!this.suspended) {
      this.suspended = true;
      this.notify();
    }
    this.onUnauthorized?.();
  }
  invalidateRequests() {
    this.responseGeneration++;
    this.requests.forEach((controller) => controller.abort());
    this.requests.clear();
  }
  clear() {
    this.authSequence++;
    this.invalidateRequests();
    this.current = null;
    this.revealedCredential = null;
    this.csrf = "";
    this.suspended = false;
    this.epoch++;
    this.notify();
  }
  acceptSession(value: unknown) {
    if (!validSession(value) || !this.methods)
      throw new ApiError(
        200,
        "invalid_response",
        "Krine could not confirm your session. Sign in again.",
      );
    const changed =
      this.current?.actor_id !== value.actor_id ||
      this.current.authentication_method !== value.authentication_method ||
      this.current.capabilities.join() !== value.capabilities.join();
    if (changed) {
      this.revealedCredential = null;
      this.epoch++;
      this.invalidateRequests();
    }
    this.current = value;
    this.csrf = value.csrf_token;
    this.suspended = false;
    this.notify();
  }
  async authMethods() {
    const value = await this.request<unknown>("/auth/methods", {}, true);
    if (!validMethods(value))
      throw new ApiError(
        200,
        "invalid_response",
        "Krine could not confirm available sign-in methods.",
      );
    if (this.methods && this.methods.installation_id !== value.installation_id)
      this.clear();
    this.methods = value;
    return value;
  }
  async request<T>(
    path: string,
    init: RequestInit = {},
    publicRequest = false,
  ): Promise<T> {
    const epoch = this.responseGeneration;
    const controller = new AbortController();
    if (!publicRequest) this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/v1/admin${path}`, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json", ...init.headers },
      });
      if (!publicRequest && epoch !== this.responseGeneration)
        throw new ApiError(
          409,
          "stale_authority",
          "This response belongs to an earlier operator session. Inspect the current resource before continuing.",
        );
      if (response.status === 401 && !publicRequest) this.suspend();
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
      if (!publicRequest && epoch !== this.responseGeneration)
        throw new ApiError(
          409,
          "stale_authority",
          "This response belongs to an earlier operator session.",
        );
      if (!response.ok) {
        if (!validErrorResponse(body))
          throw new ApiError(
            response.status,
            "invalid_response",
            "Krine returned an unreadable error response. The request may have succeeded; retry the same request to recover its result.",
          );
        const { error } = body;
        if (
          response.status === 403 &&
          !publicRequest &&
          ["insufficient_privilege", "csrf_failed"].includes(error.code)
        )
          this.onPrivilegeChanged?.();
        throw new ApiError(
          response.status,
          error.code,
          error.message,
          error.details ?? [],
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
      this.requests.delete(controller);
    }
  }
  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }
  run<T>(operation: Mutation): Promise<T> {
    if (!sameOwner(operation.owner, this.owner()))
      return Promise.reject(
        new ApiError(
          409,
          "actor_changed",
          "This request belongs to a different operator or installation. Its earlier result may still exist; inspect the resource and audit before creating another request.",
        ),
      );
    if (this.suspended)
      return Promise.reject(
        new ApiError(
          401,
          "unauthenticated",
          "Sign in again, then deliberately retry the original request.",
        ),
      );
    return this.request<T>(operation.path, {
      method: operation.method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": this.csrf,
        "Idempotency-Key": operation.key,
        "X-Krine-Operator-ID": operation.owner.actor_id,
      },
      body: JSON.stringify(operation.body),
    });
  }
  async session(credentials?: {
    sign_in_name: string;
    credential: string;
  }): Promise<void> {
    const sequence = ++this.authSequence;
    const value = await this.request<unknown>(
      "/session",
      credentials
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(credentials),
          }
        : {},
      true,
    );
    if (sequence !== this.authSequence)
      throw new ApiError(
        409,
        "stale_authority",
        "A newer sign-in superseded this session response.",
      );
    this.acceptSession(value);
  }
  async recover(token: string) {
    const sequence = ++this.authSequence;
    const value = await this.publicPost<unknown>("/auth/recovery/session", {
      token,
    });
    if (sequence !== this.authSequence)
      throw new ApiError(
        409,
        "stale_authority",
        "A newer sign-in superseded this recovery response.",
      );
    this.acceptSession(value);
  }
  publicPost<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      true,
    );
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
