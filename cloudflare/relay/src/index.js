import { DurableObject } from 'cloudflare:workers';
import roomPage from '../public/index.html';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const secureEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
};
const validSession = (session) => session && typeof session === 'object' && Array.isArray(session.comments) && Array.isArray(session.elements) && Array.isArray(session.edits) && JSON.stringify(session).length <= 8_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (!env.ADMIN_SECRET || !secureEqual(request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''), env.ADMIN_SECRET)) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
      if (typeof body.project !== 'string' || !body.project.trim() || body.project.length > 120) return json({ error: 'project name is required' }, 400);
      const roomId = crypto.randomUUID();
      const stub = env.ROOMS.getByName(roomId);
      const created = await stub.fetch('https://room.internal/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, project: body.project.trim() }) });
      if (!created.ok) return json({ error: 'could not create room' }, 500);
      const credentials = await created.json();
      return json({ ...credentials, relayUrl: url.origin, inviteUrl: `${url.origin}/room/${roomId}#${credentials.inviteToken}` }, 201);
    }
    const join = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)\/join$/i);
    if (request.method === 'POST' && join) {
      const stub = env.ROOMS.getByName(join[1]);
      return stub.fetch(new Request('https://room.internal/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text() }));
    }
    const socket = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)\/socket$/i);
    if (request.method === 'GET' && socket) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      return env.ROOMS.getByName(socket[1]).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return new Response(roomPage, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  },
};

