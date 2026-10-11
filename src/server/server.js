import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { discoverTargets } from './discover.js';
import { createHub } from './realtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const DASHBOARD_DIST = path.join(HERE, '..', '..', 'dashboard', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(res, file, { injectOverlay = false } = {}) {
  const ext = path.extname(file);
  let body = fs.readFileSync(file);
  if (injectOverlay && ext === '.html') {
    body = Buffer.from(injectIntoHtml(body.toString('utf8')), 'utf8');
  }
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function injectIntoHtml(html, targetOrigin = '') {
  const tag = `<script src="/overlay.js" data-uidit="1"></script>` +
    `<script>window.__UIDIT_TARGET__=${JSON.stringify(targetOrigin)}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `${tag}\n${html}`;
}

function safeTargetUrl(raw) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error('target must be http(s)');
  return url;
}

const LOOPBACK_ALIASES = {
  localhost: ['127.0.0.1', '::1'],
  '127.0.0.1': ['::1', '127.0.0.1'],
  '::1': ['127.0.0.1', '::1'],
};

const reachableCache = new Map(); // `${host}:${port}` → { host, at }
const REACHABLE_TTL = 5000;

/**
 * Some dev servers bind IPv6-only ([::1]) and others IPv4-only, while `localhost`
 * resolves to whichever the OS prefers — so a pasted `http://localhost:5273` can be
 * refused even though the server is up. Probe the loopback forms once and remember the
 * winner, so a normal request never has to retry (retrying would need a replayed body).
 */
async function resolveReachable(url) {
  const hosts = LOOPBACK_ALIASES[url.hostname] ?? [url.hostname];
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const key = `${hosts[0]}:${port}`;
  const cached = reachableCache.get(key);
  if (cached && Date.now() - cached.at < REACHABLE_TTL) return cached.host;

  for (const host of hosts) {
    const ok = await new Promise((resolve) => {
      const socket = net.Socket();
      const done = (v) => { socket.removeAllListeners(); socket.destroy(); resolve(v); };
      socket.setTimeout(250);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
    if (ok) {
      reachableCache.set(key, { host, at: Date.now() });
      return host;
    }
  }
  reachableCache.set(key, { host: hosts[0], at: Date.now() });
  return hosts[0];
}

/** Headers that become wrong (or actively harmful) once uidit rewrites an HTML body. */
function scrubHtmlHeaders(headers) {
  const out = { ...headers };
  // The body changed, so validators would 304 the *un-injected* copy from cache.
  delete out.etag;
  delete out['last-modified'];
  delete out['content-encoding'];
  delete out['transfer-encoding'];
  // A CSP that only allows the dev server's own scripts would block the overlay.
  delete out['content-security-policy'];
  delete out['content-security-policy-report-only'];
  // Cookies scoped to the dev server's domain would never come back to uidit.
  if (out['set-cookie']) {
    out['set-cookie'] = out['set-cookie'].map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
  }
  return out;
}

/**
 * Forward a request to the dev server. HTML is buffered so uidit can inject the
 * inspection overlay; everything else streams through untouched. Written to be
 * stack-agnostic — no assumptions about the framework behind the target beyond
 * "it serves HTTP and returns HTML documents".
 */
async function proxyRequest(req, res, target) {
  const url = new URL(target.href);
  url.hostname = await resolveReachable(url);
  const client = url.protocol === 'https:' ? https : http;
  const upstream = client.request(
    url,
    {
      method: req.method,
      headers: { ...req.headers, host: target.host, 'accept-encoding': 'identity' },
    },
    (up) => {
      const status = up.statusCode ?? 502;
      const type = String(up.headers['content-type'] ?? '');

      // Keep redirects inside the proxy: a bare Location would navigate the preview
      // out to the dev server, taking the overlay with it.
      const headers = { ...up.headers };
      const location = headers.location;
      if (location) {
        try {
          headers.location = new URL(location, url).href.replace(url.origin, '/proxy');
        } catch { /* relative or malformed: leave it alone */ }
      }

      if (!type.includes('text/html')) {
        res.writeHead(status, headers);
        up.pipe(res);
        return;
      }

      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const html = injectIntoHtml(Buffer.concat(chunks).toString('utf8'), url.origin);
        const outHeaders = scrubHtmlHeaders({ ...headers, 'content-length': Buffer.byteLength(html) });
        res.writeHead(status, outHeaders);
        res.end(html);
      });
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) json(res, 502, { error: `upstream failed: ${err.message}` });
    else res.end();
  });
  req.pipe(upstream);
}

