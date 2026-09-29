import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { BlockList } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { KrineBrowser } from '@krine/browser';
import { JSDOM } from 'jsdom';
import { createApp } from '../dist/server/app.js';

const secretKey = 'test-server-secret-never-in-the-browser';
const publicKey = 'test-public-key-for-browser-participation';
const error = (code = 'dependency_unavailable', status = 503) => ({ status, body: { error: { code } } });
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, evaluate, options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'krine-protected-app-'));
  const calls = [];
  const proofs = new Map();
  const accepted = new Map();
  const data = { failEvents: false, requestedEventFailures: 0, resolveError: null, associationFailures: 0, associations: new Map(), eventIds: new Set(), evaluate };
  const krine = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: req.url, body, headers: req.headers });
    const now = Date.now();
    if (req.url.startsWith('/v1/browser/')) {
      assert.equal(req.headers['x-krine-public-key'], publicKey);
      if (req.url.endsWith('/context')) return json(res, 200, { client_id: 'cli_fixture', session_id: 'ses_fixture', client_token: 'client_token', session_token: 'session_token', expires_at: now + 60_000 });
      const proof = `proof_${randomUUID()}`;
      proofs.set(proof, { ip: req.socket.remoteAddress, check: body.check });
      return json(res, 200, { proof, expires_at: now + 60_000, client_id: 'cli_fixture', session_id: 'ses_fixture' });
    }
    assert.equal(req.headers.authorization, `Bearer ${secretKey}`);
    if (req.url === '/v1/contexts/resolve') {
      if (data.resolveError) return json(res, data.resolveError.status, data.resolveError.body);
      assert.deepEqual(Object.keys(body), ['interaction']);
      const proof = proofs.get(body.interaction.proof);
      if (!proof || proof.ip !== body.interaction.ip || proof.check !== body.interaction.check) return json(res, 422, { error: { code: 'invalid_proof' } });
      return json(res, 200, { client_id: 'cli_fixture', session_id: 'ses_fixture', expires_at: now + 60_000 });
    }
    if (req.url === '/v1/associations') {
      const previous = data.associations.get(body.association_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(body)) return json(res, 409, { error: { code: 'input_conflict' } });
      data.associations.set(body.association_id, body);
      if (data.associationFailures-- > 0) return json(res, 503, { error: { code: 'dependency_unavailable' } });
      return json(res, 200, { ...body, created_at: now, revoked_at: null, provenance: 'backend' });
    }
    if (req.url === '/v1/events') {
      if (data.failEvents && body.name === 'trial_started') return json(res, 503, { error: { code: 'dependency_unavailable' } });
      const duplicate = data.eventIds.has(body.event_id); data.eventIds.add(body.event_id);
      if (body.name === 'trial_requested' && data.requestedEventFailures-- > 0) return json(res, 503, { error: { code: 'dependency_unavailable' } });
      return json(res, 200, { event_id: body.event_id, accepted_at: now, duplicate });
    }
    if (req.url === '/v1/checks/evaluate') {
      const proof = proofs.get(body.proof);
      if (!proof || proof.ip !== body.ip || proof.check !== body.check) return json(res, 422, { error: { code: 'invalid_proof' } });
      if (!accepted.has(body.operation_id)) accepted.set(body.operation_id, { decision_id: `dec_${randomUUID()}`, accepted_at: now, retry_until: now + 86_400_000 });
      const base = { ...accepted.get(body.operation_id), operation_id: body.operation_id, check: body.check, policy_version: 1, source: 'evaluation', reason: 'otherwise' };
      const response = await data.evaluate(body, base);
      if (response === null) return;
      return json(res, response.status ?? 200, response.body ?? response);
    }
    json(res, 404, { error: { code: 'not_found' } });
  });
  krine.listen(0, '127.0.0.1'); await once(krine, 'listening');
  const config = { origin: '', port: 0, host: '127.0.0.1', development: true, dataDir: dir,
    assetsDir: resolve('dist/public'), krineUrl: `http://127.0.0.1:${krine.address().port}`,
    krineBrowserUrl: `http://127.0.0.1:${krine.address().port}`, secretKey, publicKey, fallback: 'ALLOW', trustedProxies: new BlockList(), ...options.config };
  let app;
  async function start() {
    app = createApp(config); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    config.origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  if (!options.processOnly) await start();
  const browser = new KrineBrowser({ url: config.krineUrl, publicKey, allowInsecureHttp: true, retries: 0, localStorage: null, sessionStorage: null, signals: () => ({ webdriver: false }) });
  async function prepared() { const { proof } = await browser.prepare('can_claim_trial'); return { intent_id: randomUUID(), proof }; }
  const accountPassword = name => JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).find(a => a.name === name).password;
  const api = async (path, input, session, headers = {}) => {
    const res = await fetch(config.origin + path, { method: input === undefined ? 'GET' : 'POST', headers: {
      Origin: config.origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...headers,
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, data: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };
  async function login(name = 'ada') {
    const res = await api('/api/login', { name, password: accountPassword(name) }); assert.equal(res.status, 200);
    return { cookie: res.headers.get('set-cookie').split(';')[0], ...res.data };
  }
  const stop = async () => { if (app) { const active = app; app = undefined; await active.close(); } };
  t.after(async () => { await stop(); krine.closeAllConnections(); await new Promise(resolve => krine.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, calls, data, proofs, accepted, start, stop, api, login, prepared, accountPassword };
}

function inspect(dir, fn) {
  const db = new DatabaseSync(join(dir, 'application.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
const challenge = (base, id = 'ch_first') => ({ ...base, outcome: 'CHALLENGE_REQUIRED', challenge: { challenge_id: id, provider: 'turnstile', site_key: 'public_site', action: 'krine', binding: id, expires_at: base.accepted_at + 120_000 } });

test('HTTP authentication, CSRF, host, exact inputs, private assets and session isolation fail closed', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' }));
  assert.equal((await f.api('/api/session')).status, 401);
  assert.equal((await f.api('/api/trials', await f.prepared())).status, 401);
  assert.equal((await f.api('/api/login', { name: 'ada', password: f.accountPassword('ada') }, null, { Origin: 'https://attacker.example' })).status, 403);
  const login = await f.api('/api/login', { name: 'ada', password: f.accountPassword('ada') });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const session = { cookie: login.headers.get('set-cookie').split(';')[0], ...login.data };
  assert.equal((await f.api('/api/trials', await f.prepared(), session, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.api('/api/trials', { ...await f.prepared(), user_id: 'other' }, session)).status, 400);
  assert.equal((await f.api('/api/login', { name: 'ada', password: 'wrong-password' })).status, 401);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.config.origin + '/api/config', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.api('/src/main.ts')).status, 404);
  assert.equal((await f.api('/.data/accounts.json')).status, 404);
  const config = await f.api('/api/config'); assert.equal(config.data.publicKey, publicKey); assert.ok(!config.text.includes(secretKey));
  const html = await f.api('/'); assert.equal(html.status, 200); assert.match(html.text, /Draftroom/); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const logout = await f.api('/api/logout', {}, session); assert.equal(logout.status, 200);
  assert.equal((await f.api('/api/session', undefined, session)).status, 401);
});

test('concurrent exact retries grant one durable trial, preserve original IP and report trusted evidence', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' }));
  const session = await f.login(); const input = await f.prepared();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.api('/api/trials', input, session, { 'X-Forwarded-For': '203.0.113.123' })));
  for (const result of results) { assert.equal(result.status, 200); assert.deepEqual(result.data, results[0].data); }
  const final = results[0].data; assert.equal(final.result.outcome, 'ALLOW'); assert.ok(final.result.trial_until > Date.now());
  assert.equal(f.calls.filter(c => c.path === '/v1/checks/evaluate').length, 1);
  const checked = f.calls.find(c => c.path === '/v1/checks/evaluate').body;
  assert.equal(checked.ip, '127.0.0.1'); assert.equal(checked.check, 'can_claim_trial'); assert.deepEqual(checked.inputs, {}); assert.ok(checked.user_id !== 'ada');
  assert.equal(f.calls.find(c => c.path === '/v1/associations').body.user_id, checked.user_id);
  assert.equal(f.calls.find(c => c.path === '/v1/associations').body.session_id, 'ses_fixture');
  assert.equal(f.calls.find(c => c.path === '/v1/events').body.user_id, checked.user_id);
  for (const secret of [secretKey, input.proof, 'client_token', 'session_token']) assert.ok(!JSON.stringify(final).includes(secret));
  assert.equal((await f.api('/api/trials', { ...input, proof: 'changed' }, session)).status, 409);
  assert.equal((await f.api('/api/trials', await f.prepared(), session)).data.error.code, 'trial_already_claimed');
  const other = await f.login('ben'); assert.equal((await f.api(`/api/trials/${final.id}/continue`, {}, other)).status, 404);
  await f.stop();
  inspect(f.dir, db => {
    assert.equal(db.prepare('SELECT count(*) n FROM trials').get().n, 1);
    assert.throws(() => db.prepare('UPDATE attempts SET request=? WHERE id=?').run('{}', final.id), /immutable/);
  });
  await f.start();
  assert.deepEqual((await f.api('/api/trials', input, session)).data, final);
  assert.equal((await f.api('/api/session', undefined, session)).data.trial_until, final.result.trial_until);
});

test('evaluated denial is durable and separate from explicitly configured initial availability fallback', async t => {
  for (const mode of ['DENY', 'ALLOW', 'FALLBACK_DENY']) {
    const f = await fixture(t, (_, base) => mode === 'DENY' ? { ...base, outcome: 'DENY' } : error(),
      { config: { fallback: mode === 'FALLBACK_DENY' ? 'DENY' : 'ALLOW' } });
    const session = await f.login(); const result = (await f.api('/api/trials', await f.prepared(), session)).data;
    assert.equal(result.result.source, mode === 'DENY' ? 'evaluation' : 'fallback');
    assert.equal(result.result.outcome, mode === 'ALLOW' ? 'ALLOW' : 'DENY');
    assert.equal(result.result.trial_until !== null, mode === 'ALLOW');
    if (mode !== 'DENY') assert.equal(result.result.decision_id, null);
  }
});

test('proof and configuration errors never become fallback; context outage does not fabricate evidence', async t => {
  for (const [code, status] of [['invalid_proof', 422], ['unauthenticated', 401], ['invalid_configuration', 500], ['provider_unavailable', 503]]) {
    const f = await fixture(t, () => error(code, status)); const session = await f.login();
    const response = await f.api('/api/trials', await f.prepared(), session);
    assert.equal(response.status, code === 'invalid_proof' ? 200 : 422);
    const view = (await f.api('/api/session', undefined, session)).data;
    assert.equal(view.trial_until, null); assert.equal(view.attempt.result, null);
  }
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' })); f.data.resolveError = error();
  const session = await f.login(); const input = await f.prepared();
  assert.equal((await f.api('/api/trials', input, session)).status, 503);
  assert.equal(f.calls.some(c => c.path === '/v1/checks/evaluate'), false);
  f.data.resolveError = null;
  assert.equal((await f.api('/api/trials', input, session)).data.result.outcome, 'ALLOW');
});

test('pending attempts survive restart, cannot fall back, preserve verification and complete sequential steps once', async t => {
  let unavailable = false;
  const f = await fixture(t, (input, base) => {
    if (unavailable) return error();
    if (input.verification?.challenge_id === 'ch_second') return { ...base, outcome: 'ALLOW' };
    return challenge(base, input.verification ? 'ch_second' : 'ch_first');
  });
  const session = await f.login(); const input = await f.prepared();
  const initial = (await f.api('/api/trials', input, session)).data;
  assert.equal(initial.status, 'pending'); assert.equal(initial.result, null);
  assert.equal((await f.api('/api/trials', await f.prepared(), session)).data.error.code, 'attempt_pending');
  assert.equal((await f.api(`/api/trials/${initial.id}/continue`, { pending: { request: { user_id: 'forged' } } }, session)).status, 400);
  assert.equal((await f.api(`/api/trials/${initial.id}/continue`, { verification: { challenge_id: 'ch_first', token: 'invalid token' } }, session)).status, 400);
  assert.equal((await f.api('/api/session', undefined, session)).data.attempt.verification_submitted, false);
  unavailable = true;
  const verification = { challenge_id: 'ch_first', token: 'provider-token-first' };
  assert.equal((await f.api(`/api/trials/${initial.id}/continue`, { verification }, session)).status, 503);
  const view = (await f.api('/api/session', undefined, session)).data;
  assert.equal(view.trial_until, null); assert.equal(view.attempt.verification_submitted, true);
  await f.stop(); await f.start();
  assert.equal((await f.api(`/api/trials/${initial.id}/continue`, { verification: { ...verification, token: 'different' } }, session)).status, 409);
  assert.equal((await f.api(`/api/trials/${initial.id}/continue`, {}, session)).status, 503);
  unavailable = false;
  const next = (await f.api(`/api/trials/${initial.id}/continue`, {}, session)).data;
  assert.equal(next.challenge.challenge_id, 'ch_second'); assert.equal(next.verification_submitted, false);
  const final = (await f.api(`/api/trials/${initial.id}/continue`, { verification: { challenge_id: 'ch_second', token: 'provider-token-second' } }, session)).data;
  assert.equal(final.result.outcome, 'ALLOW');
  const original = f.calls.find(c => c.path === '/v1/checks/evaluate').body;
  for (const call of f.calls.filter(c => c.path === '/v1/checks/evaluate')) {
    const { verification: _, ...request } = call.body; assert.deepEqual(request, original);
  }
  assert.deepEqual((await f.api('/api/trials', input, session)).data.result, final.result);
});

test('slow initial duplicates cannot overwrite a later pending or final result', async t => {
  const reached = deferred(); const release = deferred();
  const f = await fixture(t, async (input, base) => {
    if (input.verification) return { ...base, outcome: 'DENY', reason: 'verification_failed' };
    reached.resolve(); await release.promise; return challenge(base);
  });
  const session = await f.login(); const input = await f.prepared();
  const first = f.api('/api/trials', input, session); await reached.promise;
  const second = f.api('/api/trials', input, session); await sleep(30); release.resolve();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a.data, b.data);
  const final = await f.api(`/api/trials/${a.data.id}/continue`, { verification: { challenge_id: 'ch_first', token: 'bad-token' } }, session);
  assert.equal(final.data.result.outcome, 'DENY');
  assert.deepEqual((await f.api('/api/trials', input, session)).data, final.data);
  assert.equal(f.calls.filter(c => c.path === '/v1/checks/evaluate' && !c.body.verification).length, 1);
});

test('event delivery is durable across restart without awarding again', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' })); f.data.failEvents = true;
  const session = await f.login(); const final = (await f.api('/api/trials', await f.prepared(), session)).data;
  await sleep(1200); await f.stop();
  inspect(f.dir, db => { assert.equal(db.prepare('SELECT count(*) n FROM outbox').get().n, 1); assert.equal(db.prepare('SELECT count(*) n FROM trials').get().n, 1); });
  f.data.failEvents = false; await f.start();
  for (let i = 0; i < 30 && !f.calls.some(c => c.path === '/v1/events' && c.body.name === 'trial_started' && f.data.eventIds.has(c.body.event_id)); i++) await sleep(100);
  assert.ok(f.calls.some(c => c.body.name === 'trial_started' && f.data.eventIds.has(c.body.event_id)));
  assert.equal((await f.api('/api/session', undefined, session)).data.trial_until, final.result.trial_until);
  await f.stop(); inspect(f.dir, db => assert.equal(db.prepare('SELECT count(*) n FROM outbox').get().n, 0));
});

