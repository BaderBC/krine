import {
  HttpError, Transport, identifier, invalidInput, jsonBody, parseContext, parseProof, record, string,
} from '@krine/protocol';
import type { BrowserContext, ContextCredentials, PreparedAction, Signals, TransportOptions } from '@krine/protocol';

export { AvailabilityError, HttpError, KrineError } from '@krine/protocol';
export type { Challenge, ContextCredentials, PreparedAction, Signals, Verification } from '@krine/protocol';
export { solveChallenge } from './turnstile.js';
export type { ChallengeOptions, TurnstileAdapter, TurnstileParameters } from './turnstile.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserOptions extends TransportOptions {
  publicKey: string;
  /** Set null to use only in-memory credentials. */
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  /** Override collection for consent handling or restricted browser environments. */
  signals?: () => Signals | Promise<Signals>;
}

export class KrineBrowser {
  private readonly transport: Transport;
  private readonly local: StorageLike | null;
  private readonly session: StorageLike | null;
  private readonly storageKey: string;
  private readonly signals: () => Signals | Promise<Signals>;
  private context: BrowserContext | undefined;
  private loading: Promise<BrowserContext> | undefined;

  constructor(options: BrowserOptions) {
    if (!string(options.publicKey, 4096) || !/^[\x21-\x7e]+$/.test(options.publicKey)) invalidInput();
    this.transport = new Transport(options, { 'X-Krine-Public-Key': options.publicKey });
    this.local = options.localStorage === undefined ? browserStorage('localStorage') : options.localStorage;
    this.session = options.sessionStorage === undefined ? browserStorage('sessionStorage') : options.sessionStorage;
    this.storageKey = `krine:v1:${this.transport.url}:${options.publicKey}`;
    this.signals = options.signals ?? collectSignals;
  }

  /** Initialize browser participation. The returned identifiers carry no application authority. */
  async initialize(): Promise<{ client_id: string; session_id: string }> {
    const context = await this.ensureContext();
    return { client_id: context.client_id, session_id: context.session_id };
  }

  /** Opaque participation credentials for your application's trusted server. Never put them in URLs or logs. */
  async getContextCredentials(): Promise<ContextCredentials> {
    const context = await this.ensureContext();
    return { client_token: context.client_token, session_token: context.session_token };
  }

  /** Obtain a fresh action-bound proof immediately before submitting the protected action. */
  async prepare(check: string): Promise<PreparedAction> {
    if (!identifier(check)) invalidInput();
    let context = await this.ensureContext();
    for (let attempt = 0; ; attempt++) {
      try {
        return parseProof(await this.transport.post('/v1/browser/proofs', jsonBody({
          client_token: context.client_token, session_token: context.session_token, check,
        })), context);
      } catch (error) {
        if (attempt !== 0 || !(error instanceof HttpError)
          || !['invalid_context', 'context_expired'].includes(error.code)) throw error;
        if (this.context === context) this.context = undefined;
        context = await this.ensureContext();
      }
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && this.context.expires_at > Date.now()) return this.context;
    if (!this.loading) {
      this.loading = this.createContext().finally(() => { this.loading = undefined; });
    }
    return this.loading;
  }

  private async createContext(): Promise<BrowserContext> {
    const clientToken = this.context?.client_token ?? read(this.local, this.storageKey);
    let sessionToken = this.context?.session_token;
    if (!sessionToken && clientToken) {
      try {
        const saved: unknown = JSON.parse(read(this.session, this.storageKey) ?? 'null');
        if (record(saved) && saved.client_token === clientToken && string(saved.session_token, 4096)) sessionToken = saved.session_token;
      } catch { /* Unreadable credentials are replaced with a Krine-issued context. */ }
    }
    const signals = normalizeSignals(await this.signals());
    const context = parseContext(await this.transport.post('/v1/browser/context', jsonBody({
      ...(clientToken && string(clientToken, 4096) ? { client_token: clientToken } : {}),
      ...(sessionToken ? { session_token: sessionToken } : {}),
      signals,
    })));
    this.context = context;
    write(this.local, this.storageKey, context.client_token);
    write(this.session, this.storageKey, JSON.stringify({ client_token: context.client_token, session_token: context.session_token }));
    return context;
  }
}

function browserStorage(name: 'localStorage' | 'sessionStorage'): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window[name]; } catch { return null; }
}

function read(storage: StorageLike | null, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function write(storage: StorageLike | null, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* In-memory context remains usable when storage is denied. */ }
}

function normalizeSignals(value: Signals): Signals {
  if (!record(value)) invalidInput();
  const result: Signals = {};
  for (const name of ['language', 'timezone', 'platform', 'fingerprint'] as const) {
    if (string(value[name], 1024)) result[name] = value[name];
  }
  for (const name of ['screen_width', 'screen_height', 'hardware_concurrency'] as const) {
    const number = value[name];
    if (typeof number === 'number' && Number.isInteger(number) && number > 0
      && number <= (name === 'hardware_concurrency' ? 1024 : 32768)) result[name] = number;
  }
  if (typeof value.webdriver === 'boolean') result.webdriver = value.webdriver;
  return result;
}

/** Basic spoofable evidence only; this neither identifies a person nor proves humanity. */
export async function collectSignals(): Promise<Signals> {
  const signals: Signals = {};
  try { signals.language = navigator.language; } catch { /* Missing evidence stays absent. */ }
  try { signals.platform = navigator.platform; } catch { /* Missing evidence stays absent. */ }
  try { signals.hardware_concurrency = navigator.hardwareConcurrency; } catch { /* Missing evidence stays absent. */ }
  try { signals.webdriver = navigator.webdriver; } catch { /* Missing evidence stays absent. */ }
  try { signals.screen_width = screen.width; signals.screen_height = screen.height; } catch { /* Missing evidence stays absent. */ }
  try { signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* Missing evidence stays absent. */ }
  const normalized = normalizeSignals(signals);
  if (Object.keys(normalized).length > 0) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)));
      normalized.fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* Fingerprinting is optional evidence. */ }
  }
  return normalized;
}
