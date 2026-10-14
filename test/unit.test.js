import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import * as store from '../src/server/store.js';
import { injectIntoHtml } from '../src/server/server.js';
import { triageFeedback } from '../src/server/triage.js';
import { routeIdentity, recoverAnchor, anchorFor } from '../src/server/identity.js';
import * as taskStore from '../src/server/tasks.js';
import { impactGraph, gitContext, projectContext } from '../src/server/project-context.js';
import { auditBrowserContext } from '../src/server/audit.js';
import { exportFlowAsPlaywright } from '../src/server/flow-export.js';
import { createServiceManager } from '../src/server/process-manager.js';
import { createSelectiveVerifier } from '../src/server/verification.js';

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

test('element identity is stable per route, scoped across routes, and carries a recoverable anchor', () => {
  const cwd = tmpProject();
  store.init(cwd);
  const a = store.upsertElement(cwd, { selector: '#pay', tag: 'BUTTON', role: 'button', accessibleName: 'Pay now', text: 'Pay now', page: 'http://localhost:3000/cart?r=123' });
  const b = store.upsertElement(cwd, { selector: '#pay', tag: 'BUTTON', role: 'button', accessibleName: 'Pay now', text: 'Pay now', page: 'http://localhost:3000/cart?r=987' });
  assert.equal(a.id, b.id);
  const otherRoute = store.upsertElement(cwd, { selector: '#pay', tag: 'BUTTON', page: 'http://localhost:3000/checkout' });
  assert.notEqual(a.id, otherRoute.id);
  assert.equal(routeIdentity('http://localhost:3000/cart?r=1'), routeIdentity('http://localhost:3000/cart?r=2'));
  assert.equal(typeof b.anchor.fingerprint, 'string');
  const session = store.readSession(cwd);
  assert.equal(session.elements.length, 2);
  assert.equal(session.elements.find((item) => item.id === a.id).text, 'Pay now');
});

test('anchor recovery refuses ambiguous matches and never crosses routes', () => {
  const original = { ...anchorFor({ selector: '.old', tag: 'BUTTON', role: 'button', accessibleName: 'Continue checkout', text: 'Continue checkout', page: 'http://localhost:3000/cart' }) };
  const candidate = { selector: '.new', tag: 'BUTTON', role: 'button', accessibleName: 'Continue checkout', text: 'Continue checkout', page: 'http://localhost:3000/cart' };
  assert.equal(recoverAnchor(original, [candidate]).status, 'recovered');
  assert.equal(recoverAnchor(original, [candidate, { ...candidate, selector: '.other' }]).status, 'ambiguous');
  assert.equal(recoverAnchor(original, [{ ...candidate, page: 'http://localhost:3000/checkout' }]).status, 'missing');
});

test('v1 sessions migrate with a preserved backup and retain legacy ids', () => {
  const cwd = tmpProject(); store.init(cwd);
  const file = path.join(cwd, '.uidit', 'session.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 7, elements: [{ id: 'el-legacy', selector: '#pay', page: 'http://localhost/cart', tag: 'BUTTON' }], comments: [{ id: 'cm-old', elementId: 'el-legacy', text: 'keep' }], edits: [] }));
  const migrated = store.readSession(cwd);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.elements[0].id, 'el-legacy');
  assert.equal(migrated.comments[0].originalAnchor.selector, '#pay');
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.includes('v1-backup')));
});

test('newer session schemas are preserved and refused instead of downgraded', () => {
  const cwd = tmpProject(); store.init(cwd);
  const file = path.join(cwd, '.uidit', 'session.json');
  fs.writeFileSync(file, JSON.stringify({ version: 3, tasks: [{ id: 'new-schema' }], custom: 'keep' }));
  assert.throws(() => store.readSession(cwd), /newer than this UIDIT release supports/);
  assert.match(fs.readFileSync(file, 'utf8'), /"version":3/);
});

