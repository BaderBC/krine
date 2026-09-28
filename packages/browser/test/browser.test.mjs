import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KrineBrowser, KrineError, solveChallenge } from '../dist/index.js';

const now = Date.now();
const context = { client_id: 'cli_1', session_id: 'ses_1', client_token: 'client_secret', session_token: 'session_secret', expires_at: now + 86_400_000 };
const proof = { proof: 'fresh_proof', client_id: 'cli_1', session_id: 'ses_1', expires_at: now + 60_000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const options = { url: 'https://krine.example', publicKey: 'public_key', retries: 0, signals: () => ({ webdriver: false }) };
const key = 'krine:v1:https://krine.example:public_key';
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('storage rejection retains Krine-issued context in memory and each prepare obtains a fresh proof', async () => {
  const denied = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('blocked'); } };
  const calls = [];
  const browser = new KrineBrowser({ ...options, localStorage: denied, sessionStorage: denied, fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return json(url.endsWith('/context') ? context : { ...proof, proof: `proof_${calls.length}` });
  } });
  assert.deepEqual(await browser.initialize(), { client_id: 'cli_1', session_id: 'ses_1' });
  const first = await browser.prepare('can_register');
  const second = await browser.prepare('can_register');
  assert.notEqual(first.proof, second.proof);
  assert.equal(calls.filter(call => call.url.endsWith('/context')).length, 1);
  assert.deepEqual(calls[1].body, { client_token: 'client_secret', session_token: 'session_secret', check: 'can_register' });
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('stored session is used only with its matching client credential', async () => {
  for (const [client, savedSession, expectedSession] of [
    ['client_secret', { client_token: 'client_secret', session_token: 'session_secret' }, 'session_secret'],
    ['other_client', { client_token: 'client_secret', session_token: 'session_secret' }, undefined],
    [null, { client_token: 'client_secret', session_token: 'session_secret' }, undefined],
  ]) {
    let body;
    const local = storage(client ? { [key]: client } : {});
    const session = storage({ [key]: JSON.stringify(savedSession) });
    const browser = new KrineBrowser({ ...options, localStorage: local, sessionStorage: session, fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); } });
    await browser.initialize();
    assert.equal(body.session_token, expectedSession);
    assert.equal(local.values.get(key), 'client_secret');
    assert.deepEqual(JSON.parse(session.values.get(key)), { client_token: 'client_secret', session_token: 'session_secret' });
  }
});

test('concurrent initialization shares context and invalid context recovers once', async () => {
  let contexts = 0, proofs = 0;
  const browser = new KrineBrowser({ ...options, localStorage: storage(), sessionStorage: storage(), fetch: async url => {
    if (url.endsWith('/context')) { contexts++; return json(context); }
    proofs++;
    return proofs === 1 ? json({ error: { code: 'invalid_context' } }, 422) : json(proof);
  } });
  await Promise.all([browser.initialize(), browser.initialize()]);
  assert.equal(contexts, 1);
  assert.deepEqual(await browser.prepare('can_register'), proof);
  assert.equal(contexts, 2);
  assert.equal(proofs, 2);
});

test('context recovery does not mask project auth errors and proof mismatches fail closed', async () => {
  for (const response of [json({ error: { code: 'unauthenticated' } }, 401), json({ ...proof, client_id: 'other' })]) {
    let calls = 0;
    const browser = new KrineBrowser({ ...options, localStorage: null, sessionStorage: null, fetch: async url => {
      calls++; return url.endsWith('/context') ? json(context) : response;
    } });
    await assert.rejects(browser.prepare('can_register'), KrineError);
    assert.equal(calls, 2);
  }
});

test('signals are bounded and preserve missing or unknown automation evidence', async () => {
  let body;
  const browser = new KrineBrowser({ ...options, localStorage: null, sessionStorage: null,
    signals: () => ({ language: 'x'.repeat(1025), platform: 'test', hardware_concurrency: Infinity, screen_width: 32769, screen_height: 800, webdriver: 'false', fingerprint: 'abc' }),
    fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); },
  });
  await browser.initialize();
  assert.deepEqual(body.signals, { platform: 'test', fingerprint: 'abc', screen_height: 800 });
});

const challenge = { challenge_id: 'ch_1', provider: 'turnstile', site_key: 'site_1', action: 'krine', binding: 'bound_step_1', expires_at: now + 300_000 };
const container = { ownerDocument: {} };

