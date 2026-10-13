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

  // A team review invite can be created from the feedback sidebar without
  // leaving the page or visiting the Agents settings view.
  const shareCard = page.getByRole('region', { name: 'Share team review' });
  await shareCard.getByRole('button', { name: 'Create link' }).click();
  assert.match(await shareCard.locator('input[type="url"]').inputValue(), /^https:\/\//);
  await shareCard.getByPlaceholder('Paste ADMIN_SECRET').waitFor();
  assert.match(await shareCard.innerText(), /exposes the current preview/);
  assert.equal(await shareCard.getByRole('button', { name: 'Create share link' }).isDisabled(), true);
  await shareCard.getByRole('button', { name: 'Close' }).click();

  // Device presets change the actual browsing context, and reference matching
  // supports both an overlay and a side-by-side comparison.
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  const devicePhone = page.getByRole('button', { name: 'Phone' });
  await devicePhone.click();
  await page.waitForTimeout(200);
  frame = page.frames().find((f) => f.url().includes('/proxy/'));
  const phoneViewport = await frame.evaluate(() => innerWidth);
  assert.ok(phoneViewport >= 380 && phoneViewport <= 400, `phone preview width: ${phoneViewport}`);
  const phoneHeight = await frame.evaluate(() => innerHeight);
  assert.ok(phoneHeight >= 830 && phoneHeight <= 860, `phone preview height: ${phoneHeight}`);
  await page.getByRole('button', { name: 'Tablet' }).click();
  await page.waitForTimeout(200);
  frame = page.frames().find((f) => f.url().includes('/proxy/'));
  const tabletViewport = await frame.evaluate(() => innerWidth);
  assert.ok(tabletViewport >= 760 && tabletViewport <= 768, `tablet preview width: ${tabletViewport}`);
  const tabletHeight = await frame.evaluate(() => innerHeight);
  assert.ok(tabletHeight >= 1000 && tabletHeight <= 1040, `tablet preview height: ${tabletHeight}`);
  await page.getByRole('button', { name: 'Desktop' }).click();
  assert.equal(await page.locator('.preview-live-frame iframe').count(), 1, 'the preview is a single view');
  assert.equal(await page.getByRole('button', { name: '2 views' }).count(), 0, 'the view-count controls are gone');
  await page.getByLabel('Custom viewport width').fill('360');
  await page.getByLabel('Custom viewport height').fill('740');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.preview-live-frame')?.getBoundingClientRect().width <= 361);
  await page.getByRole('button', { name: 'Desktop' }).click();
  const referencePng = await page.screenshot({ type: 'png' });
  await page.locator('.reference-drop input').setInputFiles({ name: 'review-reference.png', mimeType: 'image/png', buffer: referencePng });
  await page.locator('.reference-card img').waitFor();
  await page.locator('.reference-mode select').selectOption('side');
  await page.locator('.preview-reference-side img').waitFor();
  await page.getByRole('button', { name: 'Remove' }).click();

  // Floating control expands, exposes grouped actions, and toggles closed.
  const floating = page.frames().find((f) => f.url().includes('/floating?'));
  assert.ok(floating, 'floating control frame did not load');
  const themeToggle = page.getByRole('button', { name: 'Switch to light mode' });
  await themeToggle.click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await floating.waitForFunction(() => document.body.classList.contains('theme-light'));
  const lightSidebar = await page.locator('.workspace-drawer').evaluate((el) => getComputedStyle(el).backgroundColor);
  const lightFrame = await page.locator('.preview-live-frame').evaluate((el) => getComputedStyle(el).outlineColor);
  await floating.waitForFunction(() => getComputedStyle(document.querySelector('.fab')).backgroundColor === 'rgb(255, 255, 255)');
  const lightButton = await floating.locator('.fab').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(lightFrame, lightSidebar, 'preview frame should blend into the sidebar surface');
  assert.match(lightButton, /rgb\(255, 255, 255\)/, 'floating button should use the light theme');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await floating.waitForFunction(() => !document.body.classList.contains('theme-light'));
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
  await page.getByRole('button', { name: /Feedback/ }).click();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await frame.locator('#pay').click();
  await page.waitForFunction(() => !!document.querySelector('#sel-selector')?.textContent.trim());
  assert.match(await page.locator('#sel-selector').innerText(), /pay|BUTTON/i);
  await page.locator('[data-testid="comment"]').fill('Make this button full width on mobile.');
  await page.evaluate(async (base64) => {
    const binary = atob(base64); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const file = new File([bytes], 'pasted-reference.png', { type: 'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    document.querySelector('[data-testid="comment"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, referencePng.toString('base64'));
  await page.locator('.comment-photo-thumb img').waitFor();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByText('Make this button full width on mobile.').waitFor();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((comment) => comment.text === 'Make this button full width on mobile.' && comment.attachments?.length === 1));
  await page.locator('details.tools summary').click();
  await page.locator('[data-testid="style-prop"]').fill('padding');
  await page.locator('[data-testid="style-val"]').fill('16px');
  await page.locator('details.tools').getByRole('button', { name: 'Apply' }).click();
  await frame.waitForFunction(() => getComputedStyle(document.querySelector('#pay')).padding === '16px');
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.edits.some((edit) => edit.property === 'padding' && edit.after === '16px'));
  assert.equal(await frame.locator('#pay').evaluate((el) => getComputedStyle(el).padding), '16px');
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  // Reselect through page inspection so the overlay has the live element handle.
  await page.getByRole('button', { name: /Feedback/ }).click();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await frame.locator('#pay').click();
  await page.waitForFunction(() => !!document.querySelector('#sel-selector')?.textContent.trim());
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await frame.evaluate(() => { window.__UIDIT_STATE_FIXTURES__ = { loading(element) { element.dataset.uiditState = 'loading'; return () => { delete element.dataset.uiditState; }; } }; });
  await page.getByRole('button', { name: 'Loading', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('#pay')?.dataset.uiditState === 'loading');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await frame.waitForFunction(() => !document.querySelector('#pay')?.dataset.uiditState);
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await frame.waitForFunction(() => document.activeElement?.id === 'pay');
  await page.getByRole('button', { name: 'Disabled', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('#pay')?.disabled === true);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('#pay')?.disabled === false);
  const previewProposal = async (operation, changes) => page.evaluate(({ operation, changes }) => document.querySelector('iframe.immersive-preview').contentWindow.postMessage({ source: 'uidit-dashboard', type: 'proposalPreview', operation, changes }, '*'), { operation, changes });
  const resetProposal = async () => page.evaluate(() => document.querySelector('iframe.immersive-preview').contentWindow.postMessage({ source: 'uidit-dashboard', type: 'proposalReset' }, '*'));
  await previewProposal('style', [{ property: 'border-radius', value: '11px' }]);
  await frame.waitForFunction(() => document.querySelector('#pay')?.style.borderRadius === '11px');
  await resetProposal();
  await frame.waitForFunction(() => document.querySelector('#pay')?.style.borderRadius !== '11px');
  await previewProposal('text', [{ property: 'text', value: 'Preview only' }]);
  await frame.waitForFunction(() => document.querySelector('#pay')?.textContent === 'Preview only');
  await resetProposal();
  await frame.waitForFunction(() => document.querySelector('#pay')?.textContent !== 'Preview only');
  await previewProposal('class', [{ property: 'class', value: 'uidit-proposal-check' }]);
  await frame.waitForFunction(() => document.querySelector('#pay')?.classList.contains('uidit-proposal-check'));
  await resetProposal();
  await frame.waitForFunction(() => !document.querySelector('#pay')?.classList.contains('uidit-proposal-check'));
  await previewProposal('attribute', [{ property: 'title', value: 'Preview only' }]);
  await frame.waitForFunction(() => document.querySelector('#pay')?.getAttribute('title') === 'Preview only');
  await resetProposal();
  await frame.waitForFunction(() => document.querySelector('#pay')?.getAttribute('title') !== 'Preview only');
  await page.getByRole('button', { name: 'Compare all four on page' }).click();
  const variantComparison = frame.locator('#uidit-variant-compare');
  await variantComparison.waitFor();
  assert.equal(await variantComparison.locator('article').count(), 4, 'comparison should show all four live directions');
  await variantComparison.getByRole('button', { name: 'Apply Soft card' }).click();
  await frame.waitForFunction(() => document.querySelector('#pay')?.style.borderRadius === '16px');
  await page.getByRole('button', { name: 'Undo preview' }).click();
  await frame.waitForFunction(() => !document.querySelector('#pay')?.style.borderRadius);
  // Context menu comment attaches to the right-clicked heading.
  await frame.locator('h1').click({ button: 'right' });
  await frame.locator('[data-context-action="comment"]').click();
  await frame.locator('#uidit-context-note').fill('Give the heading more breathing room.');
  await frame.locator('[data-context-action="post"]').click();
  await page.getByRole('button', { name: /Feedback/ }).click();
  await page.getByText('Give the heading more breathing room.').waitFor();
  assert.equal(await frame.locator('#uidit-context-menu').isHidden(), true);
  const headingMarker = frame.locator('.uidit-comment-marker[title="Give the heading more breathing room."]');
  await headingMarker.waitFor();
  await headingMarker.click();
  const markerThread = frame.locator('.uidit-comment-thread').filter({ hasText: 'Give the heading more breathing room.' }).first();
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
  const briefResult = await client.callTool({ name: 'uidit_get_agent_brief', arguments: { focus: 'breathing room', limit: 10 } });
  assert.equal(Boolean(briefResult.isError), false, JSON.stringify(briefResult));
  const brief = briefResult.structuredContent;
  assert.equal(brief.feedback.length, 1);
  assert.equal(brief.feedback[0].id, headingComment.id);
  assert.match(brief.feedback[0].element.selector, /h1/);
  assert.ok(Array.isArray(brief.agentGuidance));
  const briefResource = await client.readResource({ uri: 'uidit://agent/brief' });
  assert.ok(JSON.parse(briefResource.contents[0].text).feedback.length > 0);
  const promptList = await client.listPrompts();
  assert.ok(promptList.prompts.some((prompt) => prompt.name === 'uidit_work_on_feedback'));
  const prompt = await client.getPrompt({ name: 'uidit_work_on_feedback', arguments: { focus: 'breathing room' } });
  assert.match(prompt.messages[0].content.text, /uidit_reply_comment/);
  assert.match(prompt.messages[0].content.text, /breathing room/);
  const codeLink = await client.callTool({ name: 'uidit_link_code', arguments: { commentId: headingComment.id, file: 'src/components/Checkout.tsx', startLine: 18, endLine: 24 } });
  assert.equal(Boolean(codeLink.isError), false, JSON.stringify(codeLink));
  const latestRevision = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8')).revision;
  const statusUpdate = await client.callTool({ name: 'uidit_update_comment', arguments: { id: headingComment.id, status: 'in_progress', expectedRevision: latestRevision } });
  assert.equal(Boolean(statusUpdate.isError), false, JSON.stringify(statusUpdate));
  const triage = await client.callTool({ name: 'uidit_triage_feedback', arguments: {} });
  assert.equal(Boolean(triage.isError), false, JSON.stringify(triage));
  assert.ok(triage.structuredContent.suggestedOrder.some((item) => item.id === headingComment.id));
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.replies?.some((r) => r.author === 'agent')));
  const commentCard = page.locator('.item').filter({ hasText: 'Give the heading more breathing room.' });
  await commentCard.getByText('I can adjust it. Is 24px appropriate?').waitFor();
  await commentCard.getByText('src/components/Checkout.tsx:18–24').waitFor();
  await commentCard.getByRole('combobox', { name: 'Feedback status' }).selectOption('needs_info');
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.text === 'Give the heading more breathing room.' && c.status === 'needs_info'));
  await commentCard.getByRole('button', { name: 'Reply', exact: true }).click();
  await commentCard.getByRole('textbox', { name: 'Reply to comment' }).fill('Yes, please match the card spacing.');
  await commentCard.getByRole('button', { name: 'Send reply' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.comments.some((c) => c.replies?.some((r) => r.text === 'Yes, please match the card spacing.')));

  const createdTask = await client.callTool({ name: 'uidit_create_task', arguments: { title: 'Verify heading spacing', commentIds: [headingComment.id] } });
  assert.equal(Boolean(createdTask.isError), false, JSON.stringify(createdTask));
  const taskId = createdTask.structuredContent.task.id;
  const claimedTask = await client.callTool({ name: 'uidit_claim_task', arguments: { taskId, owner: 'e2e-agent', expectedRevision: 1 } });
  assert.equal(claimedTask.structuredContent.task.status, 'in_progress');
  const taskEvidence = await client.callTool({ name: 'uidit_attach_evidence', arguments: { taskId, type: 'test', result: 'passed', summary: 'Spacing regression check passed' } });
  assert.equal(Boolean(taskEvidence.isError), false, JSON.stringify(taskEvidence));
  const implementedTask = await client.callTool({ name: 'uidit_update_task', arguments: { taskId, expectedRevision: 3, status: 'implemented', changedFiles: ['src/components/Heading.jsx'], detail: 'Updated heading spacing' } });
  assert.equal(implementedTask.structuredContent.task.status, 'implemented');
  const verifiedTask = await client.callTool({ name: 'uidit_update_task', arguments: { taskId, expectedRevision: 4, status: 'verified', detail: 'Regression check passed' } });
  assert.equal(verifiedTask.structuredContent.task.status, 'verified');
  const acceptTask = await fetch(`http://127.0.0.1:${DASH}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` }, body: JSON.stringify({ expectedRevision: 5, status: 'accepted' }) });
  const acceptedPayload = await acceptTask.json();
  assert.equal(acceptedPayload.task?.status, 'accepted', JSON.stringify(acceptedPayload));
  const impact = await client.callTool({ name: 'uidit_get_impact_graph', arguments: {} });
  assert.equal(Boolean(impact.isError), false, JSON.stringify(impact));
  assert.ok(impact.structuredContent.impact.coverage.observedElements > 0);
  const blockedDom = await client.callTool({ name: 'uidit_get_live_dom', arguments: {} });
  assert.equal(blockedDom.isError, true, 'live DOM stays unavailable until the user opts in');
  const inspectPermission = await fetch(`http://127.0.0.1:${DASH}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` }, body: JSON.stringify({ ui: { allowBrowserInspection: true } }) });
  assert.equal(inspectPermission.status, 200);
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).browserContext?.nodes?.length > 0);
  const liveDom = await client.callTool({ name: 'uidit_get_live_dom', arguments: {} });
  assert.equal(Boolean(liveDom.isError), false, JSON.stringify(liveDom));
  assert.ok(liveDom.structuredContent.nodes.some((node) => node.selector.includes('h1')));
  const blockedControl = await client.callTool({ name: 'uidit_browser_action', arguments: { type: 'hover', selector: '#pay' } });
  assert.equal(blockedControl.isError, true, 'browser control has its own opt-in');
  const controlPermission = await fetch(`http://127.0.0.1:${DASH}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` }, body: JSON.stringify({ mcp: { allowBrowserControl: true } }) });
  assert.equal(controlPermission.status, 200);
  const controlled = await client.callTool({ name: 'uidit_browser_action', arguments: { type: 'hover', selector: '#pay' } });
  assert.equal(Boolean(controlled.isError), false, JSON.stringify(controlled));
  for (const captureType of ['baseline', 'candidate']) {
    const capture = await fetch(`http://127.0.0.1:${DASH}/api/tasks/${encodeURIComponent(taskId)}/captures/${captureType}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` }, body: '{}' });
    const captured = await capture.json();
    assert.equal(capture.status, 201, JSON.stringify(captured));
    assert.match(captured.evidence.reference, /^\.uidit\/artifacts\/browser-/);
    const image = await fetch(`http://127.0.0.1:${DASH}/api/artifacts/${captured.evidence.reference.split('/').at(-1)}`);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.ok((await image.arrayBuffer()).byteLength > 100);
  }
  await fetch(`http://127.0.0.1:${DASH}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` }, body: JSON.stringify({ ui: { allowBrowserInspection: false }, mcp: { allowBrowserControl: false } }) });
  await client.close();

  // Page context offers page-only actions and stores a page-level note.
  await frame.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight - innerHeight);
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1000, clientY: 700 }));
  });
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

  // Record a real preview action with a screenshot, stop, then replay it.
  await page.locator('.workspace-tabs').getByRole('button', { name: /^Flows/ }).click();
  await page.locator('#uidit-flow-name').fill('Checkout button smoke flow');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForTimeout(150);
  // Dispatch on the page body so an existing visual comment marker does not
  // intercept the browser pointer before the recording handler sees it.
  await frame.locator('.card p').first().evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).session.flows?.some((flow) => flow.steps.length > 0));
  await page.getByLabel('CSS selector').fill('#pay');
  await page.getByRole('button', { name: 'Add assertion' }).click();
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await page.getByRole('button', { name: 'Replay flow' }).click();
  await page.locator('.flow-result').waitFor({ timeout: 10000 });
  assert.equal((await page.locator('.flow-result').innerText()).split('\n')[0], 'Passed 2 step(s)', await page.locator('.flow-result').innerText());
  const recordedFlow = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8')).flows[0];
  assert.equal(recordedFlow.status, 'recorded');
  assert.equal(recordedFlow.steps[0].type, 'click');
  assert.equal(recordedFlow.steps[1].type, 'assertion');
  assert.ok(recordedFlow.steps[0].screenshotUrl, 'recorded step should include a page screenshot');
  const flowScreenshot = await fetch(`http://127.0.0.1:${DASH}${recordedFlow.steps[0].screenshotUrl}`);
  assert.equal(flowScreenshot.status, 200);
  assert.match(flowScreenshot.headers.get('content-type'), /image\/jpeg/);
  assert.ok((await flowScreenshot.arrayBuffer()).byteLength > 1000);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Playwright test' }).click();
  const exportedTest = await downloadPromise;
  assert.match(exportedTest.suggestedFilename(), /Checkout-button-smoke-flow\.spec\.js/);

  // Each workspace section opens, and settings can be saved.
  // Every section is one click away: the drawer's nav lists all of them.
  assert.equal(await page.locator('.workspace-tabs button').count(), 8, 'every workspace section is visible without a menu');
  assert.equal(await page.locator('.workspace-more').count(), 0, 'no section menu is left to hunt through');
  for (const label of ['Elements', 'Changes', 'Server', 'Agents', 'Settings']) {
    await page.locator('.workspace-tabs').getByRole('button', { name: new RegExp(`^${label}`) }).click();
    await page.locator('.workspace-content').waitFor();
  }
  await page.locator('.workspace-tabs').getByRole('button', { name: /^Server/ }).click();
  await page.getByText('Configure services', { exact: true }).click();
  const managedServiceCommand = "const h=require('node:http');const s=h.createServer((q,r)=>r.end('service'));s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port))";
  await page.getByLabel('Services JSON').fill(JSON.stringify([{ id: 'api', name: 'Test API', command: ['node', '-e', managedServiceCommand], cwd: '.', dependencies: [] }]));
  await page.getByRole('button', { name: 'Save services' }).click();
  await page.getByRole('button', { name: 'Start all' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/services')).json()).services[0]?.state === 'ready');
  const primaryTarget = await page.evaluate(async () => (await (await fetch('/api/state')).json()).config.targetUrl);
  await page.getByRole('button', { name: 'Preview Test API' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).config.targetUrl?.includes('127.0.0.1:'));
  const serviceTarget = await page.evaluate(async () => (await (await fetch('/api/state')).json()).config.targetUrl);
  assert.notEqual(serviceTarget, primaryTarget, 'service preview should switch the active target');
  await page.getByRole('button', { name: 'Stop owned services' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/services')).json()).services[0]?.state === 'stopped');
  await page.evaluate(async (targetUrl) => fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetUrl }) }), primaryTarget);
  await page.reload();
  for (let i = 0; i < 60 && !page.frames().some((item) => item.url().includes('/proxy/')); i++) await page.waitForTimeout(100);
  frame = page.frames().find((item) => item.url().includes('/proxy/'));
  assert.ok(frame, 'primary preview should reload after switching back from the service');
  await page.locator('.workspace-tabs').getByRole('button', { name: /^Settings/ }).click();
  await page.locator('#uidit-position').selectOption('bottom-right');
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).config.ui.position === 'bottom-right');
  await page.locator('.workspace-tabs').getByRole('button', { name: /^Feedback/ }).click();

  const state = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8'));
  assert.ok(state.elements.length >= 2);
  const headingElement = state.elements.find((element) => /h1/.test(element.selector));
  assert.ok(headingElement?.accessibleName);
  assert.ok(headingElement?.nearbyText);
  assert.equal(state.comments.length, 4);
  assert.equal(state.comments.filter((c) => c.elementId).length, 2);
  assert.equal(state.comments.filter((c) => !c.elementId && !c.drawing).length, 1);
  assert.equal(state.comments.find((c) => c.drawing)?.drawing.type, 'arrow');
  const pageNote = state.comments.find((c) => c.text === 'The page should explain delivery timing.');
  assert.ok(pageNote.anchor && pageNote.anchor.x > 0.6 && pageNote.anchor.y > 0.6, 'right-click page note keeps its page location');
  assert.equal(state.comments.find((c) => c.text === 'Give the heading more breathing room.')?.replies.length, 3);
  assert.equal(state.comments.find((c) => c.text === 'Give the heading more breathing room.')?.status, 'needs_info');
  assert.equal(state.comments.find((c) => c.text === 'Give the heading more breathing room.')?.codeRefs[0]?.file, 'src/components/Checkout.tsx');
  assert.equal(await frame.locator('.uidit-comment-marker').count(), 3);
  assert.equal(state.edits.filter((e) => e.kind === 'style').length, 4, 'custom style edit and variant properties are recorded');
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
  const spacingEdit = page.locator('.item').filter({ has: page.locator('.item-selector', { hasText: 'padding' }) }).filter({ hasText: '16px' }).first();
  page.once('dialog', (dialog) => dialog.accept('Applied the spacing to the source CSS and verified it.'));
  await spacingEdit.getByRole('button', { name: 'Mark as applied in source' }).click();
  await spacingEdit.getByText('applied in source').waitFor();
  await page.screenshot({ path: '/tmp/uidit-e2e.png' });
  await page.reload();
  await page.locator('.workspace-drawer').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'theme preference should survive a dashboard reload');
  let reloadedControls;
  for (let i = 0; i < 50 && !reloadedControls; i++) {
    reloadedControls = page.frames().find((f) => f.url().includes('/floating?'));
    if (!reloadedControls) await page.waitForTimeout(100);
  }
  assert.ok(reloadedControls, 'floating controls should return after a dashboard reload');
  await reloadedControls.waitForFunction(() => document.body.dataset.theme === 'dark');
  console.log('  ok  current workspace, floating controls, inspect, comments, context actions, drawing, edits and preferences');
} finally {
  if (b) await b.close();
  dash.kill('SIGTERM');
  fixture.close();
}
