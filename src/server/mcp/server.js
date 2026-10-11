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
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as store from '../store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const FLOATING_HTML = path.resolve(root, '../../../src/public/floating.html');

function tokenFor(cwd) {
  const dir = path.join(store.uiditDir(cwd), 'runtime');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'mcp-token');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(file, 0o600); } catch {}
  return fs.readFileSync(file, 'utf8').trim();
}

function makeMcp({ cwd, processManager, hub, token }) {
  const server = new McpServer({ name: 'uidit', version: '0.2.0' });
  const snapshot = () => ({ config: store.readConfig(cwd), session: store.readSession(cwd), dev: processManager.status() });
  const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  server.registerResource('context', 'uidit://project/context', { description: 'Current UIDIT project and review state' }, async () => ({ contents: [{ uri: 'uidit://project/context', mimeType: 'application/json', text: JSON.stringify(snapshot()) }] }));
  server.registerResource('session', 'uidit://session', { description: 'Current feedback session' }, async () => ({ contents: [{ uri: 'uidit://session', mimeType: 'application/json', text: JSON.stringify(store.readSession(cwd)) }] }));
  server.registerTool('uidit_get_context', { description: 'Get UIDIT project, review and dev server status', inputSchema: {} }, async () => result(snapshot()));
  server.registerTool('uidit_list_feedback', { description: 'List review comments', inputSchema: { resolved: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() } }, async ({ resolved, limit = 50 }) => {
    const comments = store.readSession(cwd).comments.filter((c) => resolved === undefined || Boolean(c.resolved) === resolved).slice(-limit);
    return result({ comments });
  });
  server.registerTool('uidit_add_comment', { description: 'Add page or element feedback to the shared review session', inputSchema: { text: z.string().min(1).max(4000), page: z.string().max(2000).optional(), elementId: z.string().max(200).nullable().optional() } }, async (args) => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentWrites) throw new Error('Agent writes are disabled in .uidit/config.json');
    const comment = store.addComment(cwd, { ...args, source: 'agent' }); hub.notify(); return result({ comment });
  });
  server.registerTool('uidit_update_comment', { description: 'Update a comment or resolve/reopen it', inputSchema: { id: z.string(), text: z.string().max(4000).optional(), resolved: z.boolean().optional() } }, async ({ id, ...patch }) => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentWrites) throw new Error('Agent writes are disabled in .uidit/config.json');
    const record = store.updateRecord(cwd, 'comments', id, { ...patch, source: 'agent' }); if (!record) throw new Error('comment not found'); hub.notify(); return result({ comment: record });
  });
  server.registerTool('uidit_list_edits', { description: 'List recorded preview edits and source application status', inputSchema: {} }, async () => result({ edits: store.readSession(cwd).edits }));
  server.registerTool('uidit_mark_edit_applied', { description: 'Record that an edit was applied to source code', inputSchema: { id: z.string(), provenance: z.string().min(1).max(1000) } }, async ({ id, provenance }) => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentWrites) throw new Error('Agent writes are disabled in .uidit/config.json');
    const edit = store.updateRecord(cwd, 'edits', id, { applied: true, appliedAt: new Date().toISOString(), provenance, source: 'agent' });
    if (!edit) throw new Error('edit not found'); hub.notify(); return result({ edit });
  });
  server.registerTool('uidit_get_dev_status', { description: 'Get UIDIT managed development process status', inputSchema: {} }, async () => result(processManager.status()));
  server.registerTool('uidit_get_dev_logs', { description: 'Read recent redacted development process logs', inputSchema: { after: z.number().int().nonnegative().optional() } }, async ({ after = 0 }) => result({ logs: processManager.logs(after) }));
  server.registerTool('uidit_restart_dev', { description: 'Restart the UIDIT-owned development process when explicitly enabled', inputSchema: {} }, async () => {
    if (!store.readConfig(cwd)?.mcp?.allowAgentServerControl) throw new Error('Agent server control is disabled in .uidit/config.json');
    await processManager.stop(); const spec = store.readConfig(cwd)?.dev?.command;
    if (!Array.isArray(spec) || !spec.length) throw new Error('No configured command to restart');
    return result(await processManager.start({ command: spec[0], args: spec.slice(1), cwd: path.resolve(cwd, store.readConfig(cwd)?.dev?.cwd ?? '.') }));
  });
  return { server, token };
}

export async function startMcpServer({ cwd = process.cwd(), port = 7718, dashboardPort = 7717, processManager, hub }) {
  const token = tokenFor(cwd);
  const sessions = new Map();
  const unsubscribeHub = hub.subscribe?.((type) => {
    if (type !== 'session' && type !== 'config') return;
    const uris = type === 'session' ? ['uidit://session', 'uidit://project/context'] : ['uidit://project/context'];
    for (const { server } of sessions.values()) for (const uri of uris) server.server.sendResourceUpdated({ uri }).catch(() => {});
  });
  const httpServer = http.createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) { res.writeHead(403).end(); return; }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
    if (req.url === '/floating') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors http://127.0.0.1:${dashboardPort} http://localhost:${dashboardPort} http://[::1]:${dashboardPort}` });
      fs.createReadStream(FLOATING_HTML).pipe(res); return;
    }
    if (req.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method)) { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
    try {
      const body = req.method === 'POST' ? await new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) reject(new Error('request too large')); else chunks.push(c); });
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } }); req.on('error', reject);
      }) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      let pair = sessionId ? sessions.get(sessionId) : null;
      if (sessionId && !pair) { res.writeHead(404).end(); return; }
      if (!pair) {
        const { server } = makeMcp({ cwd, processManager, hub, token });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        pair = { server, transport };
        await server.connect(transport);
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      }
      await pair.transport.handleRequest(req, res, body);
      if (pair.transport.sessionId) sessions.set(pair.transport.sessionId, pair);
    } catch (error) { if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); } }
  });
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', resolve); });
  return { server: httpServer, token, url: `http://127.0.0.1:${port}/mcp`, close: () => { unsubscribeHub?.(); for (const { transport } of sessions.values()) transport.close(); sessions.clear(); return new Promise((resolve) => httpServer.close(resolve)); } };
}

export function readMcpToken(cwd = process.cwd()) { return tokenFor(cwd); }

export async function runStdioBridge({ cwd = process.cwd() } = {}) {
  const config = store.readConfig(cwd);
  const url = `http://127.0.0.1:${config?.controlPort ?? 7718}/mcp`;
  const client = new Client({ name: 'uidit-stdio-bridge', version: '0.2.0' });
  const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${readMcpToken(cwd)}` } } });
  await client.connect(remote);
  const local = new McpServer({ name: 'uidit', version: '0.2.0' });
  local.server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  local.server.setRequestHandler(CallToolRequestSchema, async (request) => client.callTool(request.params));
  local.server.setRequestHandler(ListResourcesRequestSchema, async () => client.listResources());
  local.server.setRequestHandler(ReadResourceRequestSchema, async (request) => client.readResource(request.params));
  const stdio = new StdioServerTransport();
  await local.connect(stdio);
  const close = async () => { await local.close().catch(() => {}); await client.close().catch(() => {}); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
