// Launched by the ignored Rust integration test, after building the actual SDKs/example.
// Only the external widget/provider and transport loss are controlled test boundaries.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { KrineBrowser, solveChallenge } from '@krine/browser';
import { KrineServer } from '@krine/server';
import { JSDOM } from 'jsdom';

let configuration = '';
for await (const chunk of process.stdin) configuration += chunk;
const config = JSON.parse(configuration);
// The Rust parent owns this exact private directory, including after forced process death.
const dir = config.dataDir;
assert.ok(typeof dir === 'string' && isAbsolute(dir));
const directory = lstatSync(dir);
assert.ok(directory.isDirectory() && (directory.mode & 0o077) === 0);
const calls = [];
const decisions = [];
const dom = new JSDOM('<div id="verification"></div>');
let child;
let childErrors = '';
let processCrashes = 0;
let outage = false;
let loss;
const held = new Set();
let cleaning = false;

// The relay forwards exact SDK bodies to real Axum before withholding selected acknowledgements.
const relay = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes.toString());
    const call = { path: req.url, body };
    calls.push(call);
    if (outage && req.url === '/v1/checks/evaluate') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'dependency_unavailable' } }));
      return;
    }
    const response = await fetch(config.url + req.url, {
      method: req.method,
      headers: { Authorization: req.headers.authorization, 'Content-Type': 'application/json' },
      body: bytes, signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    call.status = response.status;
    call.response = JSON.parse(text);
    if (loss?.matches(call)) {
      const selected = loss; loss = undefined;
      held.add(selected);
      selected.reached.resolve(call);
      await selected.release.promise;
      held.delete(selected);
    }
    if (!res.destroyed) {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text);
    }
  } catch (error) {
    if (!cleaning && !res.destroyed) {
      res.writeHead(502); res.end('Test relay failed');
      console.error(error);
    }
  }
});

function loseAcknowledgement(matches) {
  assert.equal(loss, undefined);
  const selected = { matches, reached: Promise.withResolvers(), release: Promise.withResolvers() };
  loss = selected;
  return selected;
}

async function stop(signal = 'SIGTERM') {
  if (!child) return;
  const current = child; child = undefined;
  if (current.exitCode === null && current.signalCode === null) {
    const exited = once(current, 'exit');
    current.kill(signal);
    const deadline = setTimeout(() => current.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(deadline); }
  }
  if (signal === 'SIGKILL') processCrashes++;
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  for (const selected of held) selected.release.resolve();
  await stop('SIGKILL');
  relay.closeAllConnections();
  if (relay.listening) await new Promise(resolve => relay.close(resolve));
  dom.window.close();
}
const deadline = setTimeout(() => {
  console.error('Combined verification harness exceeded 120 seconds.');
  void cleanup().finally(() => { process.exitCode = 1; });
}, 120_000);
process.once('SIGTERM', () => { void cleanup().finally(() => { process.exitCode = 1; }); });

async function start() {
  childErrors = '';
  // Do not inherit store/admin credentials or unrelated developer configuration into the example.
  child = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, DEMO_DEVELOPMENT: 'true', DEMO_ORIGIN: config.origin,
      DEMO_PORT: String(config.port), DEMO_HOST: '127.0.0.1', DEMO_DATA_DIR: dir,
      KRINE_URL: `http://127.0.0.1:${relay.address().port}`, KRINE_BROWSER_URL: config.url,
      KRINE_PUBLIC_KEY: config.publicKey, KRINE_SECRET_KEY: config.secretKey, KRINE_FALLBACK: 'ALLOW' },
  });
  child.stderr.on('data', bytes => { childErrors = (childErrors + bytes).slice(-16_384); });
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, `Example exited at startup: ${childErrors}`);
    try {
      if ((await fetch(config.origin + '/health', { signal: AbortSignal.timeout(250) })).ok) return;
    } catch { /* Wait for the owned process to listen. */ }
    await sleep(50);
  }
  assert.fail(`Example did not start: ${childErrors}`);
}

