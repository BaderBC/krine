import { KrineError, invalidInput, isChallenge, string } from '@krine/protocol';
import type { Challenge, Verification } from '@krine/protocol';

export interface TurnstileParameters {
  sitekey: string;
  action: string;
  cData: string;
  theme: 'auto';
  retry: 'never';
  'refresh-expired': 'never';
  callback(token: string): void;
  'error-callback'(): void;
  'expired-callback'(): void;
  'timeout-callback'(): void;
  'unsupported-callback'(): void;
}

export interface TurnstileAdapter {
  render(container: HTMLElement, parameters: TurnstileParameters): string | undefined;
  remove(widgetId: string): void;
}

export interface ChallengeOptions {
  signal?: AbortSignal;
  /** Bound widget interaction. Also capped by the Krine challenge's expiry. Default: 120 seconds. */
  timeoutMs?: number;
  /** CSP nonce for the provider script. */
  nonce?: string;
  /** Supply an already loaded adapter if your application owns provider script loading. */
  adapter?: TurnstileAdapter;
}

const loaders = new WeakMap<Document, Promise<TurnstileAdapter>>();

/** A widget token is verification evidence for the backend; it is never an authorization result. */
export async function solveChallenge(challenge: Challenge, container: HTMLElement, options: ChallengeOptions = {}): Promise<Verification> {
  if (!isChallenge(challenge) || !container?.ownerDocument) invalidInput();
  const configuredTimeout = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(configuredTimeout) || configuredTimeout < 1 || configuredTimeout > 300_000) invalidInput();
  if (options.signal?.aborted) throw challengeError('challenge_cancelled');
  const deadline = Math.min(Date.now() + configuredTimeout, challenge.expires_at);
  if (deadline <= Date.now()) throw challengeError('challenge_expired');
  const adapter = options.adapter ?? await abortable(loadTurnstile(container.ownerDocument, options.nonce), options.signal, deadline);
  return new Promise<Verification>((resolve, reject) => {
    let widgetId: string | undefined;
    let settled = false;
    const cleanupWidget = () => {
      if (widgetId !== undefined) {
        try { adapter.remove(widgetId); } catch { /* Cleanup must not alter the verification outcome. */ }
        widgetId = undefined;
      }
    };
    const finish = (error?: KrineError, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      cleanupWidget();
      if (error) reject(error);
      else resolve({ challenge_id: challenge.challenge_id, token: token! });
    };
    const abort = () => finish(challengeError('challenge_cancelled'));
    const timer = setTimeout(() => finish(challengeError('challenge_timeout')), Math.max(0, deadline - Date.now()));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    if (deadline <= Date.now()) { finish(challengeError('challenge_expired')); return; }
    try {
      widgetId = adapter.render(container, {
        sitekey: challenge.site_key, action: challenge.action, cData: challenge.binding, theme: 'auto',
        retry: 'never', 'refresh-expired': 'never',
        callback: token => {
          if (Date.now() >= deadline) finish(challengeError('challenge_expired'));
          else if (!string(token, 2048)) finish(challengeError('challenge_failed'));
          else finish(undefined, token);
        },
        'error-callback': () => finish(challengeError('challenge_failed')),
        'expired-callback': () => finish(challengeError('challenge_expired')),
        'timeout-callback': () => finish(challengeError('challenge_timeout')),
        'unsupported-callback': () => finish(challengeError('challenge_unsupported')),
      });
      if (settled) cleanupWidget();
      else if (widgetId === undefined) finish(challengeError('challenge_failed'));
    } catch { finish(challengeError('challenge_failed')); }
  });
}

function challengeError(code: string): KrineError {
  return new KrineError(code, 'Verification did not complete. Retry the protected action with its existing pending context.');
}

function loadTurnstile(document: Document, nonce?: string): Promise<TurnstileAdapter> {
  const window = document.defaultView as (Window & { turnstile?: TurnstileAdapter }) | null;
  if (window?.turnstile) return Promise.resolve(window.turnstile);
  const existing = loaders.get(document);
  if (existing) return existing;
  const promise = new Promise<TurnstileAdapter>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    if (nonce !== undefined) script.nonce = nonce;
    const cleanup = () => { clearTimeout(timer); script.onload = null; script.onerror = null; };
    const fail = () => { cleanup(); script.remove(); reject(challengeError('challenge_load_failed')); };
    const timer = setTimeout(fail, 10_000);
    script.onerror = fail;
    script.onload = () => {
      if (!window?.turnstile) { fail(); return; }
      cleanup();
      resolve(window.turnstile);
    };
    try { document.head.appendChild(script); } catch { fail(); }
  });
  loaders.set(document, promise);
  void promise.catch(() => { loaders.delete(document); });
  return promise;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(challengeError('challenge_cancelled'));
      timer = setTimeout(() => reject(challengeError('challenge_timeout')), Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