export class CollaborationRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async readState() {
    const row = this.ctx.storage.sql.exec('SELECT value FROM state WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  saveState(state) {
    this.ctx.storage.sql.exec('INSERT INTO state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(state));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create' && request.method === 'POST') {
      if (await this.readState()) return json({ error: 'room exists' }, 409);
      const { roomId, project } = await request.json();
      const ownerToken = randomToken(); const inviteToken = randomToken();
      const now = new Date().toISOString();
      const state = { roomId, project, createdAt: now, ownerHash: await digest(ownerToken), inviteHash: await digest(inviteToken), members: [], ownerRevision: -1, session: { version: 1, revision: 0, updatedAt: now, elements: [], comments: [], edits: [] }, activity: [] };
      this.saveState(state);
      return json({ roomId, ownerToken, inviteToken });
    }
    if (url.pathname === '/join' && request.method === 'POST') {
      const state = await this.readState(); if (!state) return json({ error: 'room not found' }, 404);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || typeof body.inviteToken !== 'string') return json({ error: 'name and invite token are required' }, 400);
      if (!secureEqual(await digest(body.inviteToken), state.inviteHash)) return json({ error: 'invalid or revoked invite link' }, 401);
      if (state.members.length >= 200) return json({ error: 'room member limit reached' }, 429);
      const memberToken = randomToken(); const memberId = crypto.randomUUID();
      state.members.push({ memberId, name: body.name.trim(), tokenHash: await digest(memberToken), createdAt: new Date().toISOString() });
      state.activity.unshift({ id: crypto.randomUUID(), type: 'joined', name: body.name.trim(), at: new Date().toISOString() });
      state.activity = state.activity.slice(0, 50); this.saveState(state);
      return json({ memberId, memberToken, project: state.project });
    }
    if (url.pathname.endsWith('/socket') && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      server.serializeAttachment({ authenticated: false });
      this.ctx.acceptWebSocket(server, ['room']);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 8_000_000) { socket.close(1009, 'Message too large'); return; }
    let body;
    try { body = JSON.parse(message); } catch { socket.close(1007, 'Invalid JSON'); return; }
    const state = await this.readState();
    if (!state) { socket.close(1008, 'Room unavailable'); return; }
    let member = socket.deserializeAttachment();
    if (!member?.authenticated) {
      if (body.type !== 'auth' || typeof body.token !== 'string') { socket.close(1008, 'Authentication required'); return; }
      const tokenHash = await digest(body.token);
      const role = secureEqual(tokenHash, state.ownerHash) ? 'owner' : 'member';
      const stored = role === 'member' ? state.members.find((item) => secureEqual(item.tokenHash, tokenHash)) : null;
      if (role === 'member' && !stored) { socket.close(1008, 'Invalid session'); return; }
      member = { authenticated: true, role, memberId: stored?.memberId ?? 'owner', name: stored?.name ?? 'Project owner' };
      socket.serializeAttachment(member);
      socket.send(JSON.stringify({ type: 'connected', room: this.publicState(state), self: { memberId: member.memberId, role: member.role, name: member.name } }));
      this.broadcastPresence(state);
      return;
    }
    if (body.type === 'cursor') {
      if (typeof body.x === 'number' && typeof body.y === 'number') this.broadcast({ type: 'cursor', memberId: member.memberId, name: member.name, x: Math.max(0, Math.min(1, body.x)), y: Math.max(0, Math.min(1, body.y)) }, socket);
      return;
    }
    if (member.role === 'owner' && body.type === 'sync') {
      if (!validSession(body.session)) return;
      const incoming = body.session;
      state.session = { ...incoming, comments: this.mergeComments(state.session.comments ?? [], incoming.comments), elements: incoming.elements, edits: incoming.edits };
      state.ownerRevision = Math.max(state.ownerRevision, Number(incoming.revision) || 0);
      this.saveState(state); this.broadcast({ type: 'snapshot', room: this.publicState(state) });
      return;
    }
    if (member.role === 'owner') return;
    const event = this.applyMemberAction(state, member, body);
    if (!event) return;
    this.saveState(state);
    this.broadcast({ type: 'command', event, memberId: member.memberId, name: member.name }, (ws) => ws.deserializeAttachment()?.role === 'owner');
    this.broadcast({ type: 'snapshot', room: this.publicState(state) });
  }

  mergeComments(existing, incoming) {
    const merged = new Map(existing.map((comment) => [comment.id, comment]));
    for (const comment of incoming) {
      const prior = merged.get(comment.id);
      const stamp = (value) => Date.parse(value?.updatedAt ?? value?.replies?.at(-1)?.createdAt ?? value?.createdAt ?? '') || 0;
      if (!prior || stamp(comment) >= stamp(prior)) merged.set(comment.id, comment);
    }
    return [...merged.values()];
  }

  applyMemberAction(state, member, body) {
    const now = new Date().toISOString();
    if (body.type === 'comment:add' && typeof body.text === 'string' && body.text.trim() && body.text.length <= 4000) {
      const comment = { id: `cm-${crypto.randomUUID()}`, text: body.text.trim(), page: typeof body.page === 'string' ? body.page.slice(0, 2000) : null, elementId: typeof body.elementId === 'string' ? body.elementId.slice(0, 200) : null, source: 'collaborator', author: member.name, status: 'open', resolved: false, codeRefs: [], anchor: null, drawing: null, replies: [], createdAt: now, updatedAt: now };
      state.session.comments.push(comment); state.session.revision += 1; state.session.updatedAt = now;
      this.note(state, 'comment', member.name, comment.text); return { type: 'comment:add', comment };
    }
    const comment = state.session.comments.find((item) => item.id === body.commentId);
    if (!comment) return null;
    if (body.type === 'comment:reply' && typeof body.text === 'string' && body.text.trim() && body.text.length <= 4000) {
      const reply = { id: `rp-${crypto.randomUUID()}`, text: body.text.trim(), author: 'reviewer', displayName: member.name, source: 'collaborator', createdAt: now };
      comment.replies = [...(comment.replies ?? []), reply]; comment.updatedAt = now;
      state.session.revision += 1; state.session.updatedAt = now; this.note(state, 'reply', member.name, comment.text);
      return { type: 'comment:reply', commentId: comment.id, reply };
    }
    if (body.type === 'comment:update') {
      let changed = false;
      if (['open', 'in_progress', 'needs_info'].includes(body.status)) { comment.status = body.status; comment.resolved = false; changed = true; }
      if (typeof body.assignee === 'string' && body.assignee.length <= 80) { comment.assignee = body.assignee || null; changed = true; }
      if (body.assignee === null) { comment.assignee = null; changed = true; }
      if (body.resolved === true || body.resolved === false) { comment.resolved = body.resolved; changed = true; }
      if (!changed) return null;
      comment.updatedAt = now; state.session.revision += 1; state.session.updatedAt = now;
      this.note(state, body.assignee !== undefined ? 'assigned' : body.resolved ? 'resolved' : 'status', member.name, comment.text);
      return { type: 'comment:update', commentId: comment.id, patch: { status: comment.status, assignee: comment.assignee ?? null, resolved: comment.resolved, updatedAt: now } };
    }
    return null;
  }

  note(state, type, name, text) { state.activity.unshift({ id: crypto.randomUUID(), type, name, text: String(text ?? '').slice(0, 240), at: new Date().toISOString() }); state.activity = state.activity.slice(0, 50); }
  publicState(state) {
    const participants = this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).filter((member) => member?.authenticated).map(({ memberId, name, role }) => ({ memberId, name, role }));
    return { roomId: state.roomId, project: state.project, session: state.session, participants, activity: state.activity };
  }
  broadcastPresence(state) { this.broadcast({ type: 'presence', room: this.publicState(state) }); }
  broadcast(value, recipient = () => true) {
    const shouldSend = typeof recipient === 'function' ? recipient : (ws) => ws !== recipient;
    for (const ws of this.ctx.getWebSockets('room')) {
      if (ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.authenticated && shouldSend(ws)) {
        try { ws.send(JSON.stringify(value)); } catch { ws.close(1011, 'Send failed'); }
      }
    }
  }
  async webSocketClose(socket) { const state = await this.readState(); if (state) this.broadcastPresence(state); }
  async webSocketError(socket) { try { socket.close(1011, 'Socket error'); } catch {} }
}
