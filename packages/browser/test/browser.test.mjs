import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KrineBrowser, KrineError, solveChallenge } from '../dist/index.js';

const now = Date.now();
const context = { client_id: 'cli_1', session_id: 'ses_1', client_token: 'client_secret', session_token: 'session_secret', expires_at: now + 86_400_000 };
const proof = { proof: 'fresh_proof', client_id: 'cli_1', session_id: 'ses_1', expires_at: now + 60_000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const options = { url: 'https://krine.example', publicKey: 'public_key', retries: 0, signals: () => ({ webdriver: false }) };
const key = 'krine:v2:https://krine.example';
const legacyKey = 'krine:v1:https://krine.example:public_key';
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('public-key rotation preserves context at the same normalized installation URL', async () => {
  const local = storage(), session = storage(), requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, publicKey: init.headers['X-Krine-Public-Key'] });
    const resumed = requests.length === 1
      || (body.client_token === context.client_token && body.session_token === context.session_token);
    return json(resumed ? context : {
      ...context, client_id: 'cli_replacement', session_id: 'ses_replacement',
      client_token: 'replacement_client', session_token: 'replacement_session',
    });
  };
  const common = { ...options, localStorage: local, sessionStorage: session, fetch };
  const before = await new KrineBrowser({ ...common, publicKey: 'old_key' }).initialize();
  const replacement = new KrineBrowser({ ...common, url: 'https://KRINE.example:443/', publicKey: 'new_key' });
  assert.deepEqual(await replacement.initialize(), before);
  assert.deepEqual(await replacement.getContextCredentials(), {
    client_token: context.client_token, session_token: context.session_token,
  });
  assert.deepEqual(requests[1], {
    publicKey: 'new_key', body: {
      client_token: context.client_token, session_token: context.session_token, signals: { webdriver: false },
    },
  });
});

test('current-key legacy context migrates on initialization and survives a later key rotation', async () => {
  const local = storage({ [legacyKey]: context.client_token });
  const session = storage({ [legacyKey]: JSON.stringify({ client_token: context.client_token, session_token: context.session_token }) });
  const requests = [];
  const common = { ...options, localStorage: local, sessionStorage: session, fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return json(context);
  } };
  await new KrineBrowser(common).initialize();
  assert.equal(local.values.get(key), context.client_token);
  assert.deepEqual(JSON.parse(session.values.get(key)), {
    client_token: context.client_token, session_token: context.session_token,
  });
  await new KrineBrowser({ ...common, publicKey: 'replacement_key' }).initialize();
  for (const body of requests) {
    assert.equal(body.client_token, context.client_token);
    assert.equal(body.session_token, context.session_token);
  }
});

test('URL-based context takes precedence over a different legacy context', async () => {
  let body;
  const browser = new KrineBrowser({ ...options,
    localStorage: storage({ [key]: context.client_token, [legacyKey]: 'legacy_client' }),
    sessionStorage: storage({
      [key]: JSON.stringify({ client_token: context.client_token, session_token: context.session_token }),
      [legacyKey]: JSON.stringify({ client_token: 'legacy_client', session_token: 'legacy_session' }),
    }),
    fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); },
  });
  await browser.initialize();
  assert.equal(body.client_token, context.client_token);
  assert.equal(body.session_token, context.session_token);
});

test('partial migration only resumes a legacy session belonging to the saved client', async () => {
  for (const savedClient of [context.client_token, 'other_client']) {
    let body;
    const browser = new KrineBrowser({ ...options,
      localStorage: storage({ [key]: savedClient, [legacyKey]: context.client_token }),
      sessionStorage: storage({ [legacyKey]: JSON.stringify({ client_token: context.client_token, session_token: context.session_token }) }),
      fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); },
    });
    await browser.initialize();
    assert.equal(body.client_token, savedClient);
    assert.equal(body.session_token, savedClient === context.client_token ? context.session_token : undefined);
  }
});