test('trusted proxy parsing is opt-in, rejects malformed chains and keeps the originally accepted peer', async t => {
  const proxies = new BlockList(); proxies.addAddress('127.0.0.1');
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' }), { config: { trustedProxies: proxies } });
  const login = await f.api('/api/login', { name: 'ada', password: f.accountPassword('ada') }, null, { 'X-Forwarded-For': '192.0.2.9' });
  const session = { cookie: login.headers.get('set-cookie').split(';')[0], ...login.data };
  const input = await f.prepared(); f.proofs.get(input.proof).ip = '192.0.2.9';
  assert.equal((await f.api('/api/trials', input, session)).status, 400);
  assert.equal((await f.api('/api/trials', input, session, { 'X-Forwarded-For': 'invalid' })).status, 400);
  const final = await f.api('/api/trials', input, session, { 'X-Forwarded-For': '203.0.113.8, 192.0.2.9' });
  assert.equal(final.data.result.outcome, 'ALLOW');
  assert.equal(f.calls.find(c => c.path === '/v1/checks/evaluate').body.ip, '192.0.2.9');
  assert.deepEqual((await f.api('/api/trials', input, session, { 'X-Forwarded-For': '198.51.100.4' })).data, final.data);
});

async function processApp(f) {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  f.config.origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server/main.js'], { cwd: resolve('.'), env: { ...process.env,
    DEMO_DEVELOPMENT: 'true', DEMO_ORIGIN: f.config.origin, DEMO_PORT: String(port), DEMO_DATA_DIR: f.dir,
    KRINE_URL: f.config.krineUrl, KRINE_PUBLIC_KEY: publicKey, KRINE_SECRET_KEY: secretKey, KRINE_FALLBACK: 'ALLOW',
    KRINE_PUBLIC_KEY_FILE: '', KRINE_SECRET_KEY_FILE: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Child failed: ${output}`);
    try { if ((await fetch(f.config.origin + '/health')).ok) return child; } catch { /* Wait for the actual child listener. */ }
    await sleep(25);
  }
  child.kill('SIGKILL'); throw new Error(`Child did not start: ${output}`);
}

test('OS-backed SQLite exclusivity and crash recovery fence an ambiguous initial response', async t => {
  const reached = deferred(); let outage = false;
  const f = await fixture(t, () => { if (outage) return error(); reached.resolve(); return null; }, { processOnly: true });
  let child = await processApp(f);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  const session = await f.login(); const input = await f.prepared();
  const second = spawn(process.execPath, ['--input-type=module', '-e', `import {Store} from './dist/server/store.js'; new Store(process.argv[1]);` , f.dir], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; second.stderr.on('data', chunk => { errors += chunk; });
  assert.equal((await once(second, 'exit'))[0], 1); assert.match(errors, /database is locked/);
  const inflight = f.api('/api/trials', input, session).catch(() => null); await reached.promise;
  child.kill('SIGKILL'); await once(child, 'exit'); await inflight;
  inspect(f.dir, db => { const row = db.prepare('SELECT state,request FROM attempts').get(); assert.equal(row.state, 'checking'); assert.equal(JSON.parse(row.request).proof, input.proof); });
  outage = true; child = await processApp(f);
  const result = (await f.api('/api/trials', input, session)).data;
  assert.equal(result.result.outcome, 'DENY'); assert.equal(result.result.source, 'fallback'); assert.equal(result.result.recovery, true); assert.equal(result.result.trial_until, null);
  assert.equal(new Set(f.calls.filter(c => c.path === '/v1/checks/evaluate').map(c => c.body.operation_id)).size, 1);
  child.kill('SIGTERM'); await once(child, 'exit'); assert.equal(child.exitCode, 0);
  child = await processApp(f); assert.deepEqual((await f.api('/api/trials', input, session)).data, result);
  child.kill('SIGTERM'); await once(child, 'exit');
});

test('pending network timeout preserves its original operation and cannot grant fallback', async t => {
  let timeout = false;
  const f = await fixture(t, (input, base) => timeout ? null : input.verification ? { ...base, outcome: 'DENY', reason: 'verification_expired' } : challenge(base));
  const session = await f.login(); const input = await f.prepared();
  const pending = (await f.api('/api/trials', input, session)).data;
  timeout = true;
  const response = await f.api(`/api/trials/${pending.id}/continue`, { verification: { challenge_id: 'ch_first', token: 'expired-token' } }, session);
  assert.equal(response.status, 503);
  assert.equal((await f.api('/api/session', undefined, session)).data.trial_until, null);
  await f.stop(); timeout = false; await f.start();
  const final = (await f.api(`/api/trials/${pending.id}/continue`, {}, session)).data;
  assert.equal(final.result.source, 'evaluation'); assert.equal(final.result.outcome, 'DENY');
  assert.equal(final.result.reason, 'verification_expired'); assert.equal(final.result.trial_until, null);
  assert.equal(new Set(f.calls.filter(c => c.path === '/v1/checks/evaluate').map(c => c.body.operation_id)).size, 1);
});

test('expired pending retry window ends locally without resending or granting a benefit', async t => {
  const f = await fixture(t, (_, base) => challenge(base));
  const session = await f.login(); const pending = (await f.api('/api/trials', await f.prepared(), session)).data;
  await f.stop();
  inspect(f.dir, db => {
    const row = db.prepare('SELECT progress FROM attempts').get(); const progress = JSON.parse(row.progress);
    progress.pending.retry_until = Date.now() - 1;
    db.prepare('UPDATE attempts SET progress=?').run(JSON.stringify(progress));
  });
  const previousCalls = f.calls.length; await f.start();
  const expired = (await f.api(`/api/trials/${pending.id}/continue`, {}, session)).data;
  assert.equal(expired.status, 'failed'); assert.equal(expired.result, null);
  assert.equal(f.calls.length, previousCalls); assert.equal((await f.api('/api/session', undefined, session)).data.trial_until, null);
});

test('malformed successful evaluations fail closed without using initial availability fallback', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'NOT_A_DECISION' }));
  const session = await f.login();
  assert.equal((await f.api('/api/trials', await f.prepared(), session)).status, 502);
  assert.equal((await f.api('/api/session', undefined, session)).data.trial_until, null);
});

test('expired event deliveries remain inspectable and are not retried beyond Krine deduplication', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' })); f.data.failEvents = true;
  const session = await f.login(); const final = (await f.api('/api/trials', await f.prepared(), session)).data;
  await f.stop();
  inspect(f.dir, db => db.prepare('UPDATE outbox SET retry_until=?,next_at=?').run(Date.now() - 1, Date.now() - 1));
  const count = f.calls.length; f.data.failEvents = false; await f.start(); await sleep(1200);
  assert.equal(f.calls.length, count); assert.equal((await f.api('/api/session', undefined, session)).data.trial_until, final.result.trial_until);
  await f.stop(); inspect(f.dir, db => assert.equal(db.prepare('SELECT expired FROM outbox').get().expired, 1));
});

test('an awarded entitlement and exact result survive a real process kill and duplicate retry', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' }), { processOnly: true });
  let child = await processApp(f);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  const session = await f.login(); const input = await f.prepared();
  const final = (await f.api('/api/trials', input, session)).data;
  child.kill('SIGKILL'); await once(child, 'exit'); child = await processApp(f);
  assert.deepEqual((await f.api('/api/trials', input, session)).data, final);
  assert.equal(f.calls.filter(c => c.path === '/v1/checks/evaluate').length, 1);
  child.kill('SIGTERM'); await once(child, 'exit');
  inspect(f.dir, db => assert.equal(db.prepare('SELECT count(*) n FROM trials').get().n, 1));
});


test('lost trusted event acknowledgements reuse the original assertion and persisted preparation after restart', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'ALLOW' })); f.data.requestedEventFailures = 2;
  const session = await f.login(); const input = await f.prepared();
  assert.equal((await f.api('/api/trials', input, session)).status, 503);
  assert.equal(f.calls.some(c => c.path === '/v1/checks/evaluate'), false);
  await f.stop(); await f.start();
  const final = (await f.api('/api/trials', input, session)).data;
  assert.equal(final.result.outcome, 'ALLOW');
  assert.equal(f.calls.filter(c => c.path === '/v1/contexts/resolve').length, 1);
  assert.equal(f.calls.filter(c => c.path === '/v1/associations').length, 1);
  const events = f.calls.filter(c => c.path === '/v1/events' && c.body.name === 'trial_requested');
  assert.equal(events.length, 3);
  for (const event of events) assert.deepEqual(event.body, events[0].body);
  assert.equal(f.data.eventIds.size, 1);
});


async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await sleep(5); }
  assert.fail('Expected browser state did not settle');
}

const publicResult = (outcome = 'DENY') => ({ id: 'attempt', intent_id: 'intent', status: 'finished', challenge: null,
  verification_submitted: false, error: null, result: { outcome, source: 'evaluation', reason: 'otherwise',
    operation_id: 'operation', decision_id: 'decision', policy_version: 1, recovery: false,
    trial_until: outcome === 'ALLOW' ? Date.now() + 86400000 : null } });
const publicPending = (id = 'ch_first') => ({ ...publicResult(), status: 'pending', result: null, challenge: {
  challenge_id: id, provider: 'turnstile', site_key: 'public_site', action: 'krine_verify', binding: id, expires_at: Date.now() + 120000 } });

async function clientFixture(t, action, options = {}) {
  const requests = []; const widgets = []; const focus = [];
  const view = { account: 'ada', csrf: 'csrf', trial_until: null, attempt: options.pending ?? null };
  let configUnavailable = options.configUnavailable ?? false;
  const dom = new JSDOM(readFileSync('dist/public/index.html', 'utf8'), { url: 'http://localhost:3000', runScripts: 'outside-only',
    beforeParse(window) {
      window.TextDecoder = TextDecoder; window.TextEncoder = TextEncoder;
      window.fetch = async (input, init = {}) => {
        const path = new URL(input, window.location.href).pathname;
        const body = init.body ? JSON.parse(init.body) : undefined; requests.push({ path, body });
        const response = (value, status = 200) => {
          const result = new Response(JSON.stringify(value), { status });
          result.json = async () => window.JSON.parse(await result.text());
          return result;
        };
        if (path === '/api/config') {
          if (configUnavailable) throw new window.Error('Connection failed. Please retry.');
          return response({ url: 'https://krine.example', publicKey });
        }
        if (path === '/api/session') return options.unauthenticated
          ? response({ error: { message: 'Sign in to continue.' } }, 401) : response(view);
        if (path === '/v1/browser/context') return response({ client_id: 'cli_fixture', session_id: 'ses_fixture', client_token: 'client_token', session_token: 'session_token', expires_at: Date.now() + 60000 });
        if (path === '/v1/browser/proofs') return response({ proof: 'fresh_proof', expires_at: Date.now() + 60000, client_id: 'cli_fixture', session_id: 'ses_fixture' });
        if (path === '/api/login') return response(view);
        if (path === '/api/logout') return response({});
        try { return response(await action(path, body)); }
        catch (error) { throw new window.Error(error.message); }
      };
      window.turnstile = {
        render(container, parameters) {
          const input = window.document.createElement('input'); input.id = 'widget-' + parameters.cData;
          input.setAttribute('aria-label', 'Test verification input'); container.append(input); input.focus();
          widgets.push({ parameters, input }); return input.id;
        },
        remove(id) { window.document.getElementById(id)?.remove(); },
      };
    },
  });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
  dom.window.document.addEventListener('focusin', e => focus.push(e.target.id));
  const bundle = readdirSync('dist/public/assets').find(file => file.endsWith('.js'));
  dom.window.eval(readFileSync(join('dist/public/assets', bundle), 'utf8'));
  const element = id => dom.window.document.getElementById(id);
  await until(() => !element('sign-in').disabled || element('notice').textContent.includes('Connection failed'));
  return { dom, element, requests, widgets, focus, reconnect() { configUnavailable = false; } };
}

test('built browser client preserves busy focus and focuses accessible terminal outcomes without duplicate announcements', async t => {
  for (const kind of ['ALLOW', 'DENY', 'failed', 'fallback']) {
    const release = deferred();
    const response = kind === 'failed' ? { ...publicResult(), status: 'failed', result: null, error: 'The original proof expired. No trial was granted.' }
      : kind === 'fallback' ? { ...publicResult('ALLOW'), result: { ...publicResult('ALLOW').result, source: 'fallback', decision_id: null, policy_version: null } } : publicResult(kind);
    const f = await clientFixture(t, () => release.promise);
    const claim = f.element('claim'); claim.focus(); claim.click();
    await until(() => f.requests.some(r => r.path === '/api/trials'));
    assert.equal(claim.disabled, false); assert.equal(claim.getAttribute('aria-disabled'), 'true');
    assert.equal(f.dom.window.document.activeElement, claim);
    assert.equal(f.element('notice').getAttribute('role'), 'status'); assert.match(f.element('notice').textContent, /Checking/);
    claim.click(); await sleep(0); assert.equal(f.requests.filter(r => r.path === '/api/trials').length, 1);
    release.resolve(response);
    await until(() => f.dom.window.document.activeElement === f.element('attempt-heading'));
    const heading = f.element('attempt-heading');
    assert.equal(heading.textContent, kind === 'failed' ? 'Request could not be accepted' : ['ALLOW', 'fallback'].includes(kind) ? 'Trial granted' : 'Trial not granted');
    assert.equal(heading.getAttribute('aria-describedby'), 'attempt-description');
    assert.match(f.element('attempt-description').textContent, kind === 'failed' ? /proof expired/ : kind === 'fallback' ? /Application fallback/ : /policy version 1/);
    assert.equal(f.element('notice').textContent, '');
    assert.equal(claim.getAttribute('aria-disabled'), 'false');
  }
});

test('built browser client focuses errors and recovers connection and login without losing the keyboard position', async t => {
  const f = await clientFixture(t, () => { throw Error('Cannot reach the application. Retry this attempt.'); }, { configUnavailable: true, unauthenticated: true });
  assert.equal(f.dom.window.document.activeElement, f.element('notice'));
  assert.equal(f.element('notice').getAttribute('aria-live'), 'off'); assert.equal(f.element('notice').hasAttribute('role'), false);
  f.reconnect(); f.element('retry-setup').focus(); f.element('retry-setup').click();
  await until(() => f.dom.window.document.activeElement === f.element('account'));
  f.element('account').value = 'ada'; f.element('password').value = 'fixture-password'; f.element('sign-in').click();
  await until(() => f.dom.window.document.activeElement === f.element('trial-heading'));
  f.element('claim').focus(); f.element('claim').click();
  await until(() => f.element('notice').textContent.includes('Cannot reach'));
  assert.equal(f.dom.window.document.activeElement, f.element('notice')); assert.equal(f.element('notice').getAttribute('aria-live'), 'off');
  assert.equal(f.element('claim').getAttribute('aria-disabled'), 'false');
});

test('built browser client preserves widget focus and transfers it through sequential verification and resumed completion', async t => {
  const reached = deferred(); const release = deferred();
  const f = await clientFixture(t, async (_, body) => {
    if (!body.verification) return publicPending();
    if (body.verification.challenge_id === 'ch_first') { reached.resolve(); await release.promise; return publicPending('ch_second'); }
    return publicResult('ALLOW');
  }, { pending: publicPending() });
  f.element('resume').focus(); f.element('resume').click();
  await until(() => f.widgets.length === 1);
  assert.ok(f.focus.includes('attempt-heading'));
  assert.equal(f.dom.window.document.activeElement, f.widgets[0].input);
  await sleep(10); assert.equal(f.dom.window.document.activeElement, f.widgets[0].input);
  assert.equal(f.element('notice').textContent, '');
  f.widgets[0].parameters.callback('first-token'); await reached.promise;
  assert.equal(f.dom.window.document.activeElement, f.element('notice'));
  assert.equal(f.element('notice').textContent, 'Checking your verification…'); assert.equal(f.element('notice').getAttribute('aria-live'), 'off');
  release.resolve(); await until(() => f.widgets.length === 2);
  assert.equal(f.dom.window.document.activeElement, f.widgets[1].input);
  f.widgets[1].parameters.callback('second-token');
  await until(() => f.element('attempt-heading').textContent === 'Trial granted');
  assert.equal(f.dom.window.document.activeElement, f.element('attempt-heading')); assert.equal(f.element('notice').textContent, '');
  assert.equal(f.element('verification').children.length, 0);
});

test('built browser client focuses a paused verification and the saved-token pending state', async t => {
  const f = await clientFixture(t, () => publicPending(), { pending: publicPending() });
  f.element('resume').focus(); f.element('resume').click(); await until(() => f.widgets.length === 1);
  f.element('cancel-verification').focus(); f.element('cancel-verification').click();
  await until(() => f.element('notice').textContent.startsWith('Verification paused'));
  assert.equal(f.dom.window.document.activeElement, f.element('notice')); assert.equal(f.element('notice').getAttribute('aria-live'), 'off');
  assert.equal(f.element('resume').getAttribute('aria-disabled'), 'false'); assert.equal(f.element('verification').children.length, 0);
  const saved = await clientFixture(t, () => ({ ...publicPending(), verification_submitted: true }), { pending: publicPending() });
  saved.element('resume').focus(); saved.element('resume').click();
  await until(() => saved.dom.window.document.activeElement === saved.element('attempt-heading'));
  assert.match(saved.element('attempt-description').textContent, /response is saved/); assert.equal(saved.widgets.length, 0);
});


test('association session envelope is durable before a lost acknowledgement and survives restart', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'DENY' }));
  const session = await f.login(); const input = await f.prepared();
  f.data.associationFailures = 5;
  assert.equal((await f.api('/api/trials', input, session)).status, 503);
  const original = f.calls.find(c => c.path === '/v1/associations').body;
  assert.equal(original.session_id, 'ses_fixture');
  await f.stop();
  inspect(f.dir, db => {
    const saved = JSON.parse(db.prepare('SELECT progress FROM attempts').get().progress);
    assert.equal(saved.association_version, 2); assert.equal(saved.associated, false);
    assert.deepEqual(saved.association_request, original);
  });
  f.data.associationFailures = 0; await f.start();
  assert.equal((await f.api('/api/trials', input, session)).status, 200);
  for (const call of f.calls.filter(c => c.path === '/v1/associations')) assert.deepEqual(call.body, original);
});

test('upgraded legacy attempts replay their original no-session association after lost acknowledgement', async t => {
  const f = await fixture(t, (_, base) => ({ ...base, outcome: 'DENY' }));
  const session = await f.login(); const input = await f.prepared();
  f.data.resolveError = error();
  assert.equal((await f.api('/api/trials', input, session)).status, 503);
  await f.stop();
  let original;
  inspect(f.dir, db => {
    const row = db.prepare('SELECT * FROM attempts').get(); const saved = JSON.parse(row.progress);
    delete saved.association_version; delete saved.association_request;
    saved.context = { client_id: 'cli_fixture', session_id: 'ses_fixture', expires_at: Date.now() + 60000 };
    db.prepare('UPDATE attempts SET progress=? WHERE id=?').run(JSON.stringify(saved), row.id);
    original = { association_id: row.id, client_id: 'cli_fixture', user_id: row.user_id, metadata: { application: 'draftroom' } };
    f.data.associations.set(row.id, original); // The old deployment committed, but lost its acknowledgement.
  });
  f.data.resolveError = null; f.data.associationFailures = 5; await f.start();
  assert.equal((await f.api('/api/trials', input, session)).status, 503);
  await f.stop();
  inspect(f.dir, db => {
    const saved = JSON.parse(db.prepare('SELECT progress FROM attempts').get().progress);
    assert.equal(saved.association_version, 1); assert.deepEqual(saved.association_request, original);
  });
  f.data.associationFailures = 0; await f.start();
  assert.equal((await f.api('/api/trials', input, session)).status, 200);
  for (const call of f.calls.filter(c => c.path === '/v1/associations')) assert.deepEqual(call.body, original);
});
