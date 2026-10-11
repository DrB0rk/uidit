import http from 'node:http';
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

function proxyRequest(req, res, target) {
  const url = new URL(target.href);
  const upstream = http.request(
    url,
    {
      method: req.method,
      headers: { ...req.headers, host: url.host, 'accept-encoding': 'identity' },
    },
    (up) => {
      const type = String(up.headers['content-type'] ?? '');
      if (!type.includes('text/html')) {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const html = injectIntoHtml(Buffer.concat(chunks).toString('utf8'), url.origin);
        const headers = { ...up.headers, 'content-length': Buffer.byteLength(html) };
        delete headers['content-encoding'];
        res.writeHead(up.statusCode ?? 200, headers);
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
  return http.createServer(async (req, res) => {
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

      if (route === '/' || route.startsWith('/assets/')) {
        const file = route === '/'
          ? path.join(DASHBOARD_DIST, 'index.html')
          : path.join(DASHBOARD_DIST, route);
        if (fs.existsSync(file)) return serveStatic(res, file);
        if (!fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'))) {
          return serveStatic(res, path.join(PUBLIC_DIR, 'fallback.html'), { injectOverlay: false });
        }
        return json(res, 404, { error: 'not found' });
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

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
}

export function startServer({ cwd = process.cwd(), port = 7717 } = {}) {
  const hub = createHub({ cwd });
  hub.watch();
  const server = createServer({ cwd, hub });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, hub }));
  });
}