export function createServer({ cwd = process.cwd(), hub = createHub() } = {}) {
  const server = http.createServer(async (req, res) => {
    // A browser aborting a request (navigation, closed tab) must not take down the
    // dashboard — without this, one ECONNRESET crashes the whole process.
    req.on('error', () => res.destroy());
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    try {
      if (route === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const remove = hub.add(res);
        req.on('close', remove);
        return undefined;
      }

      // uidit's own files win over the proxy: Astro emits /_astro/*, and the overlay
      // lives at the root, so anything we ship locally must never be forwarded.
      const dashboardFile = route === '/' ? path.join(DASHBOARD_DIST, 'index.html') : path.join(DASHBOARD_DIST, route);
      if (route === '/' || fs.existsSync(dashboardFile)) {
        if (fs.existsSync(dashboardFile)) return serveStatic(res, dashboardFile);
        return serveStatic(res, path.join(PUBLIC_DIR, 'fallback.html'));
      }

      if (route === '/overlay.js') return serveStatic(res, path.join(PUBLIC_DIR, 'overlay.js'));

      if (route.startsWith('/api/')) {
        if (route === '/api/state') {
          return json(res, 200, { config: store.readConfig(cwd), session: store.readSession(cwd) });
        }
        if (route === '/api/session.json') {
          return json(res, 200, store.readSession(cwd));
        }
        if (route === '/api/discover') {
          return json(res, 200, { targets: await discoverTargets() });
        }
        if (route === '/api/config' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.targetUrl) safeTargetUrl(body.targetUrl);
          const config = store.writeConfig(cwd, body);
          hub.notifyConfig();
          hub.notify();
          return json(res, 200, { config });
        }
        if (route === '/api/element' && req.method === 'POST') {
          const body = await readBody(req);
          const record = store.upsertElement(cwd, body);
          hub.notify();
          return json(res, 200, { element: record, session: store.readSession(cwd) });
        }
        if (route === '/api/comment' && req.method === 'POST') {
          const record = store.addComment(cwd, await readBody(req));
          hub.notify();
          return json(res, 200, { comment: record, session: store.readSession(cwd) });
        }
        if (route === '/api/edit' && req.method === 'POST') {
          const record = store.addEdit(cwd, await readBody(req));
          hub.notify();
          return json(res, 200, { edit: record, session: store.readSession(cwd) });
        }

        const patch = route.match(/^\/api\/(comments|edits|elements)\/([^/]+)$/);
        if (patch && req.method === 'PATCH') {
          const record = store.updateRecord(cwd, patch[1], decodeURIComponent(patch[2]), await readBody(req));
          if (!record) return json(res, 404, { error: 'not found' });
          hub.notify();
          return json(res, 200, { record, session: store.readSession(cwd) });
        }
        if (patch && req.method === 'DELETE') {
          const ok = store.removeRecord(cwd, patch[1], decodeURIComponent(patch[2]));
          if (!ok) return json(res, 404, { error: 'not found' });
          hub.notify();
          return json(res, 200, { ok: true, session: store.readSession(cwd) });
        }
        return json(res, 404, { error: 'unknown api route' });
      }

      if (route.startsWith('/proxy/')) {
        const config = store.readConfig(cwd);
        if (!config?.targetUrl) return json(res, 409, { error: 'no target url set' });
        const target = safeTargetUrl(config.targetUrl);
        target.pathname = `${target.pathname.replace(/\/$/, '')}${route.slice('/proxy'.length)}`;
        target.search = url.search;
        return proxyRequest(req, res, target);
      }

      // The previewed page runs on uidit's origin, so its own root-absolute asset
      // URLs (/@vite/client, /src/main.tsx, /favicon.ico) would land here and 404.
      // Anything uidit does not own is forwarded to the target dev server.
      const config = store.readConfig(cwd);
      if (config?.targetUrl && !route.startsWith('/api/')) {
        const target = safeTargetUrl(config.targetUrl);
        target.pathname = `${target.pathname.replace(/\/$/, '')}${route}`;
        target.search = url.search;
        return proxyRequest(req, res, target);
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });

  // One listener per connection, not per request: keep-alive sockets would otherwise
  // accumulate error handlers until Node reports a listener leak.
  server.on('connection', (socket) => socket.on('error', () => {}));
  server.on('clientError', (_err, socket) => socket.destroy());
  return server;
}

export function startServer({ cwd = process.cwd(), port = 7717 } = {}) {
  const hub = createHub({ cwd });
  hub.watch();
  const server = createServer({ cwd, hub });

  // Hot reload runs over a websocket; without this the preview renders but never
  // refreshes when the user saves a file.
  server.on('upgrade', (req, socket, head) => {
    const config = store.readConfig(cwd);
    if (!config?.targetUrl) return socket.destroy();
    let target;
    try {
      target = safeTargetUrl(config.targetUrl);
    } catch {
      return socket.destroy();
    }
    const upstream = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (upHead?.length) socket.unshift(upHead);
      if (head?.length) upSocket.unshift(head);
      upSocket.pipe(socket).pipe(upSocket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, hub }));
  });
}