test('context remains isolated by API origin and deployment path', async () => {
  const local = storage({ [key]: context.client_token });
  const session = storage({ [key]: JSON.stringify({ client_token: context.client_token, session_token: context.session_token }) });
  for (const url of ['https://other.example', 'https://krine.example:8443', 'http://krine.example', 'https://krine.example/first', 'https://krine.example/second']) {
    let body;
    const browser = new KrineBrowser({ ...options, url, allowInsecureHttp: true, localStorage: local, sessionStorage: session,
      fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); },
    });
    await browser.initialize();
    assert.equal(body.client_token, undefined, url);
    assert.equal(body.session_token, undefined, url);
  }
});

test('migration does not discover legacy credentials under a different public key', async () => {
  let body;
  const browser = new KrineBrowser({ ...options, publicKey: 'replacement_key',
    localStorage: storage({ [legacyKey]: context.client_token }),
    sessionStorage: storage({ [legacyKey]: JSON.stringify({ client_token: context.client_token, session_token: context.session_token }) }),
    fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); },
  });
  await browser.initialize();
  assert.equal(body.client_token, undefined);
  assert.equal(body.session_token, undefined);
});

test('failed initialization leaves legacy context available for retry without migrating it', async () => {
  const local = storage({ [legacyKey]: context.client_token });
  const session = storage({ [legacyKey]: JSON.stringify({ client_token: context.client_token, session_token: context.session_token }) });
  let calls = 0;
  const browser = new KrineBrowser({ ...options, localStorage: local, sessionStorage: session,
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).client_token, context.client_token);
      return ++calls === 1 ? json({ error: { code: 'unauthenticated' } }, 401) : json(context);
    },
  });
  await assert.rejects(browser.initialize(), error => error.code === 'unauthenticated');
  assert.equal(local.values.has(key), false);
  assert.equal(session.values.has(key), false);
  await browser.initialize();
  assert.equal(local.values.get(key), context.client_token);
});

test('blocked migration writes still preserve the legacy context in memory', async () => {
  const readonly = value => ({
    getItem: savedKey => savedKey === legacyKey ? value : null,
    setItem() { throw Error('quota'); },
    removeItem() { throw Error('blocked'); },
  });
  let contexts = 0;
  const browser = new KrineBrowser({ ...options,
    localStorage: readonly(context.client_token),
    sessionStorage: readonly(JSON.stringify({ client_token: context.client_token, session_token: context.session_token })),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.client_token, context.client_token);
      assert.equal(body.session_token, context.session_token);
      if (url.endsWith('/context')) { contexts++; return json(context); }
      return json(proof);
    },
  });
  await browser.initialize();
  assert.deepEqual(await browser.prepare('can_register'), proof);
  await browser.getContextCredentials();
  assert.equal(contexts, 1);
});

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
  for (const savedKey of [key, legacyKey]) for (const [client, savedSession, expectedSession] of [
    ['client_secret', JSON.stringify({ client_token: 'client_secret', session_token: 'session_secret' }), 'session_secret'],
    ['other_client', JSON.stringify({ client_token: 'client_secret', session_token: 'session_secret' }), undefined],
    [null, JSON.stringify({ client_token: 'client_secret', session_token: 'session_secret' }), undefined],
    ['client_secret', '{broken json', undefined],
    ['client_secret', JSON.stringify({ client_token: 'client_secret', session_token: '' }), undefined],
    ['client_secret', JSON.stringify({ client_token: 'client_secret', session_token: 42 }), undefined],
    ['x'.repeat(4097), JSON.stringify({ client_token: 'x'.repeat(4097), session_token: 'session_secret' }), undefined],
  ]) {
    let body;
    const local = storage(client ? { [savedKey]: client } : {});
    const session = storage({ [savedKey]: savedSession });
    const browser = new KrineBrowser({ ...options, localStorage: local, sessionStorage: session, fetch: async (_url, init) => { body = JSON.parse(init.body); return json(context); } });
    await browser.initialize();
    assert.equal(body.session_token, expectedSession);
    assert.equal(body.client_token, client && client.length <= 4096 ? client : undefined);
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
