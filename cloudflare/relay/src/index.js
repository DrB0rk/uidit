import { DurableObject } from 'cloudflare:workers';
import roomPage from '../public/index.html';

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders } });
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const secureEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
};
const validSession = (session) => session && typeof session === 'object' && Array.isArray(session.comments) && Array.isArray(session.elements) && Array.isArray(session.edits) && JSON.stringify(session).length <= 8_000_000;
const inviteExpiry = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'application/json is required' }, 415);
      const client = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.ROOM_CREATE_LIMIT.limit({ key: client });
      if (!success) return json({ error: 'too many share links created; try again in a minute' }, 429, { 'retry-after': '60' });
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
    const revoke = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)\/revoke-invite$/i);
    if (request.method === 'POST' && revoke) {
      const stub = env.ROOMS.getByName(revoke[1]);
      const response = await stub.fetch(new Request('https://room.internal/revoke-invite', { method: 'POST', headers: { authorization: request.headers.get('authorization') ?? '' } }));
      if (!response.ok) return response;
      const credentials = await response.json();
      return json({ ...credentials, inviteUrl: `${url.origin}/room/${revoke[1]}#${credentials.inviteToken}` });
    }
    const close = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)$/i);
    if (request.method === 'DELETE' && close) {
      return env.ROOMS.getByName(close[1]).fetch(new Request('https://room.internal/close', { method: 'POST', headers: { authorization: request.headers.get('authorization') ?? '' } }));
    }
    const pageView = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)\/page-view$/i);
    if (pageView && ['GET', 'POST'].includes(request.method)) {
      if (request.method === 'POST' && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'application/json is required' }, 415);
      const stub = env.ROOMS.getByName(pageView[1]);
      return stub.fetch(new Request(`https://room.internal/page-view${request.method === 'GET' ? '/read' : ''}`, { method: request.method, headers: { authorization: request.headers.get('authorization') ?? '', ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(request.method === 'POST' ? { body: await request.text() } : {}) }));
    }
    const socket = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)\/socket$/i);
    if (request.method === 'GET' && socket) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      return env.ROOMS.getByName(socket[1]).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return new Response(roomPage, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline'; connect-src 'self' https: wss: ws:; frame-src 'self'; img-src data: https:; font-src data: https:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
  },
};

