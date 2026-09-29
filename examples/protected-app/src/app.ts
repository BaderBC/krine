import { randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { AvailabilityError, HttpError, KrineServer } from '@krine/server';
import type { CheckResult, ServerOptions } from '@krine/server';
import type { EventRequest, Verification } from '@krine/protocol';
import { exactKeys, record, string } from '@krine/protocol';
import type { Config } from './config.js';
import { CHECK } from './contracts.js';
import type { PublicAttempt, SessionView, TrialRequest, TrialResult } from './contracts.js';
import { hash, secret, Store } from './store.js';
import type { Attempt, Session } from './store.js';

const DAY = 86_400_000;
const derivePassword = promisify(scrypt);
class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function invalid(): never { throw new RequestError(400, 'invalid_request', 'The request is invalid.'); }
const unavailable = (): never => { throw new RequestError(503, 'unavailable', 'Could not complete this request. Retry the same attempt.'); };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);

export function createApp(config: Config) {
  const assets = loadAssets(config.assetsDir);
  const sdkOptions: ServerOptions = { url: config.krineUrl, secretKey: config.secretKey, fallback: config.fallback,
    allowInsecureHttp: config.development, retries: 1, timeoutMs: 3000 };
  const krine = new KrineServer(sdkOptions);
  // A previous process may have lost a challenge response before its local commit.
  const recoveryKrine = new KrineServer({ ...sdkOptions, fallback: 'DENY' });
  const store = new Store(config.dataDir);
  const flights = new Map<string, Promise<PublicAttempt>>();
  let passwordChecks = 0;
  let flushing: Promise<void> | null = null;
  let closing = false;

  function limit(key: string, maximum: number, windowMs: number): void {
    const now = Date.now();
    store.db.prepare('DELETE FROM login_limits WHERE window_until<=?').run(now);
    const row = store.db.prepare('SELECT attempts FROM login_limits WHERE key=?').get(key);
    if ((row?.attempts as number | undefined ?? 0) >= maximum
      || (!row && Number(store.db.prepare('SELECT count(*) AS n FROM login_limits').get()!.n) >= 1024)) {
      throw new RequestError(429, 'rate_limited', 'Too many requests. Please wait before trying again.');
    }
    store.db.prepare(`INSERT INTO login_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1`).run(key, now + windowMs);
  }

  function authenticate(req: IncomingMessage): Session {
    const values = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith('draftroom_session='));
    const token = values.length === 1 ? values[0]!.slice('draftroom_session='.length) : '';
    if (!/^[a-f0-9]{64}$/.test(token)) throw new RequestError(401, 'unauthenticated', 'Sign in to continue.');
    const session = store.db.prepare('SELECT user_id,csrf,expires_at FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now()) as unknown as Session | undefined;
    if (!session) throw new RequestError(401, 'unauthenticated', 'Sign in to continue.');
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) {
      throw new RequestError(403, 'csrf_failed', 'Refresh the page and try again.');
    }
    return session;
  }

  function view(session: Session): SessionView {
    const latest = store.latest(session.user_id);
    return { account: store.accountName(session.user_id), csrf: session.csrf,
      trial_until: store.trial(session.user_id), attempt: latest ? publicAttempt(latest) : null };
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const input = await body(req);
    if (!record(input) || !exactKeys(input, ['name', 'password']) || !string(input.name, 32) || !string(input.password, 128)) invalid();
    limit(`login-ip:${peerIp(req, config)}`, 20, 60_000);
    limit(`login-name:${hash(input.name)}`, 10, 60_000);
    if (passwordChecks >= 4) unavailable();
    const account = store.account(input.name);
    const dummy = store.account('ada')!;
    passwordChecks++;
    let derived: Buffer;
    try { derived = await derivePassword(input.password, (account ?? dummy).salt, 64) as Buffer; }
    finally { passwordChecks--; }
    if (!timingSafeEqual(derived, Buffer.from((account ?? dummy).password_hash, 'hex')) || !account) {
      throw new RequestError(401, 'invalid_credentials', 'Account name or password is incorrect.');
    }
    const token = secret();
    const session = { user_id: account.id, csrf: secret(), expires_at: Date.now() + 8 * 3_600_000 };
    store.transaction(() => {
      store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
      store.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 9)').run(account.id);
      store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token), account.id, session.csrf, session.expires_at);
    });
    res.setHeader('Set-Cookie', cookie(token, config, 8 * 3600));
    json(res, 200, view(session));
  }

  async function begin(session: Session, input: unknown, ip: string): Promise<PublicAttempt> {
    if (!record(input) || !exactKeys(input, ['intent_id', 'proof']) || !uuid(input.intent_id)
      || !string(input.proof, 4096)) invalid();
    const request: TrialRequest = { intent_id: input.intent_id, proof: input.proof };
    const digest = hash(JSON.stringify(request));
    const existing = store.byIntent(request.intent_id, session.user_id);
    if (existing) {
      if (existing.input_hash !== digest) throw new RequestError(409, 'intent_conflict', 'This attempt already has different inputs.');
      return resume(existing);
    }
    if (store.trial(session.user_id) !== null) throw new RequestError(409, 'trial_already_claimed', 'This account has already claimed its trial.');
    const last = store.latest(session.user_id);
    if (last && ['preparing', 'checking', 'pending'].includes(last.state)) {
      throw new RequestError(409, 'attempt_pending', 'Resume the existing attempt before starting another.');
    }
    const count = Number(store.db.prepare('SELECT count(*) AS n FROM attempts WHERE user_id=?').get(session.user_id)!.n);
    if (count >= 1000) throw new RequestError(429, 'attempt_limit', 'This example account has reached its attempt limit.');
    const now = Date.now();
    const attempt: Attempt = { id: randomUUID(), user_id: session.user_id, intent_id: request.intent_id, input_hash: digest,
      request: { operation_id: randomUUID(), check: CHECK, proof: request.proof, ip, user_id: session.user_id, inputs: {} },
      created_at: now, state: 'preparing', context: null, associated: false, association_version: 2, association_request: null,
      event_sent: false, pending: null, evaluation: null, verification: null, result: null, error: null, recovery: false };
    store.insert(attempt);
    return resume(attempt);
  }

  function resume(attempt: Attempt, verification?: Verification): Promise<PublicAttempt> {
    if (verification && (!attempt.pending || verification.challenge_id !== attempt.pending.challenge_id)) {
      return Promise.reject(new RequestError(409, 'verification_conflict', 'Refresh to resume the current verification step.'));
    }
    if (verification && attempt.verification && JSON.stringify(verification) !== JSON.stringify(attempt.verification)) {
      return Promise.reject(new RequestError(409, 'verification_conflict', 'A verification response is already pending. Retry this attempt.'));
    }
    const running = flights.get(attempt.id);
    if (running) {
      if (verification) return Promise.reject(new RequestError(409, 'attempt_busy', 'This attempt is processing. Retry shortly.'));
      return running;
    }
    if (verification) { attempt.verification = verification; store.save(attempt); }
    const promise = advance(attempt).finally(() => { flights.delete(attempt.id); });
    flights.set(attempt.id, promise);
    return promise;
  }

  async function advance(a: Attempt): Promise<PublicAttempt> {
    if (a.state === 'finished' || a.state === 'failed') return publicAttempt(a);
    const retryUntil = a.pending?.retry_until ?? a.created_at + DAY;
    if (Date.now() + 12_000 >= retryUntil) {
      a.state = 'failed'; a.error = 'The original attempt has expired. No trial was granted.'; store.save(a);
      return publicAttempt(a);
    }
    try {
      if (a.state === 'pending') {
        // Only trusted durable PendingCheck is accepted; the browser cannot supply it.
        const result = await krine.continueCheck(a.pending!, a.verification ?? undefined);
        return accept(a, result);
      }
      if (a.state === 'preparing') {
        if (!a.context) {
          a.context = await krine.resolveContext({ interaction: { proof: a.request.proof, check: a.request.check, ip: a.request.ip } });
          store.save(a);
        }
        if (!a.associated) {
          if (!a.association_request) {
            a.association_request = { association_id: a.id, client_id: a.context.client_id, user_id: a.user_id,
              ...(a.association_version === 2 ? { session_id: a.context.session_id } : {}),
              metadata: { application: 'draftroom' } };
            // Persist the chosen envelope before sending; a lost acknowledgement must replay it exactly.
            store.save(a);
          }
          await krine.associate(a.association_request);
          a.associated = true; store.save(a);
        }
        if (!a.event_sent) {
          await krine.event(event(a, 'trial_requested', a.id, a.created_at));
          a.event_sent = true; store.save(a);
        }
        a.state = 'checking'; store.save(a);
        return accept(a, await krine.check(a.request));
      }
      // This state came from an interrupted earlier call; a challenge may already exist remotely.
      a.recovery = true; store.save(a);
      return accept(a, await recoveryKrine.check(a.request));
    } catch (error) {
      if (error instanceof HttpError && ['invalid_proof', 'proof_used', 'input_conflict', 'operation_expired', 'attempt_expired'].includes(error.code)) {
        a.state = 'failed'; a.error = `Krine rejected this attempt (${error.code}). No trial was granted.`; store.save(a);
        return publicAttempt(a);
      }
      if (error instanceof HttpError && error.code !== 'operation_in_progress') {
        throw new RequestError(422, 'krine_rejected', `Krine rejected the request (${error.code}). Check the integration, then retry this attempt.`);
      }
      if (error instanceof AvailabilityError || error instanceof HttpError) unavailable();
      // Malformed responses and unexpected integration failures must never grant a trial.
      throw new RequestError(502, 'integration_error', 'Krine returned an unexpected response. Check the integration before retrying.');
    }
  }

  function accept(a: Attempt, result: CheckResult): PublicAttempt {
    a.evaluation = result;
    if (result.outcome === 'CHALLENGE_REQUIRED') {
      const changed = result.pending.challenge_id !== a.pending?.challenge_id;
      a.state = 'pending'; a.pending = result.pending;
      if (changed) a.verification = null;
      store.save(a);
      return publicAttempt(a);
    }
    const business: TrialResult = { source: result.source, outcome: result.outcome, reason: result.reason,
      operation_id: a.request.operation_id, decision_id: result.source === 'evaluation' ? result.decision_id : null,
      policy_version: result.source === 'evaluation' ? result.policy_version : null, recovery: a.recovery, trial_until: null };
    store.transaction(() => {
      if (result.outcome === 'ALLOW') {
        business.trial_until = Date.now() + 7 * DAY;
        store.db.prepare('INSERT INTO trials VALUES(?,?,?)').run(a.user_id, a.id, business.trial_until);
        store.enqueue(event(a, 'trial_started', a.request.operation_id, Date.now(), { authorization_source: result.source }), Date.now());
      }
      a.state = 'finished'; a.result = business; store.save(a);
    });
    return publicAttempt(a);
  }

  async function deliverEvents(): Promise<void> {
    const expired = store.db.prepare('UPDATE outbox SET expired=1 WHERE expired=0 AND retry_until<=?').run(Date.now() + 3000);
    if (expired.changes) console.warn('Draftroom: trial event delivery window expired; inspect the retained outbox before reconciling.');
    for (const row of store.db.prepare('SELECT event_id,payload,failures,retry_until FROM outbox WHERE expired=0 AND next_at<=? ORDER BY next_at LIMIT 10').all(Date.now())) {
      if (Number(row.retry_until) <= Date.now() + 3000) {
        store.db.prepare('UPDATE outbox SET expired=1 WHERE event_id=?').run(row.event_id!);
        console.warn('Draftroom: trial event delivery window expired; inspect the retained outbox before reconciling.');
        continue;
      }
      try {
        await krine.event(JSON.parse(row.payload as string) as EventRequest);
        store.db.prepare('DELETE FROM outbox WHERE event_id=?').run(row.event_id!);
      } catch {
        store.db.prepare('UPDATE outbox SET failures=failures+1,next_at=? WHERE event_id=?').run(Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(12, Number(row.failures))), row.event_id!);
        console.warn('Draftroom: trial event delivery delayed; durable outbox will retry.');
      }
    }
  }
  const timer = setInterval(() => {
    if (!flushing && !closing) flushing = deliverEvents().finally(() => { flushing = null; });
  }, 1000);
  timer.unref();

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (req, res) => {
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof RequestError) json(res, error.status, { error: { code: error.code, message: error.message } });
      else json(res, 500, { error: { code: 'internal_error', message: 'The application could not complete this request.' } });
    });
  });
  server.maxConnections = 128;
  server.keepAliveTimeout = 5000;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' ${config.krineBrowserUrl} https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    if (req.headers.host !== new URL(config.origin).host) throw new RequestError(403, 'host_rejected', 'Use the configured application address.');
    if (closing) unavailable();
    const path = req.url ?? '';
    if (req.method === 'GET' && path === '/health') { json(res, 200, { status: 'ready' }); return; }
    if (req.method === 'GET' && path === '/api/config') {
      json(res, 200, { url: config.krineBrowserUrl, publicKey: config.publicKey, allowInsecureHttp: config.development }); return;
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== config.origin) throw new RequestError(403, 'origin_rejected', 'Refresh the page and try again.');
      if (path === '/api/login') { await login(req, res); return; }
      const session = authenticate(req);
      limit(`action:${session.user_id}`, 120, 60_000);
      if (path === '/api/logout') {
        const input = await body(req);
        if (!record(input) || !exactKeys(input, [])) invalid();
        const token = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('draftroom_session='))!.slice('draftroom_session='.length);
        store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
        res.setHeader('Set-Cookie', cookie('', config, 0)); json(res, 200, {}); return;
      }
      if (path === '/api/trials') { json(res, 200, await begin(session, await body(req), peerIp(req, config))); return; }
      const match = /^\/api\/trials\/([a-f0-9-]{36})\/continue$/.exec(path);
      if (match && uuid(match[1])) {
        const input = await body(req);
        if (!record(input) || !exactKeys(input, ['verification'])) invalid();
        let verification: Verification | undefined;
        if (input.verification !== undefined) {
          if (!record(input.verification) || !exactKeys(input.verification, ['challenge_id', 'token'])
            || !string(input.verification.challenge_id, 128) || !string(input.verification.token, 2048)
            || !/^[\x21-\x7e]+$/.test(input.verification.token)) invalid();
          verification = { challenge_id: input.verification.challenge_id, token: input.verification.token };
        }
        const attempt = store.attempt(match[1], session.user_id);
        if (!attempt) throw new RequestError(404, 'not_found', 'Attempt not found.');
        json(res, 200, await resume(attempt, verification)); return;
      }
    }
    if (req.method === 'GET' && path === '/api/session') { json(res, 200, view(authenticate(req))); return; }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = assets.get(path);
      if (asset) { res.setHeader('Content-Type', asset.type); res.setHeader('Content-Length', asset.bytes.length); res.end(req.method === 'HEAD' ? undefined : asset.bytes); return; }
    }
    throw new RequestError(404, 'not_found', 'Not found.');
  }

  return {
    server,
    async close(): Promise<void> {
      closing = true; clearInterval(timer);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...flights.values()]);
      if (flushing) await flushing;
      store.close();
    },
  };
}

