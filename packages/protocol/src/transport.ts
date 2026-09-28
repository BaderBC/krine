import { invalidInput, invalidResponse, KrineError, record, string } from './validation.js';

export type Fetch = typeof globalThis.fetch;
export type AvailabilityReason = 'timeout' | 'unavailable' | 'rate_limited';

export class AvailabilityError extends KrineError {
  constructor(readonly reason: AvailabilityReason, readonly retryAfterMs = 0) {
    super(reason, `Krine request ${reason === 'timeout' ? 'timed out' : 'is unavailable'}.`);
    this.name = 'AvailabilityError';
  }
}

export class HttpError extends KrineError {
  constructor(readonly status: number, code: string) {
    super(code, `Krine rejected the request (HTTP ${status}).`);
    this.name = 'HttpError';
  }
}

export interface TransportOptions {
  url: string;
  fetch?: Fetch;
  /** Total deadline, including retries and response reading. Default: 3000 ms. */
  timeoutMs?: number;
  /** Additional attempts after transport failures, 429 or availability errors. Default: 1. */
  retries?: number;
  /** Permit plaintext HTTP for an explicitly configured development deployment. */
  allowInsecureHttp?: boolean;
}

const availabilityCodes = new Set(['dependency_unavailable', 'unavailable', 'internal_error', 'timeout', 'rate_limited']);

export class Transport {
  readonly url: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: TransportOptions, private readonly headers: Record<string, string>) {
    let url: URL;
    try { url = new URL(options.url); } catch { invalidInput(); }
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowInsecureHttp === true))) invalidInput();
    this.url = url.href.replace(/\/$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.retries = options.retries ?? 1;
    if (typeof this.fetch !== 'function' || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1
      || this.timeoutMs > 60_000 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3) invalidInput();
  }

  async post(path: string, body: string): Promise<unknown> {
    const controller = new AbortController();
    const deadline = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new AvailabilityError('timeout'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await Promise.race([this.attempt(path, body, controller.signal), aborted]);
        } catch (error) {
          if (!(error instanceof AvailabilityError) || attempt >= this.retries || controller.signal.aborted) throw error;
          const delay = Math.max(50 * 2 ** attempt, error.retryAfterMs);
          if (delay >= deadline - Date.now()) throw error;
          await Promise.race([new Promise(resolve => setTimeout(resolve, delay)), aborted]);
        }
      }
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      controller.abort();
    }
  }

  private async attempt(path: string, body: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(this.url + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headers }, body,
        signal, redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new AvailabilityError(signal.aborted ? 'timeout' : 'unavailable');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new HttpError(response.status, 'redirect_refused');
    }
    const availabilityStatus = response.status === 429 || response.status >= 500;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await boundedText(response));
    } catch (error) {
      if (error instanceof KrineError) throw error;
      if (!availabilityStatus) invalidResponse();
    }
    if (!response.ok) {
      const code = record(parsed) && record(parsed.error) && string(parsed.error.code, 64)
        && /^[a-z0-9_]+$/.test(parsed.error.code) ? parsed.error.code : 'http_error';
      if (availabilityStatus && (code === 'http_error' || availabilityCodes.has(code))) {
        throw new AvailabilityError(response.status === 429 ? 'rate_limited' : 'unavailable', retryAfter(response.headers.get('Retry-After')));
      }
      throw new HttpError(response.status, code);
    }
    if (response.status !== 200) invalidResponse();
    return parsed;
  }
}

function retryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        void reader.cancel().catch(() => {});
        invalidResponse();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}