test('tasks use optimistic revisions, evidence gates verification, and reviewer-only acceptance', () => {
  const cwd = tmpProject(); store.init(cwd);
  const comment = store.addComment(cwd, { text: 'Fix mobile overflow' });
  const task = taskStore.createTask(cwd, { title: 'Fix mobile layout', commentIds: [comment.id] });
  const claimed = taskStore.updateTask(cwd, task.id, { owner: 'agent-1', status: 'in_progress' }, { expectedRevision: 1 });
  assert.equal(claimed.owner, 'agent-1');
  assert.throws(() => taskStore.updateTask(cwd, task.id, { owner: 'agent-2' }, { expectedRevision: 2 }), /already claimed/);
  assert.throws(() => taskStore.updateTask(cwd, task.id, { status: 'verified' }, { expectedRevision: 2 }), /invalid task transition/);
  const evidence = taskStore.addEvidence(cwd, task.id, { type: 'test', result: 'passed', summary: 'Mobile overflow test passed' });
  assert.ok(evidence.id);
  taskStore.addEvidence(cwd, task.id, { type: 'test', result: 'failed', summary: 'A separate check failed' });
  assert.equal(taskStore.updateTask(cwd, task.id, { status: 'implemented' }, { expectedRevision: 4 }).status, 'implemented');
  assert.equal(taskStore.updateTask(cwd, task.id, { status: 'verified' }, { expectedRevision: 5 }).status, 'verified');
  assert.throws(() => taskStore.updateTask(cwd, task.id, { status: 'accepted' }, { expectedRevision: 6 }), /only a reviewer/);
  assert.equal(taskStore.updateTask(cwd, task.id, { status: 'accepted' }, { expectedRevision: 6, reviewer: true }).status, 'accepted');
  assert.throws(() => taskStore.updateTask(cwd, task.id, { status: 'blocked' }, { expectedRevision: 1 }), /revision changed/);
  const failedOnly = taskStore.createTask(cwd, { title: 'Failed verification' });
  taskStore.updateTask(cwd, failedOnly.id, { status: 'in_progress' }, { expectedRevision: 1 });
  taskStore.updateTask(cwd, failedOnly.id, { status: 'implemented' }, { expectedRevision: 2 });
  taskStore.addEvidence(cwd, failedOnly.id, { type: 'test', result: 'failed', summary: 'Still broken' });
  assert.throws(() => taskStore.updateTask(cwd, failedOnly.id, { status: 'verified' }, { expectedRevision: 4 }), /passing verification evidence/);
});

test('visual proposals validate allowed operations and remain reversible', () => {
  const cwd = tmpProject(); store.init(cwd);
  const element = store.upsertElement(cwd, { selector: '#pay', page: 'http://localhost/' });
  const proposal = taskStore.createProposal(cwd, { elementId: element.id, operation: 'style', title: 'More padding', changes: [{ property: 'padding', before: '8px', value: '16px' }] });
  assert.equal(proposal.status, 'proposed');
  assert.equal(taskStore.updateProposal(cwd, proposal.id, 'rejected').status, 'rejected');
  assert.throws(() => taskStore.createProposal(cwd, { elementId: element.id, operation: 'style', changes: [{ property: 'background', value: 'url(javascript:alert(1))' }] }), /not allowed/);
});

test('project impact context relates observed routes, source references, comments and read-only Git data', () => {
  const cwd = tmpProject(); store.init(cwd);
  const first = store.upsertElement(cwd, { selector: '#save', page: 'http://localhost/a', component: { name: 'SaveButton' } });
  const second = store.upsertElement(cwd, { selector: '#save', page: 'http://localhost/b', component: { name: 'SaveButton' } });
  const comment = store.addComment(cwd, { text: 'Check shared button', elementId: first.id });
  store.updateRecord(cwd, 'comments', comment.id, { codeRefs: [{ file: 'src/SaveButton.jsx', startLine: 4, endLine: 8 }] });
  const graph = impactGraph(cwd);
  assert.equal(graph.coverage.observedRoutes, 2);
  assert.equal(graph.nodes.find((node) => node.source === 'src/SaveButton.jsx').commentIds[0], comment.id);
  assert.equal(gitContext(cwd).available, false);
  fs.writeFileSync(path.join(cwd, '.uidit', 'design-rules.md'), 'Prefer existing spacing tokens.');
  const context = projectContext(cwd);
  assert.equal(context.designRules.category, 'project preference');
  assert.match(context.designRules.content, /spacing tokens/);
});

