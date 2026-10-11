import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer, startServer } from '../src/server/server.js';
import { init, writeConfig } from '../src/server/store.js';

const DASH = 7841 + (process.pid % 100);

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'uidit-proxy-'));
  init(cwd);
  return cwd;
}

/** A Vite-shaped target: root-absolute asset URLs, chunked HTML response. */
function devServer({ host = '127.0.0.1', port = 0 } = {}) {
  const html = '<!doctype html><html><head><title>Target</title></head><body>'
    + '<script type="module" src="/@vite/client"></script>'
    + '<button id="go">Go</button></body></html>';
  const server = http.createServer((req, res) => {
    if (req.url === '/@vite/client') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('export const hot = true;');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // Chunked on purpose: injection must not leave a stale transfer-encoding header.
    res.write(html.slice(0, 20));
    res.end(html.slice(20));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port: server.address().port })));
}

let dash;
let hub;
let cwd;

test.before(async () => {
  cwd = project();
  ({ server: dash, hub } = await startServer({ cwd, port: DASH }));
  dash.unref();
});

test.after(() => {
  hub.close();
  dash.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('injects the overlay into a chunked HTML response without breaking framing', async () => {
  const { server, port } = await devServer();
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/`);
  const body = await res.text();
  server.close();
  assert.equal(res.status, 200);
  assert.match(body, /overlay\.js/);
  assert.equal(res.headers.get('transfer-encoding'), null);
});

test('serves root-absolute assets from the target (vite-style)', async () => {
  const { server, port } = await devServer();
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/@vite/client`);
  const body = await res.text();
  server.close();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(body, /export const hot/);
});

test("the previewed app's own /api routes reach the target, not uidit", async () => {
  const { server, port } = await hostileServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, from: 'target' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/api/status`);
  const body = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.equal(body.from, 'target');
});

test('uidit still owns its own routes', async () => {
  const html = await (await fetch(`http://127.0.0.1:${DASH}/`)).text();
  assert.match(html, /uidit/);
  assert.equal((await fetch(`http://127.0.0.1:${DASH}/overlay.js`)).status, 200);
});

test("uidit's own API routes are not forwarded even with a target set", async () => {
  const body = await (await fetch(`http://127.0.0.1:${DASH}/api/state`)).json();
  assert.ok(body.config, 'uidit api should answer, not proxy');
  assert.ok(Array.isArray(body.session.comments));
});

test('a dead target returns 502 instead of hanging', async () => {
  writeConfig(cwd, { targetUrl: 'http://127.0.0.1:1' });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/`);
  assert.equal(res.status, 502);
});

test('aborted requests do not crash the dashboard server', async () => {
  const { server, port } = await devServer();
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const controller = new AbortController();
  fetch(`http://127.0.0.1:${DASH}/proxy/`, { signal: controller.signal }).catch(() => {});
  controller.abort();
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  const res = await fetch(`http://127.0.0.1:${DASH}/api/state`);
  assert.equal(res.status, 200, 'server should still be serving after an aborted request');
});

test('an IPv6-only target is reachable via localhost', async (t) => {
  let ipv6;
  try {
    ipv6 = await devServer({ host: '::1' });
  } catch {
    return t.skip('IPv6 loopback unavailable');
  }
  writeConfig(cwd, { targetUrl: 'http://localhost:1' }); // forced miss, cache-safe
  ipv6.server.close();
  const { server, port } = await devServer({ host: '::1' });
  writeConfig(cwd, { targetUrl: `http://localhost:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/`);
  const body = await res.text();
  server.close();
  assert.equal(res.status, 200);
  assert.match(body, /overlay\.js/);
});
/** Hardening for dev servers that behave differently from each other. */
function hostileServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('redirects stay inside the proxy so the overlay survives', async () => {
  const { server, port } = await hostileServer((req, res) => {
    res.writeHead(302, { location: '/app/' });
    res.end();
  });
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/`, { redirect: 'manual' });
  server.close();
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/proxy\/app\//);
});

test('CSP is extended for the overlay while stale validators and cookie domains are removed', async () => {
  const { server, port } = await hostileServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      etag: '"abc123"',
      'content-security-policy': "default-src 'self'",
      'set-cookie': 'sid=1; Domain=localhost; Path=/',
    });
    res.end('<html><head></head><body>hi</body></html>');
  });
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/`);
  const body = await res.text();
  server.close();
  assert.equal(res.headers.get('etag'), null);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /frame-src 'self' http:\/\/127\.0\.0\.1:/);
  assert.equal(res.headers.get('set-cookie'), 'sid=1; Path=/');
  assert.match(body, /overlay\.js/);
});

test('a config file written outside uidit pushes the new target to the dashboard', async () => {
  const before = await fetch(`http://127.0.0.1:${DASH}/api/state`).then((r) => r.json());
  assert.ok(before.config);
  writeConfig(cwd, { targetUrl: 'http://127.0.0.1:4321' });
  await new Promise((r) => setTimeout(r, 400));
  const after = await fetch(`http://127.0.0.1:${DASH}/api/state`).then((r) => r.json());
  assert.equal(after.config.targetUrl, 'http://127.0.0.1:4321');
});

test('non-HTML responses stream through byte for byte', async () => {
  const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
  const { server, port } = await hostileServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(payload);
  });
  writeConfig(cwd, { targetUrl: `http://127.0.0.1:${port}` });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/blob.bin`);
  const got = Buffer.from(await res.arrayBuffer());
  server.close();
  assert.deepEqual(got, payload);
});

test('target errors surface as 502, not a blank frame', async () => {
  writeConfig(cwd, { targetUrl: 'http://127.0.0.1:1' });
  const res = await fetch(`http://127.0.0.1:${DASH}/proxy/`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /upstream failed/);
});
