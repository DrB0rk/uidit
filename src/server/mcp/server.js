import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import * as store from '../store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const FLOATING_HTML = path.resolve(root, '../../../src/public/floating.html');
const DASHBOARD_DIST = path.resolve(root, '../../../dashboard/dist');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('request body exceeds 4 MiB'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function isLoopback(hostname) { return ['127.0.0.1', 'localhost', '::1'].includes(hostname.replace(/^\[|\]$/g, '')); }

function validLocalTarget(value) {
  if (value == null || value === '') return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname)) throw new Error('targetUrl must be an http(s) loopback URL');
  return url.href;
}

function safeConfig(cwd, previewPort) {
  return { ...store.readConfig(cwd), previewUrl: `http://127.0.0.1:${previewPort}` };
}

function serveControlStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://uidit.local').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(DASHBOARD_DIST, requested);
  if (!(file === path.join(DASHBOARD_DIST, 'index.html') || file.startsWith(`${DASHBOARD_DIST}${path.sep}`)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': path.basename(file) === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function tokenFor(cwd) {
  const dir = path.join(store.uiditDir(cwd), 'runtime');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'mcp-token');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(file, 0o600); } catch {}
  return fs.readFileSync(file, 'utf8').trim();
}

function makeMcp({ cwd, processManager, hub }) {
  const server = new McpServer({ name: 'uidit', version: '0.3.0' });
  const snapshot = () => ({ project: path.basename(path.resolve(cwd)), revision: store.readSession(cwd).revision, config: store.readConfig(cwd), session: store.readSession(cwd), selected: hub.selection, dev: processManager.status() });
  const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  const resource = (name, uri, description, get) => server.registerResource(name, uri, { description }, async () => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(get()) }] }));
  resource('context', 'uidit://project/context', 'Project identity, revision, selection, feedback counts, and dev state', snapshot);
  resource('session', 'uidit://session', 'Current shared feedback, visual drawing annotations (normalized page coordinates), and preview edits', () => store.readSession(cwd));
  resource('open-feedback', 'uidit://feedback/open', 'Unresolved review comments, including visual arrow and shape annotations', () => store.readSession(cwd).comments.filter((comment) => !comment.resolved));
  resource('selected-element', 'uidit://elements/selected', 'Most recently selected live element', () => hub.selection);
  resource('pending-edits', 'uidit://edits/pending', 'Preview edits not yet applied to source', () => store.readSession(cwd).edits.filter((edit) => !edit.applied));
  resource('dev-status', 'uidit://dev/status', 'Development process state and URL', () => processManager.status());
  resource('dev-logs', 'uidit://dev/logs', 'Recent redacted development logs', () => processManager.logs());
  server.registerTool('uidit_get_context', { description: 'Get UIDIT project, review revision, selected element, capabilities, and dev status', inputSchema: {} }, async () => result(snapshot()));
  server.registerTool('uidit_list_feedback', { description: 'List review comments and their visual drawing instructions. Drawing points are normalized page coordinates; arrows run from first point to last.', inputSchema: { resolved: z.boolean().optional(), page: z.string().max(2000).optional(), elementId: z.string().max(200).optional(), query: z.string().max(200).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() } }, async ({ resolved, page, elementId, query, offset = 0, limit = 50 }) => {
    const all = store.readSession(cwd).comments.filter((c) => resolved === undefined || Boolean(c.resolved) === resolved).filter((c) => !page || c.page === page).filter((c) => !elementId || c.elementId === elementId).filter((c) => !query || c.text.toLowerCase().includes(query.toLowerCase()));
    return result({ comments: all.slice(offset, offset + limit), offset, limit, total: all.length });
  });
  server.registerTool('uidit_add_comment', { description: 'Add page or element feedback to the shared review session', inputSchema: { text: z.string().min(1).max(4000), page: z.string().max(2000).optional(), elementId: z.string().max(200).nullable().optional() } }, async (args) => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentWrites) throw new Error('Agent writes are disabled in .uidit/config.json');
    const comment = store.addComment(cwd, { ...args, source: 'agent' }); hub.notify(); return result({ comment });
  });
  server.registerTool('uidit_update_comment', { description: 'Edit or resolve/reopen a comment using an expected session revision', inputSchema: { id: z.string(), text: z.string().max(4000).optional(), resolved: z.boolean().optional(), expectedRevision: z.number().int().nonnegative().optional() } }, async ({ id, expectedRevision, ...patch }) => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentWrites) throw new Error('Agent writes are disabled in .uidit/config.json');
    if (expectedRevision !== undefined && store.readSession(cwd).revision !== expectedRevision) throw new Error('session revision changed; refresh feedback and retry');
    const record = store.updateRecord(cwd, 'comments', id, { ...patch, source: 'agent' }); if (!record) throw new Error('comment not found'); hub.notify(); return result({ comment: record });
  });
  server.registerTool('uidit_list_elements', { description: 'List tagged elements, or inspect the current live selection', inputSchema: { selectedOnly: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() } }, async ({ selectedOnly, offset = 0, limit = 50 }) => {
    if (selectedOnly) return result({ selected: hub.selection });
    const elements = store.readSession(cwd).elements;
    return result({ elements: elements.slice(offset, offset + limit), offset, limit, total: elements.length });
  });
  server.registerTool('uidit_select_element', { description: 'Highlight a tagged element in the active review preview', inputSchema: { id: z.string().optional(), selector: z.string().max(1000).optional() } }, async ({ id, selector }) => {
    const session = store.readSession(cwd); const element = session.elements.find((item) => (id && item.id === id) || (selector && item.selector === selector));
    if (!element) throw new Error('element not found'); hub.notifySelection({ ...element, selectedAt: new Date().toISOString() }); return result({ selected: element });
  });
  server.registerTool('uidit_list_edits', { description: 'List recorded preview edits and source application status', inputSchema: {} }, async () => result({ edits: store.readSession(cwd).edits }));
  server.registerTool('uidit_mark_edit_applied', { description: 'Record that an edit was applied to source code', inputSchema: { id: z.string(), provenance: z.string().min(1).max(1000) } }, async ({ id, provenance }) => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentWrites) throw new Error('Agent writes are disabled in .uidit/config.json');
    const edit = store.updateRecord(cwd, 'edits', id, { applied: true, appliedAt: new Date().toISOString(), provenance, source: 'agent' });
    if (!edit) throw new Error('edit not found'); hub.notify(); return result({ edit });
  });
  server.registerTool('uidit_get_dev_status', { description: 'Get UIDIT managed development process status', inputSchema: {} }, async () => result(processManager.status()));
  server.registerTool('uidit_get_dev_logs', { description: 'Read recent redacted development process logs', inputSchema: { after: z.number().int().nonnegative().optional() } }, async ({ after = 0 }) => result({ logs: processManager.logs(after) }));
  server.registerTool('uidit_get_config', { description: 'Read project UIDIT settings without runtime credentials', inputSchema: {} }, async () => result(store.readConfig(cwd)));
  server.registerTool('uidit_set_config', { description: 'Update allowlisted non-secret UI preferences', inputSchema: { position: z.enum(['bottom-right', 'bottom-left']).optional() } }, async ({ position }) => {
    if (position) { const config = store.writeConfig(cwd, { ui: { position } }); hub.notifyConfig(); return result({ ui: config.ui }); }
    throw new Error('no supported setting provided');
  });
  server.registerTool('uidit_restart_dev', { description: 'Restart the UIDIT-owned dev process if explicitly permitted', inputSchema: {} }, async () => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentServerControl) throw new Error('Agent server control is disabled in .uidit/config.json');
    if (processManager.status().state === 'attached') throw new Error('UIDIT does not own the attached process');
    await processManager.stop(); const spec = store.readConfig(cwd)?.dev?.command;
    if (!Array.isArray(spec) || !spec.length) throw new Error('No configured command to restart');
    return result(await processManager.start({ command: spec[0], args: spec.slice(1), cwd: path.resolve(cwd, store.readConfig(cwd)?.dev?.cwd ?? '.') }));
  });
  server.registerTool('uidit_stop_dev', { description: 'Stop the UIDIT-owned dev process if explicitly permitted', inputSchema: {} }, async () => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentServerControl) throw new Error('Agent server control is disabled in .uidit/config.json');
    if (!processManager.status().owned) throw new Error('There is no UIDIT-owned process to stop'); return result(await processManager.stop());
  });
  return { server };
}

