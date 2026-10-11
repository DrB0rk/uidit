import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/server/store.js';
import { injectIntoHtml } from '../src/server/server.js';
import { triageFeedback } from '../src/server/triage.js';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uidit-unit-'));
  return dir;
}

test('init creates config, empty session and agent README', () => {
  const cwd = tmpProject();
  const { created } = store.init(cwd);
  assert.equal(created, true);
  assert.equal(store.readConfig(cwd).version, 2);
  assert.deepEqual(store.readSession(cwd).comments, []);
  assert.ok(fs.existsSync(path.join(cwd, '.uidit', 'README.md')));
});

test('init is idempotent and keeps existing feedback', () => {
  const cwd = tmpProject();
  store.init(cwd);
  store.addComment(cwd, { text: 'keep me' });
  const second = store.init(cwd);
  assert.equal(second.created, false);
  assert.equal(store.readSession(cwd).comments.length, 1);
});

test('elements get a stable id derived from their selector', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const a = store.upsertElement(cwd, { selector: '#pay', tag: 'BUTTON' });
  const b = store.upsertElement(cwd, { selector: '#pay', tag: 'BUTTON', text: 'Pay now' });
  assert.equal(a.id, b.id);
  const session = store.readSession(cwd);
  assert.equal(session.elements.length, 1);
  assert.equal(session.elements[0].text, 'Pay now');
});

test('comments default to unresolved and can be resolved by id', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const c = store.addComment(cwd, { elementId: null, text: 'page level' });
  assert.equal(c.resolved, false);
  assert.ok(store.updateRecord(cwd, 'comments', c.id, { resolved: true }));
  assert.equal(store.readSession(cwd).comments[0].resolved, true);
  assert.equal(store.updateRecord(cwd, 'comments', 'cm-missing', { resolved: true }), null);
});

test('comment reference photos are bounded, normalized and persisted', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', mimeType: 'image/jpeg', name: 'mockup.png', width: 640, height: 480 };
  const comment = store.addComment(cwd, { text: 'Match this treatment', attachments: [image] });
  assert.equal(comment.attachments[0].mimeType, 'image/jpeg');
  assert.equal(store.readSession(cwd).comments[0].attachments[0].name, 'mockup.png');
  assert.throws(() => store.addComment(cwd, { text: 'Too many', attachments: [image, image, image] }), /at most 2 images/);
  assert.throws(() => store.addComment(cwd, { text: 'Unsafe image', attachments: [{ ...image, dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }] }), /compressed JPEGs/);
});

test('comments hold attributed thread replies', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const comment = store.addComment(cwd, { text: 'Could you adjust the spacing?' });
  const { reply, comment: updated } = store.addCommentReply(cwd, comment.id, { text: 'Should it match the card below?', author: 'agent' });
  assert.equal(comment.replies.length, 0);
  assert.equal(reply.author, 'agent');
  assert.match(reply.text, /match the card/);
  assert.equal(updated.replies.length, 1);
  assert.equal(store.addCommentReply(cwd, 'cm-missing', { text: 'No parent' }), null);
});

test('code references are normalized and reject paths outside the project', () => {
  assert.deepEqual(store.normalizeCodeReference({ file: 'src\\ui\\Card.tsx', startLine: 8, endLine: 12 }), { file: 'src/ui/Card.tsx', startLine: 8, endLine: 12 });
  assert.throws(() => store.normalizeCodeReference({ file: '../secrets.txt', startLine: 1 }), /project-relative/);
  assert.throws(() => store.normalizeCodeReference({ file: 'src/Card.tsx', startLine: 0 }), /line numbers/);
});

test('triage groups related feedback, prioritizes urgency, and detects likely duplicates', () => {
  const elements = [{ id: 'el-1', selector: '.checkout', accessibleName: 'Checkout', component: { framework: 'React', name: 'Checkout' } }];
  const comments = [
    { id: 'a', text: 'Checkout is broken and blocks payment', elementId: 'el-1', createdAt: '2025-01-01', resolved: false },
    { id: 'b', text: 'Checkout is broken and blocks payment!', elementId: 'el-1', createdAt: '2025-01-02', resolved: false },
    { id: 'c', text: 'Make footer color warmer', elementId: null, page: '/home', createdAt: '2025-01-03', resolved: false },
  ];
  const triage = triageFeedback(comments, elements);
  assert.equal(triage.suggestedOrder[0].priority, 'high');
  assert.deepEqual(triage.relatedGroups[0].commentIds, ['a', 'b']);
  assert.deepEqual(triage.possibleDuplicates, [['a', 'b']]);
  assert.equal(triage.suggestedOrder[0].element.component.name, 'Checkout');
});

test('edits record before/after and applied defaults to false', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const e = store.addEdit(cwd, { elementId: 'el-1', kind: 'style', property: 'padding', before: '', after: '16px' });
  assert.equal(e.applied, false);
  assert.equal(store.readSession(cwd).edits[0].after, '16px');
});

test('remove drops only the requested record', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const a = store.addComment(cwd, { text: 'a' });
  store.addComment(cwd, { text: 'b' });
  assert.equal(store.removeRecord(cwd, 'comments', a.id), true);
  assert.equal(store.removeRecord(cwd, 'comments', a.id), false);
  assert.deepEqual(store.readSession(cwd).comments.map((c) => c.text), ['b']);
});

test('html injection puts the overlay first in head and exposes the target origin', () => {
  const html = injectIntoHtml('<html><head><title>x</title></head><body></body></html>', 'http://localhost:3000');
  assert.match(html, /<head>\s*<link rel="stylesheet" href="\/overlay\.css" data-uidit="1"><script src="\/overlay\.js"/);
  assert.match(html, /data-target="http:\/\/localhost:3000"/);
});

test('html injection works without a head element', () => {
  const html = injectIntoHtml('<div>bare</div>', 'http://x');
  assert.match(html, /overlay\.js/);
});
