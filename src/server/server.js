import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { runReviewAction } from '../actions/review.js';
import * as flowStore from './flow-store.js';
import * as taskStore from './tasks.js';
import { resolveElementSource } from './source-map.js';
import { projectContext } from './project-context.js';
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

/**
 * Extra loopback origins allowed to host the preview and receive its overlay
 * messages, from `ui.frameAncestors`. Non-loopback entries are dropped: the
 * bridge relays review writes, so it must never be reachable off-machine.
 */
function bridgeOrigins(cwd) {
  const configured = store.readConfig(cwd)?.ui?.frameAncestors;
  return (Array.isArray(configured) ? configured : [])
    .map((value) => { try { const url = new URL(String(value)); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? url.origin : null; } catch { return null; } })
    .filter(Boolean)
    .join(' ');
}

export function injectIntoHtml(html, targetOrigin = '', controlOrigin = 'http://127.0.0.1:7718', bridgeOrigins = '') {
  const attr = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  // data-bridge tells the overlay which further origins may host it, so a review
  // workspace served from another local port can still receive its messages.
  // Without it the overlay only trusts a parent on the control port.
  const bridge = bridgeOrigins ? ` data-bridge="${attr(bridgeOrigins)}"` : '';
  const tag = `<link rel="stylesheet" href="/overlay.css" data-uidit="1"><script src="/overlay.js" data-uidit="1" data-target="${attr(targetOrigin)}" data-control="${attr(controlOrigin)}"${bridge}></script>`;
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
  // Cookies scoped to the dev server's domain would never come back to uidit.
  if (out['set-cookie']) {
    out['set-cookie'] = out['set-cookie'].map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
  }
  return out;
}

function extendPreviewCsp(headers, controlOrigin) {
  const out = { ...headers };
  if (!out['content-security-policy']) return out;
  out['content-security-policy'] = out['content-security-policy'].split(',').map((policy) => {
    const directives = policy.split(';').map((part) => part.trim()).filter(Boolean);
    const index = (name) => directives.findIndex((d) => d.split(/\s+/, 1)[0].toLowerCase() === name);
    let scripts = index('script-src');
    if (scripts < 0 && index('default-src') >= 0) directives.push(`script-src 'self' ${controlOrigin}`);
    else if (scripts >= 0) {
      if (!/(^|\s)'self'(?:\s|$)/i.test(directives[scripts])) directives[scripts] += " 'self'";
      if (!directives[scripts].split(/\s+/).includes(controlOrigin)) directives[scripts] += ` ${controlOrigin}`;
    }
    let styles = index('style-src');
    if (styles < 0 && index('default-src') >= 0) directives.push("style-src 'self'");
    else if (styles >= 0 && !/(^|\s)'self'(?:\s|$)/i.test(directives[styles])) directives[styles] += " 'self'";
    // UIDIT renders positioned selection/comment/drawing previews with DOM styles.
    // Allow inline styles in the proxied review surface while keeping script policy intact.
    for (const name of ['style-src', 'style-src-elem', 'style-src-attr']) {
      let at = index(name);
      if (at < 0) { directives.push(`${name} 'unsafe-inline'`); at = directives.length - 1; }
      else if (!/(^|\s)'unsafe-inline'(?:\s|$)/i.test(directives[at])) directives[at] += " 'unsafe-inline'";
    }
    const frames = index('frame-src');
    if (frames < 0) directives.push(`frame-src 'self' ${controlOrigin}`);
    else {
      const sources = directives[frames].split(/\s+/);
      if (sources.includes("'none'")) directives[frames] = `frame-src 'self' ${controlOrigin}`;
      else if (!sources.includes("'self'")) directives[frames] += " 'self'";
      else if (!sources.includes(controlOrigin)) directives[frames] += ` ${controlOrigin}`;
    }
    if (frames >= 0 && !directives[frames].includes(controlOrigin)) directives[frames] += ` ${controlOrigin}`;
    return directives.join('; ');
  }).join(', ');
  return out;
}