export async function startMcpServer({ cwd = process.cwd(), port = 7718, previewPort = 7717, processManager, hub }) {
  const token = tokenFor(cwd);
  const sessions = new Map();
  const unsubscribeHub = hub.subscribe?.((type) => {
    const urisByEvent = {
      session: ['uidit://session', 'uidit://feedback/open', 'uidit://edits/pending', 'uidit://project/context'],
      config: ['uidit://project/context'],
      dev: ['uidit://dev/status', 'uidit://dev/logs', 'uidit://project/context'],
      selection: ['uidit://elements/selected', 'uidit://project/context'],
    };
    const uris = urisByEvent[type] ?? [];
    for (const { server } of sessions.values()) for (const uri of uris) server.server.sendResourceUpdated({ uri }).catch(() => {});
  });
  const dispatchMcp = async (req, res) => {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (!store.readConfig(cwd)?.mcp?.enabled) { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      let pair = sessionId ? sessions.get(sessionId) : null;
      if (sessionId && !pair) { res.writeHead(404).end(); return; }
      if (!pair) {
        const { server } = makeMcp({ cwd, processManager, hub });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        pair = { server, transport };
        await server.connect(transport);
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); hub.notifyMcp?.({ clientCount: sessions.size }); };
      }
      await pair.transport.handleRequest(req, res, body);
      if (pair.transport.sessionId) sessions.set(pair.transport.sessionId, pair);
      hub.notifyMcp?.({ clientCount: sessions.size });
    } catch (error) { if (!res.headersSent) sendJson(res, 400, { error: error.message }); }
  };
  let actualPort = port;
  const httpServer = http.createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    let hostUrl;
    try { hostUrl = new URL(`http://${host}`); } catch { res.writeHead(400).end(); return; }
    if (!isLoopback(hostUrl.hostname) || Number(hostUrl.port) !== actualPort) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/mcp') return dispatchMcp(req, res);
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
    const isMutation = ['POST', 'PATCH', 'DELETE'].includes(req.method);
    if (isMutation) {
      const origin = req.headers.origin;
      try {
        const parsed = new URL(origin);
        if (!isLoopback(parsed.hostname) || Number(parsed.port) !== actualPort || parsed.protocol !== 'http:') throw new Error();
      } catch { return sendJson(res, 403, { error: 'same-origin control request required' }); }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(res, 415, { error: 'application/json required' });
    }
    try {
      const route = url.pathname;
      if (route === '/floating' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors http://127.0.0.1:${previewPort} http://localhost:${previewPort} http://127.0.0.1:${actualPort} http://localhost:${actualPort}`, 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(FLOATING_HTML).pipe(res);
      }
      if (route === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const remove = hub.add(res); req.on('close', remove); return;
      }
      if (route === '/api/state' && req.method === 'GET') return sendJson(res, 200, { config: safeConfig(cwd, previewPort), session: store.readSession(cwd) });
      if (route === '/api/session.json' && req.method === 'GET') return sendJson(res, 200, store.readSession(cwd));
      if (route === '/api/discover' && req.method === 'GET') {
        const { discoverTargets } = await import('../discover.js');
        return sendJson(res, 200, { targets: await discoverTargets({ excludePorts: [actualPort, previewPort] }) });
      }
      if (route === '/api/dev' && req.method === 'GET') return sendJson(res, 200, { ...processManager.status(), logs: processManager.logs() });
      if (route === '/api/mcp' && req.method === 'GET') return sendJson(res, 200, { url: `http://127.0.0.1:${actualPort}/mcp`, clientCount: sessions.size, enabled: store.readConfig(cwd)?.mcp?.enabled !== false, permissions: store.readConfig(cwd)?.mcp });
      if (route === '/api/selection' && req.method === 'POST') {
        const body = await readJson(req);
        const safe = { id: String(body.id ?? '').slice(0, 200), selector: String(body.selector ?? '').slice(0, 1000), page: String(body.page ?? '').slice(0, 2000), tag: String(body.tag ?? '').slice(0, 50), text: String(body.text ?? '').slice(0, 300), ancestors: Array.isArray(body.ancestors) ? body.ancestors.slice(0, 6).map((x) => String(x).slice(0, 200)) : [], attributes: {} };
        if (!safe.selector) return sendJson(res, 400, { error: 'selector is required' });
        hub.notifySelection({ ...safe, selectedAt: new Date().toISOString() }); return sendJson(res, 200, { selected: safe });
      }
      if (route === '/api/config' && req.method === 'POST') {
        const body = await readJson(req); const patch = {};
        if (Object.hasOwn(body, 'targetUrl')) patch.targetUrl = validLocalTarget(body.targetUrl);
        if (body.dev) {
          if (body.dev.command !== undefined && body.dev.command !== null && (!Array.isArray(body.dev.command) || !body.dev.command.length || body.dev.command.some((x) => typeof x !== 'string'))) throw new Error('dev.command must be an argv array');
          patch.dev = {};
          for (const key of ['command', 'cwd', 'url', 'autoStart', 'restartOnCrash']) if (Object.hasOwn(body.dev, key)) patch.dev[key] = body.dev[key];
          if (patch.dev.cwd !== undefined && typeof patch.dev.cwd !== 'string') throw new Error('dev.cwd must be a string');
          if (patch.dev.url !== undefined && patch.dev.url !== null) patch.dev.url = validLocalTarget(patch.dev.url);
          if (patch.dev.autoStart !== undefined && typeof patch.dev.autoStart !== 'boolean') throw new Error('dev.autoStart must be boolean');
          if (patch.dev.restartOnCrash !== undefined && typeof patch.dev.restartOnCrash !== 'boolean') throw new Error('dev.restartOnCrash must be boolean');
        }
        if (body.ui && typeof body.ui === 'object') {
          patch.ui = {};
          if (body.ui.position !== undefined) {
            if (!['bottom-right', 'bottom-left'].includes(body.ui.position)) throw new Error('ui.position must be bottom-right or bottom-left');
            patch.ui.position = body.ui.position;
          }
          for (const key of ['defaultOpen', 'inspectionDefault']) if (body.ui[key] !== undefined) {
            if (typeof body.ui[key] !== 'boolean') throw new Error(`ui.${key} must be boolean`);
            patch.ui[key] = body.ui[key];
          }
        }
        if (body.mcp && typeof body.mcp === 'object') {
          patch.mcp = {};
          for (const key of ['enabled', 'allowAgentWrites', 'allowAgentServerControl']) if (body.mcp[key] !== undefined) {
            if (typeof body.mcp[key] !== 'boolean') throw new Error(`mcp.${key} must be boolean`);
            patch.mcp[key] = body.mcp[key];
          }
        }
        const config = store.writeConfig(cwd, patch);
        if (patch.mcp?.enabled === false) {
          for (const { transport } of sessions.values()) transport.close();
          sessions.clear(); hub.notifyMcp?.({ clientCount: 0 });
        }
        hub.notifyConfig(); return sendJson(res, 200, { config: safeConfig(cwd, previewPort) });
      }
      if (route === '/api/dev/start' && req.method === 'POST') {
        const dev = store.readConfig(cwd)?.dev;
        if (!Array.isArray(dev?.command) || !dev.command.length) throw new Error('Configure a development command before starting');
        const status = await processManager.start({ command: dev.command[0], args: dev.command.slice(1), cwd: path.resolve(cwd, dev.cwd ?? '.') });
        if (status.url) { store.writeConfig(cwd, { targetUrl: status.url, dev: { url: status.url } }); hub.notifyConfig(); }
        return sendJson(res, 200, status);
      }
      if (route === '/api/dev/stop' && req.method === 'POST') return sendJson(res, 200, await processManager.stop());
      if (route === '/api/dev/restart' && req.method === 'POST') {
        if (processManager.status().owned) await processManager.stop();
        const dev = store.readConfig(cwd)?.dev;
        if (!Array.isArray(dev?.command) || !dev.command.length) throw new Error('Configure a development command before restarting');
        return sendJson(res, 200, await processManager.start({ command: dev.command[0], args: dev.command.slice(1), cwd: path.resolve(cwd, dev.cwd ?? '.') }));
      }
      if (route === '/api/element' && req.method === 'POST') { const record = store.upsertElement(cwd, await readJson(req)); hub.notify(); return sendJson(res, 200, { element: record, session: store.readSession(cwd) }); }
      if (route === '/api/comment' && req.method === 'POST') { const record = store.addComment(cwd, await readJson(req)); hub.notify(); return sendJson(res, 200, { comment: record, session: store.readSession(cwd) }); }
      if (route === '/api/edit' && req.method === 'POST') { const record = store.addEdit(cwd, await readJson(req)); hub.notify(); return sendJson(res, 200, { edit: record, session: store.readSession(cwd) }); }
      const match = route.match(/^\/api\/(comments|edits|elements)\/([^/]+)$/);
      if (match && req.method === 'PATCH') {
        const patch = await readJson(req); const collection = match[1];
        if (collection === 'comments' && (patch.text !== undefined || patch.resolved !== undefined)) {
          if (typeof patch.text === 'string' && (!patch.text.trim() || patch.text.length > 4000)) throw new Error('comment text must be 1–4000 characters');
          if (patch.resolved !== undefined && typeof patch.resolved !== 'boolean') throw new Error('resolved must be boolean');
        }
        if (collection === 'edits' && patch.applied === true && (!patch.provenance || typeof patch.provenance !== 'string')) throw new Error('source provenance is required to mark an edit applied');
        const record = store.updateRecord(cwd, collection, decodeURIComponent(match[2]), patch);
        if (!record) return sendJson(res, 404, { error: 'record not found' }); hub.notify(); return sendJson(res, 200, { record, session: store.readSession(cwd) });
      }
      if (match && req.method === 'DELETE') {
        if (match[1] === 'comments') return sendJson(res, 405, { error: 'comments are history and cannot be deleted' });
        if (!store.removeRecord(cwd, match[1], decodeURIComponent(match[2]))) return sendJson(res, 404, { error: 'record not found' });
        hub.notify(); return sendJson(res, 200, { ok: true, session: store.readSession(cwd) });
      }
      if (route.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown UIDIT route' });
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveControlStatic(req, res);
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  });
  const listen = (requestedPort) => new Promise((resolve, reject) => {
    const failed = (error) => {
      httpServer.removeListener('listening', ready);
      if (error.code === 'EADDRINUSE' && requestedPort !== 0) return listen(0).then(resolve, reject);
      reject(error);
    };
    const ready = () => { httpServer.removeListener('error', failed); resolve(httpServer.address().port); };
    httpServer.once('error', failed); httpServer.once('listening', ready); httpServer.listen(requestedPort, '127.0.0.1');
  });
  actualPort = await listen(port);
  const controlUrl = `http://127.0.0.1:${actualPort}`;
  return { server: httpServer, token, port: actualPort, url: `${controlUrl}/mcp`, controlUrl, clientCount: () => sessions.size,
    close: () => { unsubscribeHub?.(); for (const { transport } of sessions.values()) transport.close(); sessions.clear(); return new Promise((resolve) => httpServer.close(resolve)); } };
}