test('comment attachment fields remain validated after caller data is merged', () => {
  const cwd = tmpProject(); store.init(cwd);
  assert.throws(() => store.addComment(cwd, { text: 'bad image', attachments: [{ mimeType: 'text/html', dataUrl: 'data:text/html,<script>' }] }), /compressed JPEG/);
});

test('live audit distinguishes measured findings, candidate contrast, and untested coverage', () => {
  const report = auditBrowserContext({ url: 'http://localhost/', viewport: { width: 375, height: 800 }, nodes: [
    { selector: 'button', tag: 'button', name: '', bounds: { x: 0, y: 10, width: 18, height: 20 }, styles: { color: 'rgb(120, 120, 120)', backgroundColor: 'rgb(255, 255, 255)' } },
    { selector: 'div', tag: 'div', name: '', bounds: { x: 0, y: 900, width: 20, height: 20 }, styles: {} },
  ] });
  assert.ok(report.findings.some((finding) => finding.rule === 'accessible-name'));
  assert.ok(report.findings.some((finding) => finding.rule === 'target-size'));
  assert.ok(report.findings.some((finding) => finding.rule === 'text-contrast' && finding.confidence === 'medium'));
  assert.equal(report.findings.some((finding) => finding.rule === 'horizontal-overflow' && finding.selector === 'div'), false);
  assert.equal(report.coverage.keyboard, 'not_checked');
});

test('workspace services validate isolation and start dependencies in order with independent ownership', async (t) => {
  const cwd = tmpProject();
  const portFor = async () => {
    const server = net.createServer();
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }));
  };
  const commandFor = (port) => ['node', '-e', `const h=require('node:http');const s=h.createServer((q,r)=>r.end('ok'));s.listen(${port},'127.0.0.1',()=>console.log('http://127.0.0.1:${port}'))`];
  const apiPort = await portFor(), webPort = await portFor();
  const manager = createServiceManager({ cwd });
  t.after(() => manager.stopAll());
  assert.throws(() => manager.configure([{ id: 'a', command: ['node', '-e', ''], cwd: '../outside' }]), /inside the project/);
  const outside = tmpProject(); fs.symlinkSync(outside, path.join(cwd, 'linked-outside'), 'dir');
  assert.throws(() => manager.configure([{ id: 'a', command: ['node', '-e', ''], cwd: 'linked-outside' }]), /inside the project/);
  assert.throws(() => manager.configure([{ id: 'a', command: ['node'], dependencies: ['b'] }, { id: 'b', command: ['node'], dependencies: ['a'] }]), /cycle/);
  manager.configure([
    { id: 'api', name: 'API', command: commandFor(apiPort), cwd: '.', dependencies: [] },
    { id: 'web', name: 'Frontend', command: commandFor(webPort), cwd: '.', dependencies: ['api'] },
  ]);
  const status = await manager.start('web');
  assert.equal(status.state, 'ready');
  assert.deepEqual(manager.status().map((service) => service.state), ['ready', 'ready']);
  assert.equal(manager.status().every((service) => service.owned), true);
  await manager.stopAll();
  assert.deepEqual(manager.status().map((service) => service.state), ['stopped', 'stopped']);
  assert.doesNotThrow(() => manager.configure([]));
});