function publicAttempt(a: Attempt): PublicAttempt {
  return { id: a.id, intent_id: a.intent_id, status: a.state, challenge: a.evaluation?.outcome === 'CHALLENGE_REQUIRED' && a.state === 'pending' ? a.evaluation.challenge : null,
    verification_submitted: a.verification !== null, result: a.result, error: a.error };
}
function event(a: Attempt, name: string, eventId: string, occurredAt: number, properties: Record<string, string> = {}): EventRequest {
  return { event_id: eventId, name, occurred_at: occurredAt, user_id: a.user_id, client_id: a.context!.client_id,
    session_id: a.context!.session_id, ip: a.request.ip, properties: { application: 'draftroom', ...properties } };
}
function cookie(value: string, config: Config, maxAge: number): string {
  return `draftroom_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.development ? '' : '; Secure'}`;
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') invalid();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new RequestError(413, 'request_too_large', 'Request is too large.');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return invalid(); }
}
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}
function peerIp(req: IncomingMessage, config: Config): string {
  let peer = normalizeIp(req.socket.remoteAddress ?? '');
  if (!isIP(peer)) invalid();
  const trusted = (ip: string): boolean => config.trustedProxies.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  if (!trusted(peer)) return peer;
  const raw = req.headersDistinct['x-forwarded-for'];
  if (!raw || raw.length !== 1 || raw[0]!.length > 2048) invalid();
  const hops = raw[0]!.split(',').map(ip => normalizeIp(ip.trim()));
  if (hops.length > 32 || hops.some(ip => !isIP(ip))) invalid();
  for (let i = hops.length - 1; i >= 0 && trusted(peer); i--) peer = hops[i]!;
  return peer;
}
function loadAssets(directory: string): Map<string, { type: string; bytes: Buffer }> {
  const assets = new Map<string, { type: string; bytes: Buffer }>();
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function visit(path: string, prefix: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Static assets cannot be symlinks.');
      if (entry.isDirectory()) visit(join(path, entry.name), `${prefix}/${entry.name}`);
      else if (types[extname(entry.name)]) assets.set(`${prefix}/${entry.name}`, { type: types[extname(entry.name)]!, bytes: readFileSync(join(path, entry.name)) });
    }
  }
  visit(directory, '');
  const index = assets.get('/index.html');
  if (!index) throw new Error('Build the browser application before starting the server.');
  assets.set('/', index);
  return assets;
}