/**
 * Forward a request to the dev server. HTML is buffered so uidit can inject the
 * inspection overlay; everything else streams through untouched. Written to be
 * stack-agnostic — no assumptions about the framework behind the target beyond
 * "it serves HTTP and returns HTML documents".
 */
async function proxyRequest(req, res, target, controlOrigin, cwd = process.cwd()) {
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
        const html = injectIntoHtml(Buffer.concat(chunks).toString('utf8'), url.origin, controlOrigin, bridgeOrigins(cwd));
        const outHeaders = scrubHtmlHeaders(extendPreviewCsp(headers, controlOrigin));
        outHeaders['content-length'] = Buffer.byteLength(html);
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

export function createServer({ cwd = process.cwd(), hub = createHub(), port = 7717, controlPort = 7718, previewOnly = false, collaborationManager = null } = {}) {
  const controlOrigin = () => `http://127.0.0.1:${store.readConfig(cwd)?.controlPort ?? controlPort}`;
  const server = http.createServer(async (req, res) => {
    // A browser aborting a request (navigation, closed tab) must not take down the
    // dashboard — without this, one ECONNRESET crashes the whole process.
    req.on('error', () => res.destroy());
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    try {
      if (!previewOnly && route === '/api/stream') {
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
      const dashboardFile = route === '/' ? path.join(DASHBOARD_DIST, 'index.html') : path.resolve(DASHBOARD_DIST, `.${decodeURIComponent(route)}`);
      if (!previewOnly && (route === '/' || (dashboardFile.startsWith(`${DASHBOARD_DIST}${path.sep}`) && fs.existsSync(dashboardFile)))) {
        if (fs.existsSync(dashboardFile)) return serveStatic(res, dashboardFile);
        return serveStatic(res, path.join(PUBLIC_DIR, 'fallback.html'));
      }

      if (route === '/overlay.js') return serveStatic(res, path.join(PUBLIC_DIR, 'overlay.js'));
      if (route === '/overlay.css') return serveStatic(res, path.join(PUBLIC_DIR, 'overlay.css'));

      // uidit owns a fixed set of API routes. Anything else under /api/ belongs to
      // the previewed app — real apps use /api/* too, so claiming the whole namespace
      // would break their data loading.
      const UIDIT_API = /^\/api\/(state|stream|discover|session\.json|config|elements?|comments?|edits?|collaboration|flows|tasks|proposals|browser|git|project)(?:\/|$)/;
      if (!previewOnly && UIDIT_API.test(route)) {
        if (route === '/api/state') {
          const config = store.readConfig(cwd);
          return json(res, 200, { config, session: store.readSession(cwd), collaboration: collaborationManager?.status() ?? { enabled: false }, browserContext: config?.ui?.allowBrowserInspection ? hub.browserContext : null, browserDiagnostics: config?.ui?.allowBrowserInspection ? hub.browserDiagnostics : [] });
        }
        if (route === '/api/browser/context' && req.method === 'POST') {
          const body = await readBody(req); const target = store.readConfig(cwd)?.targetUrl;
          if (!store.readConfig(cwd)?.ui?.allowBrowserInspection) return json(res, 403, { error: 'Live browser inspection is disabled in Settings' });
          if (!body || typeof body.url !== 'string' || !target || new URL(body.url).origin !== new URL(target).origin) return json(res, 403, { error: 'Browser context did not match the configured local preview' });
          const context = { url: body.url.slice(0, 2000), title: String(body.title ?? '').slice(0, 200), viewport: { width: Math.max(1, Math.min(10000, Number(body.viewport?.width) || 1)), height: Math.max(1, Math.min(10000, Number(body.viewport?.height) || 1)), dpr: Math.max(.5, Math.min(5, Number(body.viewport?.dpr) || 1)) }, readyState: ['loading','interactive','complete'].includes(body.readyState) ? body.readyState : 'unknown', nodes: Array.isArray(body.nodes) ? body.nodes.slice(0, 300).map((node) => ({ selector: String(node.selector ?? '').slice(0, 1000), tag: String(node.tag ?? '').slice(0, 30), role: typeof node.role === 'string' ? node.role.slice(0, 80) : null, name: String(node.name ?? '').slice(0, 240), text: String(node.text ?? '').slice(0, 300), alt: typeof node.alt === 'string' ? node.alt.slice(0, 500) : null, bounds: node.bounds && [node.bounds.x,node.bounds.y,node.bounds.width,node.bounds.height].every(Number.isFinite) ? Object.fromEntries(['x','y','width','height'].map((key) => [key, Math.max(-10000, Math.min(10000, node.bounds[key]))])) : null, styles: node.styles && typeof node.styles === 'object' ? Object.fromEntries(Object.entries(node.styles).filter(([key,value]) => ['display','position','color','backgroundColor','fontSize','fontWeight','lineHeight','padding','margin','gap','overflow'].includes(key) && typeof value === 'string').slice(0,24).map(([key,value]) => [key,value.slice(0,120)])) : {} })) : [], at: new Date().toISOString() };
          hub.notifyBrowserContext(context); return json(res, 200, { ok: true });
        }
        if (route === '/api/browser/diagnostics' && req.method === 'POST') {
          if (!store.readConfig(cwd)?.ui?.allowBrowserInspection) return json(res, 403, { error: 'Live browser inspection is disabled in Settings' });
          const body = await readBody(req); const entries = (Array.isArray(body.entries) ? body.entries : []).slice(0, 30).map((item) => ({ kind: ['console','network','page','hmr'].includes(item.kind) ? item.kind : 'page', message: String(item.message ?? '').slice(0, 1000).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/([?&](?:token|key|secret|password)=)[^&\s]*/gi, '$1[redacted]'), url: typeof item.url === 'string' ? item.url.slice(0, 2000) : null, at: new Date().toISOString() }));
          hub.notifyBrowserDiagnostics(entries); return json(res, 200, { ok: true });
        }
        if (route === '/api/browser/action-result' && req.method === 'POST') {
          if (!store.readConfig(cwd)?.ui?.allowBrowserInspection) return json(res, 403, { error: 'Live browser inspection is disabled in Settings' });
          const body = await readBody(req); let result = body.result;
          if (result?.screenshot && typeof result.screenshot === 'string') {
            const match = result.screenshot.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
            if (!match || match[1].length > 3_400_000) throw new Error('invalid or oversized browser screenshot');
            const bytes = Buffer.from(match[1], 'base64'); if (bytes.length > 2_500_000) throw new Error('browser screenshot exceeds 2.5 MiB');
            const directory = path.join(store.uiditDir(cwd), 'artifacts'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const filename = `browser-${crypto.randomUUID()}.jpg`; fs.writeFileSync(path.join(directory, filename), bytes, { mode: 0o600 }); result = { artifact: `.uidit/artifacts/${filename}`, mimeType: 'image/jpeg', bytes: bytes.length };
          }
          hub.resolveBrowserAction(String(body.id ?? ''), { ok: body.ok === true, error: String(body.error ?? '').slice(0, 500), result }); return json(res, 200, { ok: true });
        }
        if (route === '/api/collaboration' && req.method === 'GET') return json(res, 200, collaborationManager?.status() ?? { enabled: false });
        if (route === '/api/collaboration/room' && req.method === 'POST') {
          if (!collaborationManager) throw new Error('Collaboration relay is unavailable');
          const body = await readBody(req);
          const collaboration = await collaborationManager.createRoom({ relayUrl: body.relayUrl, adminSecret: body.adminSecret, project: path.basename(path.resolve(cwd)) });
          return json(res, 201, { collaboration });
        }
        if (route === '/api/flows' && req.method === 'POST') {
          const flow = flowStore.createFlow(cwd, await readBody(req)); hub.notify(); return json(res, 201, { flow, session: store.readSession(cwd) });
        }
        const screenshot = route.match(/^\/api\/flows\/([a-f0-9-]{36})\/steps\/([a-f0-9-]{36})\/screenshot$/i);
        if (screenshot && req.method === 'GET') {
          const asset = flowStore.readFlowScreenshot(cwd, screenshot[1], screenshot[2]);
          if (!asset) return json(res, 404, { error: 'screenshot not found' });
          res.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
          fs.createReadStream(asset.file).pipe(res); return;
        }
        const flowStep = route.match(/^\/api\/flows\/([a-f0-9-]{36})\/(steps|logs)$/i);
        if (flowStep && req.method === 'POST') {
          const body = await readBody(req);
          const result = flowStep[2] === 'steps' ? flowStore.addFlowStep(cwd, flowStep[1], body) : flowStore.addFlowLog(cwd, flowStep[1], body);
          hub.notify(); return json(res, 201, { ...result, session: store.readSession(cwd) });
        }
        const flowMatch = route.match(/^\/api\/flows\/([a-f0-9-]{36})$/i);
        if (flowMatch && req.method === 'PATCH') {
          const flow = flowStore.updateFlow(cwd, flowMatch[1], await readBody(req));
          if (!flow) return json(res, 404, { error: 'flow not found' });
          hub.notify(); return json(res, 200, { flow, session: store.readSession(cwd) });
        }
        if (route === '/api/session.json') {
          return json(res, 200, store.readSession(cwd));
        }
        if (route === '/api/discover') {
          // Exclude our own port so uidit never offers itself as a review target.
          return json(res, 200, { targets: await discoverTargets({ excludePorts: [port] }) });
        }
        if (route === '/api/config' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.targetUrl) safeTargetUrl(body.targetUrl);
          if (body.ui && typeof body.ui === 'object') {
            for (const key of ['allowBrowserInspection', 'defaultOpen', 'inspectionDefault']) if (body.ui[key] !== undefined && typeof body.ui[key] !== 'boolean') throw new Error(`ui.${key} must be boolean`);
          }
          if (body.mcp && typeof body.mcp === 'object') for (const key of ['enabled','allowAgentWrites','allowAgentServerControl','allowBrowserControl']) if (body.mcp[key] !== undefined && typeof body.mcp[key] !== 'boolean') throw new Error(`mcp.${key} must be boolean`);
          const config = store.writeConfig(cwd, body);
          hub.notifyConfig();
          hub.notify();
          return json(res, 200, { config });
        }
        if (route === '/api/element' && req.method === 'POST') {
          const result = runReviewAction('tag-element', cwd, await readBody(req));
          hub.notify();
          return json(res, 200, { ...result, session: store.readSession(cwd) });
        }
        if (route === '/api/comment' && req.method === 'POST') {
          const result = runReviewAction('add-comment', cwd, await readBody(req));
          hub.notify();
          return json(res, 200, { ...result, session: store.readSession(cwd) });
        }
        const reply = route.match(/^\/api\/comments\/([^/]+)\/replies$/);
        if (reply && req.method === 'POST') {
          const body = await readBody(req);
          const result = runReviewAction('reply-comment', cwd, { commentId: decodeURIComponent(reply[1]), text: body.text });
          if (!result) return json(res, 404, { error: 'comment not found' });
          hub.notify();
          return json(res, 200, { ...result, session: store.readSession(cwd) });
        }
        if (route === '/api/edit' && req.method === 'POST') {
          const result = runReviewAction('add-edit', cwd, await readBody(req));
          hub.notify();
          return json(res, 200, { ...result, session: store.readSession(cwd) });
        }

        const patch = route.match(/^\/api\/(comments|edits|elements)\/([^/]+)$/);
        if (patch && req.method === 'PATCH') {
          const body = await readBody(req);
          if (patch[1] === 'comments' && body.status !== undefined && !['open', 'in_progress', 'needs_info'].includes(body.status)) throw new Error('status must be open, in_progress, or needs_info');
          if (patch[1] === 'comments' && body.assignee !== undefined && body.assignee !== null && (typeof body.assignee !== 'string' || body.assignee.length > 80)) throw new Error('assignee must be a participant name or null');
          if (patch[1] === 'comments' && body.codeRefs !== undefined) {
            if (!Array.isArray(body.codeRefs) || body.codeRefs.length > 50) throw new Error('codeRefs must contain at most 50 project-relative references');
            body.codeRefs = body.codeRefs.map(store.normalizeCodeReference);
          }
          const result = runReviewAction('update-record', cwd, { collection: patch[1], id: decodeURIComponent(patch[2]), patch: body });
          if (!result) return json(res, 404, { error: 'not found' });
          hub.notify();
          return json(res, 200, { ...result, session: store.readSession(cwd) });
        }
        if (patch && req.method === 'DELETE') {
          const ok = store.removeRecord(cwd, patch[1], decodeURIComponent(patch[2]));
          if (!ok) return json(res, 404, { error: 'not found' });
          hub.notify();
          return json(res, 200, { ok: true, session: store.readSession(cwd) });
        }
        const handledBelow = route === '/api/project/context' || route === '/api/tasks' || route.startsWith('/api/tasks/') || route.startsWith('/api/artifacts/');
        if (!handledBelow) return json(res, 404, { error: 'unknown uidit api route' });
      }
      if (route === '/api/project/context' && req.method === 'GET') return json(res, 200, projectContext(cwd));
      if (route === '/api/tasks' && req.method === 'GET') { const session = store.readSession(cwd); return json(res, 200, { tasks: session.tasks, evidence: session.evidence }); }
      if (route === '/api/tasks' && req.method === 'POST') { const record = taskStore.createTask(cwd, await readBody(req)); hub.notify(); return json(res, 201, { task: record, session: store.readSession(cwd) }); }
      const browserArtifact = route.match(/^\/api\/artifacts\/(browser-[0-9a-f-]{36}\.jpg)$/i);
      if (browserArtifact && req.method === 'GET') {
        const file = path.join(store.uiditDir(cwd), 'artifacts', browserArtifact[1]);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'artifact not found' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); fs.createReadStream(file).pipe(res); return;
      }
      const taskCapture = route.match(/^\/api\/tasks\/([^/]+)\/captures\/(baseline|candidate)$/);
      if (taskCapture && req.method === 'POST') {
        if (!store.readConfig(cwd)?.ui?.allowBrowserInspection) return json(res, 403, { error: 'Enable live browser inspection before capturing task evidence' });
        const task = store.readSession(cwd).tasks.find((item) => item.id === decodeURIComponent(taskCapture[1]));
        if (!task) return json(res, 404, { error: 'task not found' });
        const captured = await hub.requestBrowserAction({ type: 'screenshot' }, 20000);
        const evidence = taskStore.addEvidence(cwd, task.id, { type: 'visual-diff', result: 'review_required', summary: `${taskCapture[2]} screenshot captured for reviewer comparison`, reference: captured.result?.artifact ?? null, metadata: { capture: taskCapture[2], viewport: hub.browserContext?.viewport ?? null, url: hub.browserContext?.url ?? null, git: projectContext(cwd).git } }, { actor: 'reviewer' });
        hub.notify(); return json(res, 201, { evidence, session: store.readSession(cwd) });
      }
      const taskEvidence = route.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
      if (taskEvidence && req.method === 'POST') { const record = taskStore.addEvidence(cwd, decodeURIComponent(taskEvidence[1]), await readBody(req), { actor: 'reviewer' }); if (!record) return json(res, 404, { error: 'task not found' }); hub.notify(); return json(res, 201, { evidence: record, session: store.readSession(cwd) }); }
      const taskRoute = route.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskRoute && req.method === 'PATCH') { const body = await readBody(req); const { expectedRevision, ...patch } = body; const record = taskStore.updateTask(cwd, decodeURIComponent(taskRoute[1]), patch, { expectedRevision, actor: 'reviewer', reviewer: true }); if (!record) return json(res, 404, { error: 'task not found' }); hub.notify(); return json(res, 200, { task: record, session: store.readSession(cwd) }); }
      if (route === '/api/proposals' && req.method === 'GET') return json(res, 200, { proposals: store.readSession(cwd).proposals });
      if (route === '/api/proposals' && req.method === 'POST') { const record = taskStore.createProposal(cwd, await readBody(req), { actor: 'reviewer' }); hub.notify(); return json(res, 201, { proposal: record, session: store.readSession(cwd) }); }
      const proposalRoute = route.match(/^\/api\/proposals\/([^/]+)$/);
      if (proposalRoute && req.method === 'PATCH') { const body = await readBody(req); const record = taskStore.updateProposal(cwd, decodeURIComponent(proposalRoute[1]), body.status, { actor: 'reviewer' }); if (!record) return json(res, 404, { error: 'proposal not found' }); hub.notify(); return json(res, 200, { proposal: record, session: store.readSession(cwd) }); }
      const reattach = route.match(/^\/api\/comments\/([^/]+)\/reattach$/);
      if (reattach && req.method === 'POST') { const body = await readBody(req); const record = store.reattachComment(cwd, decodeURIComponent(reattach[1]), body.elementId); if (!record) return json(res, 404, { error: 'comment or element not found' }); hub.notify(); return json(res, 200, { comment: record, session: store.readSession(cwd) }); }
      const sourceMatch = route.match(/^\/api\/elements\/([^/]+)\/source$/);
      if (sourceMatch && req.method === 'GET') { const element = store.readSession(cwd).elements.find((item) => item.id === decodeURIComponent(sourceMatch[1])); if (!element) return json(res, 404, { error: 'element not found' }); return json(res, 200, await resolveElementSource(cwd, element)); }

      if (route.startsWith('/proxy/')) {
        const config = store.readConfig(cwd);
        if (!config?.targetUrl) return json(res, 409, { error: 'no target url set' });
        const target = safeTargetUrl(config.targetUrl);
        target.pathname = `${target.pathname.replace(/\/$/, '')}${route.slice('/proxy'.length)}`;
        // uidit's own reload cache-buster is not part of the target's URL space.
        url.searchParams.delete('r');
        target.search = url.search;
        return proxyRequest(req, res, target, controlOrigin(), cwd);
      }

      // The previewed page runs on uidit's origin, so its own URLs — root-absolute
      // assets like /@vite/client, and its own /api/* calls — would land on uidit and
      // fail. Anything uidit does not own is forwarded to the target dev server.
      const config = store.readConfig(cwd);
      if (config?.targetUrl) {
        const target = safeTargetUrl(config.targetUrl);
        target.pathname = `${target.pathname.replace(/\/$/, '')}${route}`;
        target.search = url.search;
        return proxyRequest(req, res, target, controlOrigin(), cwd);
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

export function startServer({ cwd = process.cwd(), port = 7717, controlPort = store.readConfig(cwd)?.controlPort ?? 7718, previewOnly = false, hub: suppliedHub, collaborationManager = null } = {}) {
  const hub = suppliedHub ?? createHub({ cwd });
  hub.watch();
  const server = createServer({ cwd, hub, port, controlPort, previewOnly, collaborationManager });

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
    (async () => {
      const upstreamHost = await resolveReachable(target);
      const client = target.protocol === 'https:' ? https : http;
      const upstream = client.request({
        host: upstreamHost,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: target.host },
        rejectUnauthorized: false,
      });
      upstream.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`);
        socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}\r\n${lines.join('\r\n')}\r\n\r\n`);
        // These bytes have already passed each side's HTTP upgrade parser. They
        // must be written to the opposite socket, never unshifted back into the
        // same socket's readable WebSocket parser.
        if (upHead?.length) socket.write(upHead);
        if (head?.length) upSocket.write(head);
        socket.pipe(upSocket);
        upSocket.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      upstream.end();
    })().catch(() => socket.destroy());
  });

  const listen = (requestedPort) => new Promise((resolve, reject) => {
    const failed = (error) => {
      server.removeListener('listening', ready);
      if (error.code === 'EADDRINUSE' && requestedPort !== 0) return listen(0).then(resolve, reject);
      reject(error);
    };
    const ready = () => { server.removeListener('error', failed); resolve(server.address().port); };
    server.once('error', failed); server.once('listening', ready); server.listen(requestedPort, '127.0.0.1');
  });
  return listen(port).then((actualPort) => ({ server, hub, port: actualPort, url: `http://127.0.0.1:${actualPort}` }));
}