test('verification binds each widget to the exact challenge step and cleans it up', async () => {
  const rendered = [], removed = [];
  const adapter = {
    render(_container, params) { rendered.push(params); queueMicrotask(() => params.callback('token_' + rendered.length)); return 'widget_' + rendered.length; },
    remove(id) { removed.push(id); },
  };
  assert.deepEqual(await solveChallenge(challenge, container, { adapter }), { challenge_id: 'ch_1', token: 'token_1' });
  assert.deepEqual(await solveChallenge({ ...challenge, challenge_id: 'ch_2', binding: 'bound_step_2' }, container, { adapter }), { challenge_id: 'ch_2', token: 'token_2' });
  assert.equal(rendered[0].cData, 'bound_step_1');
  assert.equal(rendered[1].cData, 'bound_step_2');
  assert.equal(rendered[0].sitekey, 'site_1');
  assert.equal(rendered[0].action, 'krine');
  assert.deepEqual(removed, ['widget_1', 'widget_2']);
});

test('widget errors, expiration, cancellation and timeout reject and remove the widget', async () => {
  for (const callback of ['error-callback', 'expired-callback', 'unsupported-callback', 'timeout-callback']) {
    let removed = false;
    const adapter = { render(_container, params) { queueMicrotask(() => params[callback]()); return 'widget'; }, remove() { removed = true; } };
    await assert.rejects(solveChallenge(challenge, container, { adapter }), KrineError);
    assert.equal(removed, true);
  }
  let removed = 0;
  const adapter = { render() { return 'widget'; }, remove() { removed++; } };
  const controller = new AbortController();
  const pending = solveChallenge(challenge, container, { adapter, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'challenge_cancelled');
  await assert.rejects(solveChallenge(challenge, container, { adapter, timeoutMs: 5 }), error => error.code === 'challenge_timeout');
  assert.equal(removed, 2);
  await assert.rejects(solveChallenge({ ...challenge, expires_at: Date.now() - 1 }, container, { adapter }), error => error.code === 'challenge_expired');
});

test('synchronous provider callback also cleans up its widget', async () => {
  let removed = false;
  await solveChallenge(challenge, container, { adapter: { render(_container, params) { params.callback('token'); return 'widget'; }, remove() { removed = true; } } });
  assert.equal(removed, true);
});

test('script loader failures reject, remove the failed script and permit a later retry', async () => {
  const scripts = [];
  const document = {
    defaultView: {},
    createElement() { const script = { remove() { script.removed = true; } }; scripts.push(script); return script; },
    head: { appendChild(script) { queueMicrotask(() => script.onerror()); } },
  };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(solveChallenge(challenge, { ownerDocument: document }, { nonce: 'csp_nonce' }), error => error.code === 'challenge_load_failed');
  }
  assert.equal(scripts.length, 2);
  assert.ok(scripts.every(script => script.removed && script.nonce === 'csp_nonce'));
  assert.equal(scripts[0].src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
});

test('participation credentials have an explicit copy-only application handoff', async () => {
  let proofRequest;
  const browser = new KrineBrowser({ ...options, localStorage: null, sessionStorage: null, fetch: async (url, init) => {
    if (url.endsWith('/context')) return json(context);
    proofRequest = JSON.parse(init.body);
    return json(proof);
  } });
  const credentials = await browser.getContextCredentials();
  assert.deepEqual(credentials, { client_token: 'client_secret', session_token: 'session_secret' });
  credentials.client_token = 'changed_by_caller';
  await browser.prepare('can_register');
  assert.equal(proofRequest.client_token, 'client_secret');
  assert.deepEqual(await browser.initialize(), { client_id: 'cli_1', session_id: 'ses_1' });
});

test('both dedicated backend context errors repair once, while unrelated errors do not repair', async () => {
  for (const code of ['invalid_context', 'context_expired']) {
    let contextRequests = 0, proofRequests = 0;
    const browser = new KrineBrowser({ ...options, localStorage: storage(), sessionStorage: storage(), fetch: async url => {
      if (url.endsWith('/context')) { contextRequests++; return json(context); }
      proofRequests++;
      return json({ error: { code } }, 422);
    } });
    await assert.rejects(browser.prepare('can_register'), error => error.code === code);
    assert.equal(contextRequests, 2);
    assert.equal(proofRequests, 2);
  }
  for (const [status, code] of [[422, 'invalid_input'], [401, 'unauthenticated'], [403, 'forbidden'], [422, 'invalid_credentials']]) {
    let contextRequests = 0, proofRequests = 0;
    const browser = new KrineBrowser({ ...options, localStorage: null, sessionStorage: null, fetch: async url => {
      if (url.endsWith('/context')) { contextRequests++; return json(context); }
      proofRequests++;
      return json({ error: { code } }, status);
    } });
    await assert.rejects(browser.prepare('can_register'), error => error.code === code);
    assert.equal(contextRequests, 1);
    assert.equal(proofRequests, 1);
  }
});
