import { KrineBrowser, solveChallenge } from '@krine/browser';
import type { BrowserOptions } from '@krine/browser';
import { CHECK } from './contracts.js';
import type { PublicAttempt, SessionView, TrialRequest } from './contracts.js';

const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id)! as T;
let session: SessionView | null = null;
let browser: KrineBrowser;
let ready = false;
let busy = false;
let original: TrialRequest | null = null;
let challengeAbort: AbortController | null = null;

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(session ? { 'X-CSRF-Token': session.csrf } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20_000) });
  const data = await response.json() as T & { error?: { message: string; code: string } };
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') { session = null; render(); }
    throw new ApiError(response.status, data.error?.message ?? 'The request failed. Please retry.');
  }
  return data;
}

function remember(value: TrialRequest | null): void {
  original = value;
  if (!session) return;
  try {
    if (value) sessionStorage.setItem(`draftroom:${session.account}`, JSON.stringify(value));
    else sessionStorage.removeItem(`draftroom:${session.account}`);
  } catch { /* The backend can recover any already-received attempt without browser storage. */ }
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    button.disabled = !ready && button.id !== 'retry-setup';
    button.setAttribute('aria-disabled', String(busy || button.disabled));
  });
  element<HTMLButtonElement>('cancel-verification').disabled = false;
  element('cancel-verification').removeAttribute('aria-disabled');
  element('login-panel').hidden = session !== null;
  element('account-panel').hidden = session === null;
  if (!session) return;
  element('account-name').textContent = `Signed in as ${session.account}`;
  const trial = session.trial_until;
  const active = trial !== null && trial > Date.now();
  element('trial-heading').textContent = active ? 'Your trial is ready.' : trial ? 'Your trial has ended.' : 'Make space for your next idea.';
  element('trial-description').textContent = trial
    ? `${active ? 'You have access until' : 'Your account’s trial ended on'} ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(trial)}.`
    : 'Start your seven-day trial. Your account can receive this benefit once.';
  const attempt = session.attempt;
  const pending = attempt && ['preparing', 'checking', 'pending'].includes(attempt.status);
  element('claim').hidden = trial !== null || Boolean(pending);
  element('claim').textContent = original ? 'Retry original request' : attempt ? 'Start a new request' : 'Start free trial';
  element('attempt-panel').hidden = !attempt;
  element('resume').hidden = !pending;
  element('resume').textContent = attempt?.status === 'pending' ? 'Resume verification' : 'Resume request';
  if (!attempt) return;
  element('attempt-heading').textContent = attempt.result ? (attempt.result.outcome === 'ALLOW' ? 'Trial granted' : 'Trial not granted')
    : attempt.status === 'failed' ? 'Request could not be accepted' : attempt.status === 'pending' ? 'One more step' : 'Request in progress';
  element('attempt-description').textContent = attempt.result
    ? attempt.result.source === 'fallback'
      ? `Application fallback · ${attempt.result.outcome === 'ALLOW' ? 'Allowed' : 'Denied'}. Krine was unavailable; no evaluated decision was received.${attempt.result.recovery ? ' Recovery uses Deny because the earlier response may have required verification.' : ''}`
      : `Krine ${attempt.result.outcome === 'ALLOW' ? 'allowed' : 'denied'} this request using policy version ${attempt.result.policy_version}.`
    : attempt.error ?? (attempt.status === 'pending' ? attempt.verification_submitted
      ? 'Your verification response is saved. Resume this request to retrieve the result. Your trial has not been granted.'
      : 'Complete verification to continue. Your trial has not been granted.' : 'Resume this request to retrieve its result.');
  element('result-details').hidden = !attempt.result;
  element('result-fields').replaceChildren();
  if (attempt.result) for (const [key, value] of Object.entries({ Source: attempt.result.source, Reason: attempt.result.reason,
    Operation: attempt.result.operation_id, Decision: attempt.result.decision_id ?? 'No evaluated decision' })) {
    const term = document.createElement('dt'); term.textContent = key;
    const description = document.createElement('dd'); description.textContent = value;
    element('result-fields').append(term, description);
  }
}

function progress(message: string): void {
  element('notice').setAttribute('role', 'status');
  element('notice').setAttribute('aria-live', 'polite');
  element('notice').textContent = message;
}

