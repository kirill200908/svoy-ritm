import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import worker from './index.mjs';

const MAX_BODY = 16 * 1024;
const PUBLIC_PAGES = [
  ['login', 'https://schools.by/login'],
  ['school', 'https://lyceum.schools.by/'],
];
const SCHOOL_HOSTS = new Set(['schools.by', 'lyceum.schools.by']);

async function publicProbe(fetcher) {
  return Promise.all(PUBLIC_PAGES.map(async ([service, initial]) => {
    const started = Date.now();
    let address = initial;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const target = new URL(address);
        if (target.protocol !== 'https:' || target.port || !SCHOOL_HOSTS.has(target.hostname) || target.username || target.password) throw new Error('redirect');
        const response = await fetcher(address, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
        await response.body?.cancel();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('redirect');
          address = new URL(location, address).href;
          continue;
        }
        return { service, reachable: response.ok, status: response.status, elapsedMs: Date.now() - started };
      }
    } catch { /* Return no upstream text, URLs, cookies or connection details. */ }
    return { service, reachable: false, elapsedMs: Date.now() - started };
  }));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { chunks.length = 0; reject(Object.assign(new Error('body'), { status: 413 })); }
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function writeJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

export function createNodeServer({ env = process.env, app = worker, fetcher = fetch } = {}) {
  let probe;
  let probeExpires = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const origin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${incoming.socket.localPort}`;
      const path = incoming.url || '/';
      if (!path.startsWith('/') || path.startsWith('//')) return writeJson(outgoing, 400, { error: 'invalid_request' });
      const url = new URL(path, origin);
      if (url.origin !== new URL(origin).origin) return writeJson(outgoing, 400, { error: 'invalid_request' });
      if (url.pathname === '/healthz') return writeJson(outgoing, incoming.method === 'GET' ? 200 : 405, { ok: incoming.method === 'GET' });
      if (url.pathname === '/health/schools') {
        if (incoming.method !== 'GET') return writeJson(outgoing, 405, { error: 'method_not_allowed' });
        // Safe to run before any diary secrets exist. Only the two public pages are probed.
        if (!probe || Date.now() >= probeExpires) { probeExpires = Date.now() + 30000; probe = publicProbe(fetcher); }
        return writeJson(outgoing, 200, { checks: await probe });
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && !['host', 'cf-connecting-ip', 'oai-authenticated-user-id'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      // Do not trust visitor-supplied platform identity or proxy IP headers.
      headers.set('cf-connecting-ip', incoming.socket.remoteAddress || 'unknown-network');
      const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : await readBody(incoming);
      const request = new Request(url, { method: incoming.method, headers, ...(body ? { body } : {}) });
      const result = await app.fetch(request, env);
      const resultHeaders = Object.fromEntries([...result.headers].filter(([key]) => key !== 'set-cookie'));
      const cookies = result.headers.getSetCookie();
      if (cookies.length) resultHeaders['set-cookie'] = cookies;
      outgoing.writeHead(result.status, resultHeaders);
      outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
    } catch (failure) {
      if (!outgoing.headersSent) writeJson(outgoing, failure.status === 413 ? 413 : 500, { error: failure.status === 413 ? 'request_too_large' : 'server_error' });
      else outgoing.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  createNodeServer().listen(port, '0.0.0.0', () => console.log(`Свой ритм: listening on ${port}`));
}
