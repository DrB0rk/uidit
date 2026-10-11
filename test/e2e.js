/** Browser-level coverage for the current workspace, overlay and review flows. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { server as fixture } from './fixtures/demo-site.js';
import { init } from '../src/server/store.js';

const ROOT = '/tmp/uidit-e2e';
const UIDIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PORT = 4602;
const { chromium } = await import('playwright');
const BROWSER_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
init(ROOT);
fixture.listen(FIXTURE_PORT, '127.0.0.1');
const probe = await import('node:net');
const portServer = probe.createServer();
const DASH = await new Promise((resolve) => portServer.listen(0, '127.0.0.1', () => { const p = portServer.address().port; portServer.close(() => resolve(p)); }));
const dash = spawn('node', [`${UIDIT}/bin/uidit.js`, 'start', String(DASH)], { cwd: ROOT, stdio: 'inherit' });
let b;
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${DASH}/api/state`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  b = await chromium.launch({ executablePath: BROWSER_PATH });
  const page = await b.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${DASH}/?workspace=1`);
  await page.locator('.workspace-drawer').waitFor();
  await page.locator('.target').fill(`http://127.0.0.1:${FIXTURE_PORT}`);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('iframe.immersive-preview').waitFor();
  await page.waitForFunction(() => document.querySelector('iframe.immersive-preview')?.getAttribute('src')?.includes('/proxy/'));
  let frame;
  for (let i = 0; i < 60 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('/proxy/'));
    if (!frame) await page.waitForTimeout(200);
  }
  assert.ok(frame, `proxied preview frame did not load: ${JSON.stringify({ src: await page.locator('iframe.immersive-preview').getAttribute('src'), frames: page.frames().map((f) => f.url()) })}`);
  await frame.locator('#uidit-context-menu').waitFor({ state: 'attached', timeout: 10000 });

  // Floating control expands, exposes grouped actions, and toggles closed.
  const floating = page.frames().find((f) => f.url().includes('/floating?'));
  assert.ok(floating, 'floating control frame did not load');
  await floating.locator('.fab').click();
  await floating.locator('.menu.open').waitFor();
  assert.equal(await floating.locator('.action-section').count(), 3);
  await floating.locator('.fab').click();
  await floating.locator('.menu.open').waitFor({ state: 'hidden' });
  const floatingFrame = frame.locator('iframe[data-uidit-ui]');
  const floatingBefore = await floatingFrame.boundingBox();
  const fabBox = await floating.locator('.fab').boundingBox();
  await page.mouse.move(fabBox.x + 24, fabBox.y + 24);
  await page.mouse.down();
  await page.mouse.move(fabBox.x + 700, fabBox.y - 700, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const floatingAfter = await floatingFrame.boundingBox();
  assert.ok(Math.abs(floatingAfter.x - floatingBefore.x) > 50, 'dragging should move the floating control iframe');

  // Inspection tags an element; comment and quick style edit persist.
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await frame.locator('#pay').click();
  await page.waitForFunction(() => !!document.querySelector('#sel-selector')?.textContent.trim());
  assert.match(await page.locator('#sel-selector').innerText(), /pay|BUTTON/i);
  await page.locator('[data-testid="comment"]').fill('Make this button full width on mobile.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByText('Make this button full width on mobile.').waitFor();
  await page.locator('details.tools summary').click();
  await page.locator('[data-testid="style-prop"]').fill('padding');
  await page.locator('[data-testid="style-val"]').fill('16px');
  await page.locator('details.tools').getByRole('button', { name: 'Apply' }).click();
  await frame.waitForFunction(() => getComputedStyle(document.querySelector('#pay')).padding === '16px');
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.edits.some((edit) => edit.property === 'padding' && edit.after === '16px'));
  assert.equal(await frame.locator('#pay').evaluate((el) => getComputedStyle(el).padding), '16px');

  // Context menu comment attaches to the right-clicked heading.
  await frame.locator('h1').click({ button: 'right' });
  await frame.locator('[data-context-action="comment"]').click();
  await frame.locator('#uidit-context-note').fill('Give the heading more breathing room.');
  await frame.locator('[data-context-action="post"]').click();
  await page.getByText('Give the heading more breathing room.').waitFor();
  assert.equal(await frame.locator('#uidit-context-menu').isHidden(), true);
  await frame.locator('.uidit-comment-marker').nth(1).waitFor();
  await frame.locator('.uidit-comment-marker').nth(1).click();
  const markerThread = frame.locator('.uidit-comment-thread').nth(1);
  await markerThread.locator('textarea[aria-label="Reply to comment"]').fill('Can you confirm the preferred spacing?');
  await markerThread.getByRole('button', { name: 'Reply' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.replies?.some((r) => r.text === 'Can you confirm the preferred spacing?')));

  // Agent replies use the authenticated MCP tool and appear in the same thread.
  const permissionResponse = await fetch(`http://127.0.0.1:${DASH}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` }, body: JSON.stringify({ mcp: { allowAgentWrites: true } }) });
  const permissionPayload = await permissionResponse.json();
  assert.equal(permissionResponse.status, 200, JSON.stringify(permissionPayload));
  assert.equal(permissionPayload.config?.mcp?.allowAgentWrites, true, JSON.stringify(permissionPayload));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { readMcpToken } = await import('../src/server/mcp/server.js');
  const client = new Client({ name: 'uidit-e2e-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${DASH}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${readMcpToken(ROOT)}` } } }));
  const headingComment = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8')).comments.find((c) => c.text === 'Give the heading more breathing room.');
  const agentReply = await client.callTool({ name: 'uidit_reply_comment', arguments: { id: headingComment.id, text: 'I can adjust it. Is 24px appropriate?' } });
  assert.equal(Boolean(agentReply.isError), false, JSON.stringify(agentReply));
  await client.close();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.replies?.some((r) => r.author === 'agent')));
  const commentCard = page.locator('.item').filter({ hasText: 'Give the heading more breathing room.' });
  await commentCard.getByText('I can adjust it. Is 24px appropriate?').waitFor();
  await commentCard.getByRole('button', { name: 'Reply', exact: true }).click();
  await commentCard.getByRole('textbox', { name: 'Reply to comment' }).fill('Yes, please match the card spacing.');
  await commentCard.getByRole('button', { name: 'Send reply' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.replies?.some((r) => r.text === 'Yes, please match the card spacing.')));

  // Page context offers page-only actions and stores a page-level note.
  await frame.evaluate(() => document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 700 })));
  assert.match(await frame.locator('#uidit-context-menu').innerText(), /Add page note/);
  assert.doesNotMatch(await frame.locator('#uidit-context-menu').innerText(), /Inspect this element/);
  await frame.locator('[data-context-action="comment"]').click();
  await frame.locator('#uidit-context-note').fill('The page should explain delivery timing.');
  await frame.locator('[data-context-action="post"]').click();
  await page.getByText('The page should explain delivery timing.').waitFor();

  // Draw an arrow and confirm its normalized annotation is saved.
  await frame.locator('h2').first().click({ button: 'right' });
  await frame.locator('[data-context-action="draw-arrow"]').click();
  const canvas = frame.locator('svg[style*="crosshair"]');
  await canvas.waitFor();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 80, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 310, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.drawing?.type === 'arrow'));

  // Each workspace section opens, and settings can be saved.
  for (const label of ['Elements', 'Changes', 'Server', 'Agents', 'Settings']) {
    await page.locator('.workspace-tabs').getByRole('button', { name: new RegExp(`^${label}`) }).click();
    await page.locator('.workspace-content').waitFor();
  }
  await page.locator('#uidit-position').selectOption('bottom-right');
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).config.ui.position === 'bottom-right');
  await page.locator('.workspace-tabs').getByRole('button', { name: /^Feedback/ }).click();

  const state = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8'));
  assert.equal(state.elements.length, 2);
  assert.equal(state.comments.length, 4);
  assert.equal(state.comments.filter((c) => c.elementId).length, 2);
  assert.equal(state.comments.filter((c) => !c.elementId && !c.drawing).length, 1);
  assert.equal(state.comments.find((c) => c.drawing)?.drawing.type, 'arrow');
  const pageNote = state.comments.find((c) => c.text === 'The page should explain delivery timing.');
  assert.ok(pageNote.anchor && pageNote.anchor.x > 0.6 && pageNote.anchor.y > 0.6, 'right-click page note keeps its page location');
  assert.equal(state.comments.find((c) => c.text === 'Give the heading more breathing room.')?.replies.length, 3);
  assert.equal(await frame.locator('.uidit-comment-marker').count(), 3);
  assert.equal(state.edits.filter((e) => e.kind === 'style').length, 1);
  assert.equal(state.elements.find((e) => e.selector.includes('pay'))?.page, `http://127.0.0.1:${FIXTURE_PORT}/`);
  assert.deepEqual(errors, [], 'browser page errors');

  // Resolve/reopen a note and toggle preview-edit source provenance.
  await page.locator('.feedback-filters select').selectOption('all');
  const resolvedCard = page.locator('.item').filter({ hasText: 'Make this button full width on mobile.' });
  await resolvedCard.getByRole('button', { name: 'Resolve comment' }).click();
  await resolvedCard.locator('.tag').filter({ hasText: 'Resolved' }).waitFor();
  await resolvedCard.getByRole('button', { name: 'Reopen comment' }).click();
  await resolvedCard.locator('.tag').filter({ hasText: 'Open' }).waitFor();
  await page.locator('.workspace-tabs').getByRole('button', { name: /^Changes/ }).click();
  page.once('dialog', (dialog) => dialog.accept('Applied the spacing to the source CSS and verified it.'));
  await page.locator('.item').filter({ hasText: '16px' }).getByRole('button', { name: 'Mark as applied in source' }).click();
  await page.locator('.item').filter({ hasText: '16px' }).getByText('applied in source').waitFor();
  await page.screenshot({ path: '/tmp/uidit-e2e.png' });
  console.log('  ok  current workspace, floating controls, inspect, comments, context actions, drawing, edits and preferences');
} finally {
  if (b) await b.close();
  dash.kill('SIGTERM');
  fixture.close();
}