function focusMessage(message: string): void {
  // Focus announces this message; a simultaneous live announcement would repeat it.
  element('notice').removeAttribute('role');
  element('notice').setAttribute('aria-live', 'off');
  element('notice').textContent = message;
  element('notice').focus();
}

function focusResult(id: string): void {
  element('notice').textContent = '';
  element(id).focus();
}

async function work(message: string, fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  progress(message);
  render();
  try { await fn(); }
  catch (error) {
    focusMessage(error instanceof Error ? error.message : 'Could not complete the request. Please retry.');
  }
  finally {
    busy = false;
    render();
  }
}

async function observe(attempt: PublicAttempt): Promise<void> {
  session!.attempt = attempt;
  if (original?.intent_id === attempt.intent_id) remember(null);
  if (attempt.result?.trial_until) session!.trial_until = attempt.result.trial_until;
  render();
  focusResult('attempt-heading');
  while (attempt.status === 'pending' && attempt.challenge && !attempt.verification_submitted) {
    challengeAbort = new AbortController();
    element('cancel-verification').hidden = false;
    let verification;
    try { verification = await solveChallenge(attempt.challenge, element('verification'), { signal: challengeAbort.signal }); }
    catch (error) {
      if (!challengeAbort.signal.aborted) throw error;
      focusMessage('Verification paused. Resume this request when you are ready.');
      return;
    } finally { challengeAbort = null; element('cancel-verification').hidden = true; }
    focusMessage('Checking your verification…');
    attempt = await request<PublicAttempt>(`/api/trials/${attempt.id}/continue`, { verification });
    session!.attempt = attempt;
    if (attempt.result?.trial_until) session!.trial_until = attempt.result.trial_until;
    render();
    focusResult('attempt-heading');
  }
  challengeAbort = null;
}

element<HTMLFormElement>('login-form').addEventListener('submit', event => {
  event.preventDefault();
  void work('Signing in…', async () => {
    session = await request<SessionView>('/api/login', { name: element<HTMLInputElement>('account').value, password: element<HTMLInputElement>('password').value });
    element<HTMLInputElement>('password').value = '';
    recoverOriginal();
    render();
    focusResult('trial-heading');
  });
});
element('sign-out').addEventListener('click', () => { void work('Signing out…', async () => {
  challengeAbort?.abort();
  await request('/api/logout', {}); session = null; original = null; render(); focusResult('account');
}); });
element('claim').addEventListener('click', () => { void work('Preparing your request…', async () => {
  if (!original) {
    const prepared = await browser.prepare(CHECK);
    remember({ intent_id: crypto.randomUUID(), proof: prepared.proof });
  }
  progress('Checking your request…');
  const attempt = await request<PublicAttempt>('/api/trials', original);
  element('notice').textContent = '';
  await observe(attempt);
}); });
element('resume').addEventListener('click', () => { void work('Resuming your request…', async () => {
  const attempt = await request<PublicAttempt>(`/api/trials/${session!.attempt!.id}/continue`, {});
  await observe(attempt);
}); });

function recoverOriginal(): void {
  original = null;
  if (!session) return;
  try {
    const saved = sessionStorage.getItem(`draftroom:${session.account}`);
    if (saved) {
      const parsed = JSON.parse(saved) as TrialRequest;
      if (typeof parsed.intent_id === 'string' && typeof parsed.proof === 'string') original = parsed;
    }
    if (original?.intent_id === session.attempt?.intent_id) remember(null);
  }
  catch { /* Losing browser storage cannot duplicate a backend-owned grant. */ }
}

element('cancel-verification').addEventListener('click', () => challengeAbort?.abort());
window.addEventListener('pagehide', () => challengeAbort?.abort());
async function initialize(): Promise<void> {
  const retrying = document.activeElement === element('retry-setup');
  await work('Connecting…', async () => {
    element('retry-setup').hidden = false;
    browser = new KrineBrowser(await request<BrowserOptions>('/api/config'));
    try { session = await request<SessionView>('/api/session'); recoverOriginal(); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
    ready = true; element('retry-setup').hidden = true;
    element('notice').textContent = '';
    render();
    if (retrying) focusResult(session ? 'trial-heading' : 'account');
  });
}
element('retry-setup').addEventListener('click', () => { void initialize(); });
void initialize();
