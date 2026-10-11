/** Local Cloudflare Worker + Durable Object collaboration integration coverage. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname;
const SECRET = 'local-relay-test-secret-1234567890';
const server = net.createServer();
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }));
const worker = spawn('npx', ['wrangler', 'dev', '--config', 'cloudflare/relay/wrangler.toml', '--port', String(port), '--var', `ADMIN_SECRET:${SECRET}`], { cwd: ROOT, stdio: 'ignore' });
const origin = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForMessage = (socket, predicate, timeout = 7000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('timed out waiting for relay message')); }, timeout);
  function onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!predicate(message)) return;
    clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve(message);
  }
  socket.addEventListener('message', onMessage);
});
const connect = async (roomId, token) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${roomId}/socket`);
  const connected = waitForMessage(socket, (message) => message.type === 'connected');
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.send(JSON.stringify({ type: 'auth', token }));
  await connected;
  return socket;
};

let ownerSocket;
let memberSocket;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early (${worker.exitCode})`);
    ready = await fetch(origin).then((response) => response.ok).catch(() => false);
    if (!ready) await pause(250);
  }
  assert.ok(ready, 'Wrangler local relay did not become ready');
  const unauthorized = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'e2e' }) });
  assert.equal(unauthorized.status, 401, 'room creation requires the relay admin secret');
  const created = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ project: 'Relay integration' }) });
  assert.equal(created.status, 201);
  const room = await created.json();
  const invitePage = await fetch(`${origin}/room/${room.roomId}`);
  assert.equal(invitePage.status, 200);
  assert.match(await invitePage.text(), /Join this UIDIT review/);
  const rejected = await fetch(`${origin}/api/rooms/${room.roomId}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Reviewer', inviteToken: 'invalid' }) });
  assert.equal(rejected.status, 401, 'invalid invite tokens are rejected');
  const joined = await fetch(`${origin}/api/rooms/${room.roomId}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Reviewer', inviteToken: room.inviteToken }) });
  assert.equal(joined.status, 200);
  const member = await joined.json();
  ownerSocket = await connect(room.roomId, room.ownerToken);
  memberSocket = await connect(room.roomId, member.memberToken);
  const cursor = waitForMessage(ownerSocket, (message) => message.type === 'cursor');
  memberSocket.send(JSON.stringify({ type: 'cursor', x: 1.4, y: -0.2 }));
  const cursorEvent = await cursor;
  assert.equal(cursorEvent.x, 1);
  assert.equal(cursorEvent.y, 0);
  const snapshot = waitForMessage(ownerSocket, (message) => message.type === 'snapshot' && message.room.session.comments?.some((comment) => comment.text === 'Please adjust the card spacing.'));
  memberSocket.send(JSON.stringify({ type: 'comment:add', text: 'Please adjust the card spacing.', page: '/' }));
  const shared = await snapshot;
  const comment = shared.room.session.comments.find((item) => item.text === 'Please adjust the card spacing.');
  assert.equal(comment.author, 'Reviewer');
  assert.ok(shared.room.participants.some((item) => item.role === 'owner'));
  const replySnapshot = waitForMessage(ownerSocket, (message) => message.type === 'snapshot' && message.room.session.comments.find((item) => item.id === comment.id)?.replies?.length === 1);
  memberSocket.send(JSON.stringify({ type: 'comment:reply', commentId: comment.id, text: 'I will update it.' }));
  await replySnapshot;
  const assignedSnapshot = waitForMessage(ownerSocket, (message) => message.type === 'snapshot' && message.room.session.comments.find((item) => item.id === comment.id)?.assignee === 'Reviewer');
  memberSocket.send(JSON.stringify({ type: 'comment:update', commentId: comment.id, status: 'in_progress', assignee: 'Reviewer' }));
  const assigned = await assignedSnapshot;
  assert.equal(assigned.room.session.comments.find((item) => item.id === comment.id)?.status, 'in_progress');
  const ownerSync = waitForMessage(memberSocket, (message) => message.type === 'snapshot' && message.room.session.elements?.some((item) => item.id === 'el-test'));
  ownerSocket.send(JSON.stringify({ type: 'sync', session: { version: 1, revision: 4, updatedAt: new Date().toISOString(), elements: [{ id: 'el-test', selector: '#checkout' }], edits: [], comments: [{ id: 'cm-image', text: 'Use this photo as a reference', attachments: [{ name: 'reference.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }] }] } }));
  const sharedImage = await ownerSync;
  assert.equal(sharedImage.room.session.comments.find((item) => item.id === 'cm-image').attachments[0].name, 'reference.jpg');
  console.log('  ok  Cloudflare relay auth, invite page, realtime cursor/presence, comments, replies, assignments and owner sync');
} finally {
  ownerSocket?.close(); memberSocket?.close(); worker.kill('SIGTERM');
  await new Promise((resolve) => { if (worker.exitCode !== null) resolve(); else { worker.once('exit', resolve); setTimeout(resolve, 2000).unref(); } });
}