async function api(path, input, session) {
  const response = await fetch(config.origin + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json',
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
async function ok(path, input, session) {
  const response = await api(path, input, session);
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`);
  return response.data;
}
async function login(name) {
  const { password } = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).find(a => a.name === name);
  const response = await api('/api/login', { name, password });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.data.csrf };
}
function inspect(query) {
  assert.equal(child, undefined, 'Inspect only after the exclusive SQLite owner exits');
  const db = new DatabaseSync(join(dir, 'application.sqlite'));
  try { return db.prepare(query).all(); } finally { db.close(); }
}
function browser() {
  return new KrineBrowser({ url: config.url, publicKey: config.publicKey, allowInsecureHttp: true,
    localStorage: null, sessionStorage: null, signals: () => ({ webdriver: false }),
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: config.origin } }),
  });
}
const participant = browser();
async function prepared() {
  const { proof } = await participant.prepare('can_claim_trial');
  return { intent_id: randomUUID(), proof };
}
async function solve(challenge, mode = 'good', reuse) {
  let removed = 0;
  const token = reuse ?? (await (await fetch(config.controlUrl + '/tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, binding: challenge.binding }), signal: AbortSignal.timeout(3000),
  })).json()).token;
  const verification = await solveChallenge(challenge, dom.window.document.querySelector('#verification'), {
    adapter: {
      render(_container, parameters) {
        assert.equal(parameters.sitekey, 'real-site-key');
        assert.equal(parameters.action, 'krine_verify');
        assert.equal(parameters.cData, challenge.binding);
        assert.equal(parameters.retry, 'never');
        queueMicrotask(() => parameters.callback(token));
        return challenge.challenge_id;
      },
      remove(id) { assert.equal(id, challenge.challenge_id); removed++; },
    },
  });
  assert.equal(removed, 1);
  assert.deepEqual(verification, { challenge_id: challenge.challenge_id, token });
  return verification;
}
function assertFinal(attempt, outcome) {
  assert.equal(attempt.status, 'finished');
  assert.equal(attempt.result.source, 'evaluation');
  assert.equal(attempt.result.outcome, outcome);
  assert.equal(attempt.result.policy_version, 1);
  assert.equal(attempt.result.trial_until !== null, outcome === 'ALLOW');
}
const continuePath = attempt => `/api/trials/${attempt.id}/continue`;

try {
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  await start();
  const ada = await login('ada');
  const intent = await prepared();
  const initialLoss = loseAcknowledgement(call => call.path === '/v1/checks/evaluate');
  const initialRequest = api('/api/trials', intent, ada).catch(error => error);
  const accepted = await initialLoss.reached.promise;
  assert.equal(accepted.response.outcome, 'CHALLENGE_REQUIRED');
  await stop('SIGKILL'); initialLoss.release.resolve(); await initialRequest;
  assert.equal(inspect('SELECT * FROM trials').length, 0);
  assert.equal(inspect('SELECT state FROM attempts')[0].state, 'checking');
  await start();
  const first = await ok('/api/trials', intent, ada);
  assert.equal(first.status, 'pending');
  assert.equal(first.result, null);
  assert.deepEqual(first.challenge, accepted.response.challenge);

  // A known challenge cannot use the example's configured initial ALLOW fallback.
  outage = true;
  const unavailable = await api(continuePath(first), {}, ada);
  assert.equal(unavailable.status, 503);
  const paused = await ok('/api/session', undefined, ada);
  assert.equal(paused.trial_until, null);
  assert.equal(paused.attempt.status, 'pending');
  outage = false;

  const sdk = new KrineServer({ url: config.url, secretKey: config.secretKey, allowInsecureHttp: true });
  await assert.rejects(sdk.check({ ...accepted.body, operation_id: randomUUID() }), error => error.code === 'proof_used');
  await assert.rejects(sdk.check({ ...accepted.body, user_id: 'different-user' }), error => error.code === 'input_conflict');
  const firstEvidence = await solve(first.challenge);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => api(continuePath(first), { verification: firstEvidence }, ada)));
  const second = concurrent.find(response => response.status === 200)?.data;
  assert.ok(second);
  assert.equal(second.status, 'pending');
  assert.notEqual(second.challenge.challenge_id, first.challenge.challenge_id);
  assert.notEqual(second.challenge.binding, first.challenge.binding);
  assert.equal(second.challenge.expires_at, first.challenge.expires_at);
  for (const response of concurrent) {
    if (response.status === 200) assert.deepEqual(response.data, second);
    else {
      assert.equal(response.status, 409);
      assert.ok(['attempt_busy', 'verification_conflict'].includes(response.data.error.code));
    }
  }
  assert.deepEqual((await ok(continuePath(second), {}, ada)).challenge, second.challenge);

  const finalLoss = loseAcknowledgement(call => call.path === '/v1/checks/evaluate' && call.response.outcome === 'ALLOW');
  const finalRequest = api(continuePath(second), { verification: await solve(second.challenge) }, ada).catch(error => error);
  const allowed = await finalLoss.reached.promise;
  assert.equal(allowed.response.outcome, 'ALLOW');
  await stop('SIGKILL'); finalLoss.release.resolve(); await finalRequest;
  assert.equal(inspect('SELECT * FROM trials').length, 0);
  const saved = JSON.parse(inspect('SELECT progress FROM attempts')[0].progress);
  assert.equal(saved.verification.challenge_id, second.challenge.challenge_id);

  const eventLoss = loseAcknowledgement(call => call.path === '/v1/events' && call.body.name === 'trial_started');
  await start();
  const recovered = await Promise.all(Array.from({ length: 8 }, () => ok('/api/trials', intent, ada)));
  const final = recovered[0]; assertFinal(final, 'ALLOW');
  assert.equal(final.result.decision_id, allowed.response.decision_id);
  for (const response of recovered) assert.deepEqual(response, final);
  decisions.push(final.result);
  const delivered = await eventLoss.reached.promise;
  assert.equal(delivered.status, 200);
  assert.equal(delivered.response.duplicate, false);
  await stop('SIGKILL'); eventLoss.release.resolve();
  assert.equal(inspect('SELECT * FROM trials').length, 1);
  assert.equal(inspect('SELECT * FROM outbox').length, 1);
  await start();
  for (let i = 0; i < 80 && !calls.some(call => call.body.event_id === delivered.body.event_id && call.response?.duplicate === true); i++) await sleep(50);
  assert.ok(calls.some(call => call.body.event_id === delivered.body.event_id && call.response?.duplicate === true));
  assert.deepEqual(await ok('/api/trials', intent, ada), final);
  assert.equal((await ok('/api/session', undefined, ada)).trial_until, final.result.trial_until);

  const ben = await login('ben');
  const benPending = await ok('/api/trials', await prepared(), ben);
  const reused = await api(continuePath(benPending), { verification: await solve(benPending.challenge, 'good', firstEvidence.token) }, ben);
  assert.equal(reused.status, 422);
  assert.equal(reused.data.error.code, 'krine_rejected');
  assert.match(reused.data.error.message, /verification_used/);
  assert.equal((await ok('/api/session', undefined, ben)).trial_until, null);

  const cora = await login('cora');
  for (const mode of ['hostname', 'action', 'binding', 'failure', 'timeout']) {
    const pending = await ok('/api/trials', await prepared(), cora);
    assert.equal(pending.status, 'pending');
    const denied = await ok(continuePath(pending), { verification: await solve(pending.challenge, mode) }, cora);
    assertFinal(denied, 'DENY');
    assert.equal((await ok('/api/session', undefined, cora)).trial_until, null);
    assert.deepEqual(await ok(continuePath(denied), {}, cora), denied);
    decisions.push({ ...denied.result, case: mode });
  }
  const pending = await ok('/api/trials', await prepared(), cora);
  const evidence = await solve(pending.challenge);
  const next = await ok(continuePath(pending), { verification: evidence }, cora);
  assert.equal(next.status, 'pending');
  const stepReplay = await api(continuePath(next), { verification: await solve(next.challenge, 'good', evidence.token) }, cora);
  assert.equal(stepReplay.status, 422);
  assert.match(stepReplay.data.error.message, /verification_used/);
  assert.equal((await ok('/api/session', undefined, cora)).trial_until, null);

  // All retries sent the original proof/IP/user/business inputs; only verification advances.
  const originals = new Map();
  for (const call of calls.filter(call => call.path === '/v1/checks/evaluate')) {
    const { verification: _, ...immutable } = call.body;
    if (originals.has(immutable.operation_id)) assert.deepEqual(immutable, originals.get(immutable.operation_id));
    else originals.set(immutable.operation_id, immutable);
  }
  await stop();
  assert.equal(inspect('SELECT * FROM trials').length, 1);
  assert.equal(inspect('SELECT * FROM outbox').length, 0);
  process.stdout.write(JSON.stringify({ grants: 1, process_crashes: processCrashes, decisions }));
} finally {
  clearTimeout(deadline);
  await cleanup();
}
