import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AvailabilityError, HttpError, KrineError, KrineServer } from '../dist/index.js';

const request = { operation_id: 'op_1', check: 'can_register', proof: 'proof_secret', ip: '203.0.113.1', inputs: { amount: 42 } };
const now = Date.now();
const base = { operation_id: request.operation_id, decision_id: 'dec_1', source: 'evaluation', check: request.check, policy_version: 1, accepted_at: now, retry_until: now + 86_400_000, reason: 'matched_rule' };
const challenge = { challenge_id: 'ch_1', provider: 'turnstile', site_key: 'site_public', action: 'krine', binding: 'binding_1', expires_at: now + 300_000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const sdk = (fetch, options = {}) => new KrineServer({ url: 'https://krine.example', secretKey: 'server_secret', retries: 0, fetch, ...options });

test('evaluated allow/deny are distinct from configured local fallback', async () => {
  for (const outcome of ['ALLOW', 'DENY']) {
    const result = await sdk(async () => json({ ...base, outcome })).check(request);
    assert.deepEqual(result, { ...base, outcome });
  }
  const unavailable = async () => { throw Error('secret from dependency'); };
  assert.deepEqual(await sdk(unavailable).check(request), { source: 'fallback', outcome: 'ALLOW', reason: 'unavailable', operation_id: 'op_1', check: 'can_register' });
  assert.equal((await sdk(unavailable, { fallback: 'DENY' }).check(request)).outcome, 'DENY');
  assert.equal((await sdk(unavailable, { fallback: 'DENY', checkFallbacks: { can_register: 'ALLOW' } }).check(request)).outcome, 'ALLOW');
  assert.equal((await sdk(unavailable, { checkFallbacks: { can_register: 'DENY' } }).check(request)).outcome, 'DENY');
  assert.equal((await sdk(() => new Promise(() => {}), { timeoutMs: 10 }).check(request)).reason, 'timeout');
});

test('auth, proof, conflict, validation, provider and malformed responses never fallback', async () => {
  for (const [status, code] of [[401, 'unauthenticated'], [403, 'forbidden'], [409, 'operation_in_progress'], [409, 'proof_used'], [422, 'invalid_proof'], [503, 'provider_unavailable'], [500, 'invalid_configuration']]) {
    await assert.rejects(sdk(async () => json({ error: { code, message: 'server_secret' } }, status)).check(request), error => error instanceof HttpError && error.code === code && !error.message.includes('server_secret'));
  }
  for (const body of [null, {}, { ...base, outcome: 'ALLOW', source: 'fallback' }, { ...base, operation_id: 'other', outcome: 'ALLOW' }, { ...base, check: 'other', outcome: 'ALLOW' }, { ...base, policy_version: 0, outcome: 'ALLOW' }, { ...base, outcome: 'ALLOW', challenge }, { ...base, outcome: 'CHALLENGE_REQUIRED' }, { ...base, outcome: 'ALLOW', retry_until: now - 1 }]) {
    await assert.rejects(sdk(async () => json(body)).check(request), error => error instanceof KrineError && error.code === 'invalid_response');
  }
});

test('pending state survives JSON persistence and process replacement, and never falls back', async () => {
  const initial = await sdk(async () => json({ ...base, outcome: 'CHALLENGE_REQUIRED', challenge })).check(request);
  const pending = JSON.parse(JSON.stringify(initial.pending));
  assert.deepEqual(pending.request, request);
  for (const fetch of [async () => { throw Error('offline'); }, async () => json({ error: { code: 'rate_limited' } }, 429), () => new Promise(() => {})]) {
    await assert.rejects(sdk(fetch, { timeoutMs: 10 }).continueCheck(pending), AvailabilityError);
    await assert.rejects(sdk(fetch, { timeoutMs: 10 }).continueCheck(pending, { challenge_id: 'ch_1', token: 'provider_token' }), AvailabilityError);
  }
  await assert.rejects(sdk(async () => { throw Error(); }).check({ ...request, verification: { challenge_id: 'ch_1', token: 't' } }), error => error.code === 'invalid_input');
});

test('continuations preserve immutable request and advance only to a separately bound next challenge', async () => {
  const calls = [];
  const client = sdk(async (_url, init) => {
    calls.push(init.body);
    if (calls.length === 1) return json({ ...base, outcome: 'CHALLENGE_REQUIRED', challenge });
    if (calls.length === 2) return json({ ...base, outcome: 'CHALLENGE_REQUIRED', challenge: { ...challenge, challenge_id: 'ch_2', binding: 'binding_2' } });
    return json({ ...base, outcome: 'ALLOW' });
  });
  const first = await client.check(request);
  const second = await client.continueCheck(first.pending, { challenge_id: 'ch_1', token: 't'.repeat(2048) });
  assert.equal(second.pending.challenge_id, 'ch_2');
  assert.equal(second.challenge.binding, 'binding_2');
  const final = await client.continueCheck(second.pending, { challenge_id: 'ch_2', token: 'second' });
  assert.equal(final.outcome, 'ALLOW');
  for (const call of calls) { const { verification, ...immutable } = JSON.parse(call); assert.deepEqual(immutable, request); }
  await assert.rejects(client.continueCheck(second.pending, { challenge_id: 'ch_1', token: 'old' }), error => error.code === 'invalid_input');
});

test('continuation rejects changed decision identity and request mutation during fetch cannot corrupt pending state', async () => {
  const mutable = structuredClone(request);
  const initial = await sdk(async () => { mutable.proof = 'changed'; return json({ ...base, outcome: 'CHALLENGE_REQUIRED', challenge }); }).check(mutable);
  assert.equal(initial.pending.request.proof, 'proof_secret');
  for (const change of [{ decision_id: 'other' }, { accepted_at: now + 1 }, { retry_until: now + 1 }]) {
    await assert.rejects(sdk(async () => json({ ...base, ...change, outcome: 'ALLOW' })).continueCheck(initial.pending), error => error.code === 'invalid_response');
  }
});

test('transport retries preserve check and event identities and exact bodies', async () => {
  const calls = [];
  const client = sdk(async (url, init) => {
    calls.push(init.body);
    if (calls.length % 2 === 1) throw Error('offline');
    return url.endsWith('/events') ? json({ event_id: 'evt_1', accepted_at: now, duplicate: true }) : json({ ...base, outcome: 'ALLOW' });
  }, { retries: 1 });
  await client.check(request);
  await client.event({ event_id: 'evt_1', name: 'signup', user_id: 'user_1', properties: { nested: [null, { ok: true }] } });
  assert.equal(calls[0], calls[1]); assert.equal(calls[2], calls[3]);
});

test('events and associations validate acknowledgements and never apply check fallback', async () => {
  const event = { event_id: 'evt_1', name: 'signup', client_id: 'cli_1', session_id: 'ses_1' };
  await assert.rejects(sdk(async () => { throw Error(); }).event(event), AvailabilityError);
  await assert.rejects(sdk(async () => json({ event_id: 'other', accepted_at: now, duplicate: false })).event(event), error => error.code === 'invalid_response');
  const association = { association_id: 'assoc_1', client_id: 'cli_1', user_id: 'user_1', metadata: { plan: 'pro' } };
  const receipt = { ...association, created_at: now, revoked_at: null, provenance: 'backend' };
  assert.deepEqual(await sdk(async () => json(receipt)).associate(association), receipt);
  await assert.rejects(sdk(async () => json({ ...receipt, client_id: 'other' })).associate(association), error => error.code === 'invalid_response');
  await assert.rejects(sdk(async () => json(receipt)).event({ ...event, client_id: undefined }), error => error.code === 'invalid_input');
  await assert.rejects(sdk(async () => json(receipt)).event({ ...event, properties: { bad: NaN } }), error => error.code === 'invalid_input');
});

test('invalid IPs and non-ASCII credentials fail locally instead of triggering availability fallback', async () => {
  let calls = 0;
  const client = sdk(async () => { calls++; throw Error('offline'); });
  for (const ip of ['not-an-ip', '192.168.1.999', '127.1', '01.2.3.4', 'fe80::1%eth0', '::ffff:999.0.0.1']) {
    await assert.rejects(client.check({ ...request, ip }), error => error.code === 'invalid_input');
  }
  assert.equal(calls, 0);
  for (const ip of ['::1', '2001:db8::1', '::ffff:192.0.2.1', '192.0.2.1']) assert.equal((await client.check({ ...request, ip })).source, 'fallback');
  assert.throws(() => sdk(async () => json({}), { secretKey: '秘密' }), error => error.code === 'invalid_input');
});

test('server-authenticated context resolution accepts credentials and returns only verified IDs and expiry', async () => {
  const credentials = { client_token: 'client_secret', session_token: 'session_secret' };
  const resolved = { client_id: 'cli_1', session_id: 'ses_1', expires_at: now + 1000 };
  let requestCount = 0;
  const client = sdk(async (url, init) => {
    requestCount++;
    assert.equal(url, 'https://krine.example/v1/contexts/resolve');
    assert.equal(init.headers.Authorization, 'Bearer server_secret');
    assert.deepEqual(JSON.parse(init.body), credentials);
    return json(resolved);
  });
  assert.deepEqual(await client.resolveContext(credentials), resolved);
  for (const input of [null, {}, { client_token: 'client_secret' }, { ...credentials, client_id: 'forged' }, { ...credentials, session_token: '' }]) {
    await assert.rejects(client.resolveContext(input), error => error.code === 'invalid_input');
  }
  assert.equal(requestCount, 1);
});

test('context resolution never fabricates an identity or fallback on errors', async () => {
  const credentials = { client_token: 'client_secret', session_token: 'session_secret' };
  for (const body of [{}, { client_id: 'cli_1', session_id: 'ses_1' }, { client_id: 'cli_1', session_id: 1, expires_at: now }, { client_id: 'cli_1', session_id: 'ses_1', expires_at: -1 }]) {
    await assert.rejects(sdk(async () => json(body)).resolveContext(credentials), error => error.code === 'invalid_response');
  }
  for (const [status, code] of [[422, 'invalid_context'], [422, 'context_expired'], [401, 'unauthenticated']]) {
    await assert.rejects(sdk(async () => json({ error: { code } }, status)).resolveContext(credentials), error => error instanceof HttpError && error.code === code);
  }
  await assert.rejects(sdk(async () => { throw Error('offline'); }).resolveContext(credentials), AvailabilityError);
});

test('proof-bound context resolution validates and preserves the full interaction without fallback', async () => {
  const input = { interaction: { proof: 'proof_secret', check: 'can_claim_trial', ip: '::ffff:127.0.0.1' } };
  const resolved = { client_id: 'cli_1', session_id: 'ses_1', expires_at: now + 60_000 };
  let calls = 0;
  const client = sdk(async (url, init) => {
    calls++; assert.equal(url, 'https://krine.example/v1/contexts/resolve');
    assert.deepEqual(JSON.parse(init.body), input); return json(resolved);
  });
  assert.deepEqual(await client.resolveContext(input), resolved);
  for (const interaction of [null, {}, { proof: 'p', check: 'c' }, { ...input.interaction, proof: '' },
    { ...input.interaction, check: 'invalid check' }, { ...input.interaction, ip: '127.1' },
    { ...input.interaction, client_id: 'attacker_selected' }]) {
    await assert.rejects(client.resolveContext({ ...input, interaction }), error => error.code === 'invalid_input');
  }
  await assert.rejects(client.resolveContext({ ...input, client_token: 'client_secret', session_token: 'session_secret' }), error => error.code === 'invalid_input');
  assert.equal(calls, 1);
  for (const [status, code] of [[422, 'invalid_proof'], [422, 'invalid_context'], [401, 'unauthenticated'], [503, 'unavailable']]) {
    await assert.rejects(sdk(async () => json({ error: { code } }, status)).resolveContext(input), error => error instanceof KrineError);
  }
  const mutable = structuredClone(input);
  const serialized = [];
  const retrying = sdk(async (_url, init) => {
    serialized.push(init.body);
    if (serialized.length === 1) { mutable.interaction.proof = 'changed'; throw Error('offline'); }
    return json(resolved);
  }, { retries: 1 });
  assert.deepEqual(await retrying.resolveContext(mutable), resolved);
  assert.equal(serialized.length, 2); assert.equal(serialized[0], serialized[1]);
  assert.equal(JSON.parse(serialized[1]).interaction.proof, input.interaction.proof);
});


test('association retries preserve corrected state and validate optional session provenance', async () => {
  const association = { association_id: 'assoc_session', client_id: 'cli_1', user_id: 'user_1', session_id: 'ses_1' };
  const receipt = { ...association, metadata: {}, created_at: now, revoked_at: now + 10, provenance: 'backend', credential_id: 'cred_1', revision: 2, revocation_reason: 'Wrong account', revoked_by: 'administrator' };
  const bodies = [];
  const client = sdk(async (_url, init) => { bodies.push(init.body); return json(receipt); });
  assert.deepEqual(await client.associate(association), receipt);
  assert.deepEqual(await client.associate(association), receipt);
  assert.equal(bodies[0], bodies[1]);
  for (const change of [{ session_id: 'ses_other' }, { session_id: null }, { revoked_at: -1 }, { revoked_at: now - 1 }, { revision: 0 }, { credential_id: [] }, { revocation_reason: 'x'.repeat(513) }]) {
    await assert.rejects(sdk(async () => json({ ...receipt, ...change })).associate(association), error => error.code === 'invalid_response');
  }
  await assert.rejects(client.associate({ ...association, session_id: 2 }), error => error.code === 'invalid_input');
  const legacy = { association_id: 'assoc_legacy', client_id: 'cli_1', user_id: 'user_1' };
  const legacyReceipt = { ...legacy, metadata: {}, created_at: now, revoked_at: null, provenance: 'backend' };
  assert.deepEqual(await sdk(async () => json(legacyReceipt)).associate(legacy), legacyReceipt);
  assert.deepEqual(await sdk(async () => json({ ...legacyReceipt, session_id: null })).associate({ ...legacy, session_id: null }), { ...legacyReceipt, session_id: null });
});
