import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AvailabilityError, HttpError, KrineError, Transport, jsonBody } from '../dist/index.js';

const options = { url: 'https://krine.example', retries: 0 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('transport retries the exact serialized body and bounds the entire operation', async () => {
  const requests = [];
  const transport = new Transport({ ...options, retries: 1, fetch: async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) throw new Error('sensitive implementation data');
    return json({ ok: true });
  } }, { Authorization: 'Bearer secret' });
  assert.deepEqual(await transport.post('/v1/events', '{"event_id":"one"}'), { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.credentials, 'omit');
  const hanging = new Transport({ ...options, timeoutMs: 20, fetch: () => new Promise(() => {}) }, {});
  const started = performance.now();
  await assert.rejects(hanging.post('/v1/events', '{}'), error => error instanceof AvailabilityError && error.reason === 'timeout');
  assert.ok(performance.now() - started < 300);
});

test('successful malformed, oversized and empty payloads fail closed', async () => {
  for (const response of [new Response('not-json'), new Response(''), new Response('x'.repeat(65_537)), new Response('{}', { status: 201 })]) {
    const transport = new Transport({ ...options, fetch: async () => response }, {});
    await assert.rejects(transport.post('/v1/events', '{}'), error => error instanceof KrineError && error.code === 'invalid_response');
  }
});

test('structured semantic errors cannot become availability failures even with a 5xx status', async () => {
  for (const code of ['invalid_proof', 'unauthenticated', 'input_conflict', 'provider_unavailable', 'invalid_configuration']) {
    const transport = new Transport({ ...options, fetch: async () => json({ error: { code, message: 'Bearer secret' } }, 503) }, {});
    await assert.rejects(transport.post('/v1/checks/evaluate', '{}'), error => error instanceof HttpError && error.code === code && !error.message.includes('secret'));
  }
});

test('network, rate limits and generic unavailable responses are typed', async () => {
  for (const [fetch, reason] of [
    [async () => { throw Error('secret'); }, 'unavailable'],
    [async () => json({ error: { code: 'rate_limited' } }, 429), 'rate_limited'],
    [async () => new Response('gateway unavailable', { status: 502 }), 'unavailable'],
  ]) {
    const transport = new Transport({ ...options, fetch }, {});
    await assert.rejects(transport.post('/v1/events', '{}'), error => error instanceof AvailabilityError && error.reason === reason && !error.message.includes('secret'));
  }
});

test('real HTTP redirects never forward a server key', async t => {
  let targetRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/target') { targetRequests++; res.end('{}'); }
    else { res.writeHead(307, { Location: '/target' }); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = new Transport({ url: `http://127.0.0.1:${server.address().port}`, allowInsecureHttp: true, retries: 0 }, { Authorization: 'Bearer secret' });
  await assert.rejects(transport.post('/start', '{}'), error => error instanceof HttpError && error.code === 'redirect_refused');
  assert.equal(targetRequests, 0);
});

test('configuration and JSON validation reject unsafe coercions before network use', () => {
  for (const url of ['http://krine.example', 'https://user:secret@krine.example', 'https://krine.example?secret=abc', 'file:///tmp/data']) {
    assert.throws(() => new Transport({ ...options, url }, {}), KrineError);
  }
  for (const value of [{ n: NaN }, { n: Infinity }, { n: undefined }, { n: new Date() }, { n: 1n }]) assert.throws(() => jsonBody(value), KrineError);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => jsonBody(cycle), KrineError);
  assert.equal(jsonBody({ token: 't'.repeat(2048) }).length, 2060);
});

test('Retry-After longer than the deadline prevents an early retry', async () => {
  let attempts = 0;
  const transport = new Transport({ ...options, retries: 3, timeoutMs: 500, fetch: async () => {
    attempts++;
    return new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429, headers: { 'Retry-After': '30' } });
  } }, {});
  await assert.rejects(transport.post('/v1/events', '{}'), error => error instanceof AvailabilityError && error.reason === 'rate_limited');
  assert.equal(attempts, 1);
});

test('refusing a streaming redirect promptly closes the unfinished HTTP response', async t => {
  let closed;
  const responseClosed = new Promise(resolve => { closed = resolve; });
  let targetRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/target') { targetRequests++; res.end('{}'); return; }
    res.on('close', closed);
    res.writeHead(307, { Location: '/target' });
    res.flushHeaders();
    res.write('unfinished response');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const transport = new Transport({
    url: `http://127.0.0.1:${server.address().port}`, allowInsecureHttp: true, retries: 0, timeoutMs: 100,
  }, { Authorization: 'Bearer secret' });
  await assert.rejects(transport.post('/start', '{}'), error => error instanceof HttpError && error.code === 'redirect_refused');
  let timer;
  try {
    await Promise.race([responseClosed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Refused redirect response remained connected')), 500);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(targetRequests, 0);
});

test('default fetch retains its global receiver as required by native browsers', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async function (url, init) {
    assert.equal(this, globalThis, 'Native Window.fetch rejects a Transport receiver');
    assert.equal(url, 'https://krine.example/v1/browser/context');
    assert.equal(init.method, 'POST'); assert.equal(init.body, '{"signals":{}}');
    calls++;
    return json({ accepted: true });
  });
  const transport = new Transport(options, { 'X-Krine-Public-Key': 'public' });
  assert.deepEqual(await transport.post('/v1/browser/context', '{"signals":{}}'), { accepted: true });
  assert.equal(calls, 1);
});