test('HMR verifier selectively checks linked anchors on the observed route without claiming visual correctness', async (t) => {
  const cwd = tmpProject(); store.init(cwd); store.writeConfig(cwd, { ui: { allowBrowserInspection: true } });
  const element = store.upsertElement(cwd, { selector: '#checkout', tag: 'button', page: 'http://127.0.0.1:3000/checkout', sourceFile: 'src/Checkout.jsx' });
  const comment = store.addComment(cwd, { text: 'Review checkout button', page: element.page, elementId: element.id });
  const task = taskStore.createTask(cwd, { title: 'Review checkout', commentIds: [comment.id] });
  taskStore.updateTask(cwd, task.id, { changedFiles: ['src/Checkout.jsx'] }, { expectedRevision: 1 });
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  let context = { url: element.page, nodes: [{ selector: '#checkout' }] };
  const devEvents = [];
  const hub = { get browserContext() { return context; }, notifyDev: (event) => devEvents.push(event), notify() {} };
  const verifier = createSelectiveVerifier({ cwd, hub, quietPeriod: 250 }); verifier.start();
  t.after(() => verifier.close());
  assert.equal(verifier.watching, true);
  const waitForEvidence = async (count) => { for (let i = 0; i < 100; i++) { const current = store.readSession(cwd); if (current.evidence.length >= count) return current.evidence.at(-1); await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('timed out waiting for selective HMR evidence'); };
  fs.writeFileSync(path.join(cwd, 'src/Checkout.jsx'), 'updated');
  const present = await waitForEvidence(1);
  assert.equal(present.result, 'note');
  assert.match(present.summary, /still need review/);
  context = { url: element.page, nodes: [] };
  fs.writeFileSync(path.join(cwd, 'src/Checkout.jsx'), 'updated again');
  const missing = await waitForEvidence(2);
  assert.equal(missing.result, 'failed');
  assert.deepEqual(missing.metadata.missingSelectors, ['#checkout']);
  assert.equal(devEvents.at(-1).hmrVerification.impactedTasks, 1);
  verifier.close();
});

test('Playwright export makes selector drift explicit and never exports recorded input values', () => {
  const code = exportFlowAsPlaywright({ name: 'Safe checkout', steps: [
    { action: 'navigate', type: 'navigation', page: 'http://localhost:3000/checkout?token=private' },
    { action: 'fill', selector: '#email', label: 'Email', value: 'private@example.com', sensitive: false },
    { action: 'fill', selector: '#password', label: 'Password', value: 'secret', sensitive: true },
    { action: 'click', selector: '#continue' },
    { type: 'assertion', action: 'assertVisible', selector: '#confirmation', value: '' },
  ] });
  assert.match(code, /Selector drift at recorded step 2/);
  assert.match(code, /UIDIT_FLOW_VALUE_1/);
  assert.doesNotMatch(code, /private@example\.com|secret|token=private/);
  assert.match(code, /\.toHaveCount\(1\)/);
  assert.match(code, /toBeVisible/);
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

test('concurrent writers never discard each other\'s records', async () => {
  // The overlay and an agent are separate processes doing read-modify-write on
  // one file. Without the session lock the second write silently drops the
  // first writer's comment -- the user's feedback is lost.
  const cwd = tmpProject();
  store.init(cwd, { force: true });
  const element = store.upsertElement(cwd, { selector: '.card', tag: 'div', text: 'Card', page: 'http://x/' }).id;
  const storeUrl = new URL('../src/server/store.js', import.meta.url).href;
  const rounds = 25;
  const worker = (tag) => `
    const store = await import(${JSON.stringify(storeUrl)});
    for (let i = 0; i < ${rounds}; i++) {
      store.addComment(${JSON.stringify(cwd)}, { elementId: ${JSON.stringify(element)}, text: ${JSON.stringify(tag)}, page: null, attachments: [] });
    }
  `;
  const run = (tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker(tag)], { stdio: 'ignore' });
    child.on('exit', resolve);
  });
  await Promise.all([run('A'), run('B')]);
  const comments = store.readSession(cwd).comments;
  assert.equal(comments.filter((comment) => comment.text === 'A').length, rounds);
  assert.equal(comments.filter((comment) => comment.text === 'B').length, rounds);
});

test('withSession releases the lock when the update throws', () => {
  const cwd = tmpProject();
  store.init(cwd, { force: true });
  assert.throws(() => store.withSession(cwd, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(path.join(cwd, '.uidit', 'session.lock')), false);
  assert.equal(store.withSession(cwd, () => 'recovered'), 'recovered');
});
