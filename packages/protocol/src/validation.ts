import type { BrowserContext, Challenge, CheckRequest, Evaluation, PreparedAction } from './types.js';

export class KrineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'KrineError';
  }
}

export function invalidInput(): never {
  throw new KrineError('invalid_input', 'Invalid Krine SDK input.');
}

export function invalidResponse(): never {
  throw new KrineError('invalid_response', 'Krine returned an invalid or mismatched response.');
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function string(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= max;
}

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
}

export function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function ipAddress(value: unknown): value is string {
  if (!string(value, 64)) return false;
  if (!value.includes(':')) {
    const parts = value.split('.');
    return parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
  }
  if (!/^[a-fA-F0-9:.]+$/.test(value)) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith('['); } catch { return false; }
}

export function scalar(value: unknown): value is string | boolean | number {
  return typeof value === 'boolean' || (typeof value === 'string' && new TextEncoder().encode(value).length <= 1024)
    || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

export function validateCheckRequest(value: unknown): asserts value is CheckRequest {
  if (!record(value) || !exactKeys(value, ['operation_id', 'check', 'proof', 'ip', 'user_id', 'inputs'])
    || !identifier(value.operation_id) || !identifier(value.check) || !string(value.proof, 4096)
    || !ipAddress(value.ip) || (value.user_id !== undefined && !string(value.user_id, 256))) invalidInput();
  if (value.inputs !== undefined && (!record(value.inputs) || Object.keys(value.inputs).length > 32
    || !Object.entries(value.inputs).every(([key, item]) => identifier(key) && scalar(item)))) invalidInput();
}

export function isChallenge(value: unknown): value is Challenge {
  return record(value) && identifier(value.challenge_id) && value.provider === 'turnstile'
    && string(value.site_key, 256) && typeof value.action === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value.action)
    && typeof value.binding === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(value.binding) && timestamp(value.expires_at);
}

export function parseEvaluation(value: unknown, request: CheckRequest): Evaluation {
  if (!record(value) || value.source !== 'evaluation' || value.operation_id !== request.operation_id
    || value.check !== request.check || !identifier(value.decision_id) || !timestamp(value.policy_version)
    || value.policy_version < 1 || !timestamp(value.accepted_at) || !timestamp(value.retry_until)
    || value.retry_until <= value.accepted_at || !string(value.reason, 128)) invalidResponse();
  if (value.outcome === 'CHALLENGE_REQUIRED') {
    if (!isChallenge(value.challenge) || value.challenge.expires_at <= value.accepted_at
      || value.challenge.expires_at > value.retry_until) invalidResponse();
  } else if ((value.outcome !== 'ALLOW' && value.outcome !== 'DENY') || value.challenge !== undefined) invalidResponse();
  return value as unknown as Evaluation;
}

export function parseContext(value: unknown): BrowserContext {
  if (!record(value) || !identifier(value.client_id) || !identifier(value.session_id)
    || !string(value.client_token, 4096) || !string(value.session_token, 4096) || !timestamp(value.expires_at)) invalidResponse();
  return value as unknown as BrowserContext;
}

export function parseProof(value: unknown, context: BrowserContext): PreparedAction {
  if (!record(value) || value.client_id !== context.client_id || value.session_id !== context.session_id
    || !string(value.proof, 4096) || !timestamp(value.expires_at)) invalidResponse();
  return value as unknown as PreparedAction;
}

/** Reject values JSON would silently change, including non-finite numbers and class instances. */
export function jsonBody(value: unknown, maxBytes = 65_536, maxStringBytes = 4096): string {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 16) invalidInput();
    if (item === null || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER)
      || (typeof item === 'string' && new TextEncoder().encode(item).length <= maxStringBytes)) return;
    if (typeof item !== 'object' || item === null || seen.has(item)) invalidInput();
    if (!Array.isArray(item) && !record(item)) invalidInput();
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      for (const [key, child] of Object.entries(item)) {
        if (new TextEncoder().encode(key).length > 1024) invalidInput();
        visit(child, depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > maxBytes) invalidInput();
  return body;
}
