import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNodeServer } from './server.mjs';

async function run(t, options) {
  const server = createNodeServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the bundled site and health check work before diary secrets are configured', async t => {
  const base = await run(t, { env: {} });
  const page = await fetch(base);
  assert.equal(page.status, 200);assert.match(await page.text(), /Свой ритм/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const status = await fetch(base + '/api/schools/status');
  assert.equal(status.status, 503);assert.equal((await status.json()).error, 'configuration');
});

test('canonical origin, JSON body and multiple secure cookies survive the Node adapter', async t => {
  let received;
  const base = await run(t, { env: { PUBLIC_ORIGIN: 'https://example.onrender.com' }, app: { async fetch(request) {
    received = { url: request.url, origin: request.headers.get('origin'), body: await request.json(), legacy: request.headers.get('oai-authenticated-user-id'), ip: request.headers.get('cf-connecting-ip') };
    const headers = new Headers();
    headers.append('Set-Cookie', 'one=test; HttpOnly; Secure; SameSite=Strict');
    headers.append('Set-Cookie', 'two=test; HttpOnly; Secure; SameSite=Strict');
    return new Response('{}', { headers });
  } } });
  const response = await fetch(base + '/api/schools/connect', { method: 'POST', headers: { Origin: 'https://example.onrender.com', 'Content-Type': 'application/json', 'cf-connecting-ip': 'spoofed', 'oai-authenticated-user-id': 'spoofed' }, body: JSON.stringify({ test: true }) });
  assert.equal(response.status, 200);assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(received.url, 'https://example.onrender.com/api/schools/connect');assert.equal(received.origin, 'https://example.onrender.com');assert.deepEqual(received.body, { test: true });
  assert.equal(received.legacy, null);assert.notEqual(received.ip, 'spoofed');
});

test('large request bodies are rejected before reaching the diary handler', async t => {
  let calls = 0;
  const base = await run(t, { app: { fetch() { calls++; return new Response(); } } });
  const response = await fetch(base + '/api/schools/connect', { method: 'POST', body: 'x'.repeat(17000) });
  assert.equal(response.status, 413);assert.equal(calls, 0);
});

test('public Schools.by probes never use visitor credentials and are cached', async t => {
  const calls = [];
  const base = await run(t, { env: {}, fetcher: async (url, init) => {
    calls.push({ url, init });return new Response('public page');
  } });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/health/schools', { headers: { Cookie: 'private-session=test', Authorization: 'private-token' } });
    assert.equal(response.status, 200);assert.ok((await response.json()).checks.every(row => row.reachable));
  }
  assert.equal(calls.length, 2);assert.ok(calls.every(row => !row.init.headers && !row.init.body));
});

test('public probes do not follow redirects to other hosts or expose raw errors', async t => {
  const calls = [];
  const base = await run(t, { fetcher: async url => { calls.push(url);return new Response(null, { status: 302, headers: { Location: 'https://unrelated.example/private' } }); } });
  const response = await fetch(base + '/health/schools');const result = await response.json();
  assert.ok(result.checks.every(row => !row.reachable));assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private|unrelated/);
});
