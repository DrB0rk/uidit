import fs from 'node:fs';
import path from 'node:path';
import { uiditDir, readSession, mergeCollaborativeSession } from './store.js';

const stateFile = (cwd) => path.join(uiditDir(cwd), 'runtime', 'collaboration.json');
function readState(cwd) {
  const file = stateFile(cwd);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeState(cwd, state) {
  const file = stateFile(cwd); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export class CollaborationManager {
  constructor({ cwd, hub }) {
    this.cwd = cwd; this.hub = hub; this.config = readState(cwd); this.socket = null; this.closed = false;
    this.connected = false; this.participants = []; this.activity = []; this.lastError = null; this.retry = null; this.retryCount = 0;
    this.unsubscribe = hub.subscribe?.((type, session) => { if (type === 'session' && session) this.send({ type: 'sync', session }); });
    this.connect();
  }
  status() {
    return { enabled: Boolean(this.config?.roomId), connected: this.connected, roomId: this.config?.roomId ?? null, project: this.config?.project ?? null, relayUrl: this.config?.relayUrl ?? null, inviteUrl: this.config?.inviteUrl ?? null, inviteExpiresAt: this.config?.inviteExpiresAt ?? null, participants: this.participants, activity: this.activity, error: this.lastError };
  }
  update() { this.hub.notifyCollaboration?.(this.status()); }
  async createRoom({ relayUrl, adminSecret, project }) {
    let endpoint;
    try { endpoint = new URL(relayUrl); } catch { throw new Error('Enter a valid HTTPS relay URL'); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Relay must use HTTPS (HTTP is allowed for localhost development)');
    if (!adminSecret || adminSecret.length < 24 || adminSecret.length > 300) throw new Error('Relay admin secret must be at least 24 characters');
    if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Enter the relay origin only, without a path or query');
    endpoint.search = ''; endpoint.hash = '';
    const response = await fetch(new URL('/api/rooms', endpoint), { method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' }, body: JSON.stringify({ project }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Relay room creation failed (${response.status})`);
    this.config = { relayUrl: endpoint.origin, roomId: data.roomId, ownerToken: data.ownerToken, inviteUrl: data.inviteUrl, inviteExpiresAt: data.inviteExpiresAt, project };
    writeState(this.cwd, this.config); this.lastError = null; this.connect(); this.update();
    return this.status();
  }
  async revokeInvite() {
    if (!this.config?.roomId || !this.config?.ownerToken) throw new Error('No active review link');
    const response = await fetch(new URL(`/api/rooms/${this.config.roomId}/revoke-invite`, this.config.relayUrl), { method: 'POST', headers: { authorization: `Bearer ${this.config.ownerToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not revoke review link (${response.status})`);
    this.config.inviteUrl = data.inviteUrl;
    this.config.inviteExpiresAt = data.inviteExpiresAt;
    writeState(this.cwd, this.config);
    this.participants = [];
    this.activity = [{ type: 'session-revoked', name: 'You', text: 'Link rotated and prior participants disconnected', at: new Date().toISOString() }, ...this.activity].slice(0, 50);
    this.update();
    return this.status();
  }
  connect() {
    if (this.closed || !this.config?.roomId || this.socket) return;
    const url = new URL(`/api/rooms/${this.config.roomId}/socket`, this.config.relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); this.socket = socket;
    socket.addEventListener('open', () => { socket.send(JSON.stringify({ type: 'auth', token: this.config.ownerToken })); });
    socket.addEventListener('message', (event) => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'connected') {
        this.retryCount = 0; this.connected = true; this.lastError = null; this.participants = message.room?.participants ?? []; this.activity = message.room?.activity ?? this.activity; this.update();
        this.send({ type: 'sync', session: readSession(this.cwd) });
      } else if (message.type === 'snapshot' || message.type === 'presence') {
        const prior = JSON.stringify(readSession(this.cwd).comments);
        try { mergeCollaborativeSession(this.cwd, message.room?.session); } catch (error) { this.lastError = error.message; }
        const current = readSession(this.cwd);
        this.participants = message.room?.participants ?? []; this.activity = message.room?.activity ?? this.activity; this.update();
        if (JSON.stringify(current.comments) !== prior) this.hub.notify();
      }
    });
    socket.addEventListener('error', () => { this.lastError = 'Relay connection error'; });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.connected = false; this.participants = []; this.update();
      if (!this.closed && this.config?.roomId) {
        const delay = Math.min(30000, 1000 * (2 ** Math.min(this.retryCount++, 5))) + Math.random() * 300;
        this.retry = setTimeout(() => this.connect(), delay); this.retry.unref?.();
      }
    });
  }
  send(data) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data)); }
  close() { this.closed = true; clearTimeout(this.retry); this.unsubscribe?.(); this.socket?.close(); this.socket = null; }
}