export class CollaborationRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS payload_chunks (key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, part))');
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async readState() {
    const row = this.ctx.storage.sql.exec('SELECT value FROM state WHERE id = 1').toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.value);
    const session = await this.readPayload('session');
    const pageView = await this.readPayload('page-view');
    if (session !== null) state.session = JSON.parse(session);
    if (pageView !== null) state.pageView = JSON.parse(pageView);
    // Migrate rooms written before payloads were chunked.
    if (state.session || state.pageView) {
      const legacySession = state.session;
      const legacyPageView = state.pageView;
      const hasSessionChunk = session !== null;
      const hasPageViewChunk = pageView !== null;
      if (!hasSessionChunk && legacySession) await this.savePayload('session', JSON.stringify(legacySession));
      if (!hasPageViewChunk && legacyPageView) await this.savePayload('page-view', JSON.stringify(legacyPageView));
      if (!hasSessionChunk && legacySession || !hasPageViewChunk && legacyPageView) this.saveState(state);
    }
    return state;
  }

  saveState(state) {
    const { session, pageView, ...metadata } = state;
    this.ctx.storage.sql.exec('INSERT INTO state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(metadata));
  }

  async readPayload(key) {
    const chunks = this.ctx.storage.sql.exec('SELECT value FROM payload_chunks WHERE key = ? ORDER BY part', key).toArray();
    return chunks.length ? chunks.map((chunk) => chunk.value).join('') : null;
  }

  async savePayload(key, value) {
    this.ctx.storage.sql.exec('DELETE FROM payload_chunks WHERE key = ?', key);
    for (let offset = 0, part = 0; offset < value.length; offset += 64_000, part++) {
      this.ctx.storage.sql.exec('INSERT INTO payload_chunks (key, part, value) VALUES (?, ?, ?)', key, part, value.slice(offset, offset + 64_000));
    }
  }

  clearPayload(key) {
    this.ctx.storage.sql.exec('DELETE FROM payload_chunks WHERE key = ?', key);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create' && request.method === 'POST') {
      if (await this.readState()) return json({ error: 'room exists' }, 409);
      const { roomId, project } = await request.json();
      const ownerToken = randomToken(); const inviteToken = randomToken();
      const now = new Date().toISOString();
      const expiresAt = inviteExpiry();
      const state = { roomId, project, createdAt: now, ownerHash: await digest(ownerToken), inviteHash: await digest(inviteToken), inviteExpiresAt: expiresAt, members: [], ownerRevision: -1, deletedCommentIds: [], session: { version: 1, revision: 0, updatedAt: now, elements: [], comments: [], edits: [] }, activity: [] };
      this.saveState(state); await this.savePayload('session', JSON.stringify(state.session));
      await this.ctx.storage.setAlarm(Date.parse(expiresAt));
      return json({ roomId, ownerToken, inviteToken, inviteExpiresAt: expiresAt });
    }
    if (url.pathname === '/revoke-invite' && request.method === 'POST') {
      const state = await this.readState(); if (!state) return json({ error: 'room not found' }, 404);
      const ownerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!secureEqual(await digest(ownerToken), state.ownerHash)) return json({ error: 'unauthorized' }, 401);
      const inviteToken = randomToken();
      state.inviteHash = await digest(inviteToken);
      state.inviteExpiresAt = inviteExpiry();
      state.members = [];
      this.note(state, 'session-revoked', 'Project owner', 'Review link rotated; previous participants and link revoked');
      this.saveState(state);
      await this.ctx.storage.setAlarm(Date.parse(state.inviteExpiresAt));
      for (const socket of this.ctx.getWebSockets('room')) {
        if (socket.deserializeAttachment()?.role === 'member') socket.close(1008, 'Review access revoked');
      }
      return json({ inviteToken, inviteExpiresAt: state.inviteExpiresAt });
    }
    if (url.pathname === '/close' && request.method === 'POST') {
      const state = await this.readState(); if (!state) return json({ error: 'room not found' }, 404);
      if (state.closed) return json({ closed: true });
      const ownerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!secureEqual(await digest(ownerToken), state.ownerHash)) return json({ error: 'unauthorized' }, 401);
      await this.ctx.storage.deleteAlarm();
      this.saveState({ roomId: state.roomId, closed: true, closedAt: new Date().toISOString() });
      this.clearPayload('session'); this.clearPayload('page-view');
      for (const socket of this.ctx.getWebSockets('room')) socket.close(1000, 'Review sharing stopped');
      return json({ closed: true });
    }
    if (url.pathname === '/page-view/read' && request.method === 'GET') {
      const state = await this.readState(); if (!state?.pageView) return json({ error: 'page view not available' }, 404);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const tokenHash = await digest(token);
      if (!state.members.some((member) => secureEqual(tokenHash, member.tokenHash))) return json({ error: 'unauthorized' }, 401);
      return json({ ...(state.pageView.html ? { html: state.pageView.html } : { dataUrl: state.pageView.dataUrl }) });
    }
    if (url.pathname === '/page-view' && request.method === 'POST') {
      const state = await this.readState(); if (!state) return json({ error: 'room not found' }, 404);
      const ownerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!secureEqual(await digest(ownerToken), state.ownerHash)) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
      const width = Number(body.width), height = Number(body.height);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 10000 || height > 10000) return json({ error: 'valid page dimensions are required' }, 400);
      const isHtmlSnapshot = typeof body.html === 'string' && body.html.startsWith('<!doctype html>') && body.html.length <= 12_000_000;
      const isImageSnapshot = typeof body.dataUrl === 'string' && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(body.dataUrl) && body.dataUrl.length <= 3_400_000;
      if (!isHtmlSnapshot && !isImageSnapshot) return json({ error: 'provide a sanitized HTML snapshot up to 12 MB or a JPEG/PNG snapshot up to 2.5 MiB' }, 400);
      state.pageView = { ...(isHtmlSnapshot ? { html: body.html } : { dataUrl: body.dataUrl }), width, height, url: typeof body.url === 'string' ? body.url.slice(0, 2000) : '', capturedAt: new Date().toISOString() };
      this.saveState(state); await this.savePayload('page-view', JSON.stringify(state.pageView)); this.broadcast({ type: 'snapshot', room: this.publicState(state) });
      return json({ pageView: { width, height, url: state.pageView.url, kind: isHtmlSnapshot ? 'html' : 'image', capturedAt: state.pageView.capturedAt } });
    }
    if (url.pathname === '/join' && request.method === 'POST') {
      const state = await this.readState(); if (!state) return json({ error: 'room not found' }, 404);
      if (state.closed) return json({ error: 'review sharing has stopped' }, 404);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || typeof body.inviteToken !== 'string') return json({ error: 'name and invite token are required' }, 400);
      if (!state.inviteExpiresAt || Date.parse(state.inviteExpiresAt) <= Date.now()) return json({ error: 'invite link expired' }, 410);
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
    if (!state || state.closed) { socket.close(1008, 'Room unavailable'); return; }
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
      state.deletedCommentIds = [...new Set([...(state.deletedCommentIds ?? []), ...(Array.isArray(incoming.deletedCommentIds) ? incoming.deletedCommentIds.filter((id) => typeof id === 'string') : [])])];
      const deleted = new Set(state.deletedCommentIds ?? []);
      state.session = { ...incoming, comments: this.mergeComments(state.session.comments ?? [], incoming.comments).filter((comment) => !deleted.has(comment.id)), elements: incoming.elements, edits: incoming.edits };
      state.ownerRevision = Math.max(state.ownerRevision, Number(incoming.revision) || 0);
      this.saveState(state); await this.savePayload('session', JSON.stringify(state.session)); this.broadcast({ type: 'snapshot', room: this.publicState(state) });
      return;
    }
    if (member.role === 'owner') return;
    const event = this.applyMemberAction(state, member, body);
    if (!event) return;
    this.saveState(state); await this.savePayload('session', JSON.stringify(state.session));
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
      const point = body.point && Number.isFinite(body.point.x) && Number.isFinite(body.point.y) ? { x: Math.max(0, Math.min(1, body.point.x)), y: Math.max(0, Math.min(1, body.point.y)) } : null;
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (attachments.length > 2 || attachments.some((item) => !item || typeof item.dataUrl !== 'string' || item.dataUrl.length > 420_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(item.dataUrl))) return null;
      const selector = typeof body.selector === 'string' ? body.selector.slice(0, 1000) : null;
      const elementId = state.session.elements.find((item) => item.selector === selector)?.id ?? (typeof body.elementId === 'string' ? body.elementId.slice(0, 200) : null);
      const comment = { id: `cm-${crypto.randomUUID()}`, text: body.text.trim(), page: typeof body.page === 'string' ? body.page.slice(0, 2000) : null, selector, elementId, ...(point ? { point } : {}), source: 'collaborator', author: member.name, authorId: member.memberId, status: 'open', resolved: false, codeRefs: [], anchor: point, drawing: null, attachments: attachments.map((item) => ({ dataUrl: item.dataUrl, name: typeof item.name === 'string' ? item.name.replace(/[\r\n]/g, '').slice(0, 120) : 'reference.jpg', width: Number.isInteger(item.width) ? Math.max(1, Math.min(1600, item.width)) : null, height: Number.isInteger(item.height) ? Math.max(1, Math.min(1600, item.height)) : null, mimeType: 'image/jpeg' })), replies: [], createdAt: now, updatedAt: now };
      state.session.comments.push(comment); state.session.revision += 1; state.session.updatedAt = now;
      this.note(state, 'comment', member.name, comment.text); return { type: 'comment:add', comment };
    }
    const comment = state.session.comments.find((item) => item.id === body.commentId);
    if (!comment) return null;
    if (body.type === 'comment:delete') {
      if (comment.source !== 'collaborator' || (comment.authorId ? comment.authorId !== member.memberId : comment.author !== member.name)) return null;
      state.deletedCommentIds ??= [];
      if (!state.deletedCommentIds.includes(comment.id)) state.deletedCommentIds.push(comment.id);
      state.session.revision += 1; state.session.updatedAt = now;
      this.note(state, 'comment-deleted', member.name, comment.text);
      return { type: 'comment:delete', commentId: comment.id };
    }
    if (body.type === 'comment:update') {
      const isAuthor = comment.source === 'collaborator' && (comment.authorId ? comment.authorId === member.memberId : comment.author === member.name);
      const patch = {};
      if (body.text !== undefined) {
        if (!isAuthor || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) return null;
        patch.text = body.text.trim();
      }
      if (body.status !== undefined) {
        if (!['open', 'in_progress', 'needs_info'].includes(body.status)) return null;
        patch.status = body.status;
      }
      if (body.resolved !== undefined) {
        if (typeof body.resolved !== 'boolean') return null;
        patch.resolved = body.resolved;
      }
      if (body.assignee !== undefined) {
        const assignees = new Set(['Project owner', ...state.members.map((item) => item.name)]);
        if (body.assignee !== null && (typeof body.assignee !== 'string' || !assignees.has(body.assignee))) return null;
        patch.assignee = body.assignee;
      }
      if (!Object.keys(patch).length) return null;
      Object.assign(comment, patch, { updatedAt: now });
      state.session.revision += 1; state.session.updatedAt = now;
      this.note(state, patch.resolved === true ? 'comment-resolved' : patch.resolved === false ? 'comment-reopened' : 'comment-updated', member.name, comment.text);
      return { type: 'comment:update', commentId: comment.id, patch };
    }
    if (body.type === 'comment:reply' && typeof body.text === 'string' && body.text.trim() && body.text.length <= 4000) {
      const reply = { id: `rp-${crypto.randomUUID()}`, text: body.text.trim(), author: 'reviewer', displayName: member.name, source: 'collaborator', createdAt: now };
      comment.replies = [...(comment.replies ?? []), reply]; comment.updatedAt = now;
      state.session.revision += 1; state.session.updatedAt = now; this.note(state, 'reply', member.name, comment.text);
      return { type: 'comment:reply', commentId: comment.id, reply };
    }
    return null;
  }

  note(state, type, name, text) { state.activity.unshift({ id: crypto.randomUUID(), type, name, text: String(text ?? '').slice(0, 240), at: new Date().toISOString() }); state.activity = state.activity.slice(0, 50); }
  publicState(state) {
    const participants = this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).filter((member) => member?.authenticated).map(({ memberId, name, role }) => ({ memberId, name, role }));
    const session = {
      ...state.session,
      comments: state.session.comments.filter((comment) => !(state.deletedCommentIds ?? []).includes(comment.id)),
      deletedCommentIds: state.deletedCommentIds ?? [],
      elements: state.session.elements.map(({ id, selector }) => ({ id, selector })),
      edits: state.session.edits.map(({ id, kind, elementId, property, before, after, applied, createdAt }) => ({ id, kind, elementId, property, before, after, applied, createdAt })),
    };
    const pageView = state.pageView ? { width: state.pageView.width, height: state.pageView.height, url: state.pageView.url, kind: state.pageView.html ? 'html' : 'image', capturedAt: state.pageView.capturedAt } : null;
    return { roomId: state.roomId, project: state.project, session, pageView, participants, activity: state.activity };
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
  async alarm() {
    const state = await this.readState();
    if (!state) return;
    const expiresAt = Date.parse(state.inviteExpiresAt);
    if (expiresAt > Date.now()) { await this.ctx.storage.setAlarm(expiresAt); return; }
    for (const socket of this.ctx.getWebSockets('room')) socket.close(1000, 'Review room expired');
    await this.ctx.storage.deleteAll();
  }
}