export function readMcpToken(cwd = process.cwd()) { return tokenFor(cwd); }

export async function runStdioBridge({ cwd = process.cwd() } = {}) {
  const config = store.readConfig(cwd);
  const url = `http://127.0.0.1:${config?.controlPort ?? 7718}/mcp`;
  const client = new Client({ name: 'uidit-stdio-bridge', version: '0.3.0' });
  const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${readMcpToken(cwd)}` } } });
  await client.connect(remote);
  const local = new McpServer({ name: 'uidit', version: '0.3.0' });
  local.server.registerCapabilities({ resources: { subscribe: true, listChanged: true }, tools: { listChanged: true } });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
    await local.server.sendResourceUpdated(notification.params);
  });
  local.server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  local.server.setRequestHandler(CallToolRequestSchema, async (request) => client.callTool(request.params));
  local.server.setRequestHandler(ListResourcesRequestSchema, async () => client.listResources());
  local.server.setRequestHandler(ReadResourceRequestSchema, async (request) => client.readResource(request.params));
  local.server.setRequestHandler(SubscribeRequestSchema, async (request) => client.subscribeResource(request.params.uri));
  local.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => client.unsubscribeResource(request.params.uri));
  const stdio = new StdioServerTransport();
  await local.connect(stdio);
  const close = async () => { await local.close().catch(() => {}); await client.close().catch(() => {}); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
