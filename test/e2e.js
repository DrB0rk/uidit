/**
 * End-to-end smoke test: drives the real dashboard in Chromium against a fixture
 * dev server, then asserts the .uidit/session.json the agent would read.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { server as fixture } from './fixtures/demo-site.js';
import { init } from '../src/server/store.js';

const ROOT = '/tmp/uidit-e2e';
const UIDIT = '/home/drb0rk/Projects/uidit';
let DASH;

async function freePort() {
  const s = net.createServer();
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const FIXTURE_PORT = 4602;

const { chromium: browser } = await import('playwright');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
init(ROOT);

fixture.listen(FIXTURE_PORT, '127.0.0.1');
DASH = await freePort();
const dash = spawn('node', [`${UIDIT}/bin/uidit.js`, 'start', String(DASH)], { cwd: ROOT, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (err) { failures++; console.error(`  FAIL ${label}: ${err.message}`); }
};

try {
  const b = await browser.launch();
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // uidit no longer guesses a target, so connect the way the dashboard does.
  await page.goto(`http://127.0.0.1:${DASH}/`);
  await page.fill('.target', `http://127.0.0.1:${FIXTURE_PORT}`);
  await page.click('button:has-text("Connect")');
  await page.waitForSelector('iframe#preview.live', { timeout: 10000 });

  // The preview loads through the proxy and the overlay boots.
  await page.waitForFunction(() => document.querySelector('iframe#preview')?.contentWindow?.__uiditOverlay === true, { timeout: 8000 });

  const frame = page.frames().find((f) => f.url().includes('/proxy/'));
  await frame.click('#pay');
  await page.waitForSelector('#sel-selector:not(:empty)');

  const selectedSelector = await page.textContent('#sel-selector');
  check('element tagged with selector', () => assert.match(selectedSelector, /pay|BUTTON/i));

  await page.fill('#comment', 'Make this button full width on mobile.');
  await page.click('#comment-send');
  await page.waitForSelector('.item .item-text');

  await page.click('details.tools summary');
  await page.fill('#style-prop', 'padding');
  await page.fill('#style-val', '16px');
  await page.click('details.tools button:has-text("Apply")');
  await page.waitForSelector('[data-panel="edits"], .tab:has-text("Edits (1)")');

  await page.click('.tab:has-text("Edits")');
  await page.waitForSelector('.item .diff-after');

  const previewPadding = await frame.locator('#pay').evaluate((el) => getComputedStyle(el).padding);
  check('style applied in preview', () => assert.equal(previewPadding, '16px'));

  const session = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8'));
  check('session.json has 1 element', () => assert.equal(session.elements.length, 1));
  check('session.json has 1 comment', () => assert.equal(session.comments.length, 1));
  check('comment text persisted', () => assert.match(session.comments[0].text, /full width/));
  check('comment bound to element', () => assert.equal(session.comments[0].elementId, session.elements[0].id));
  check('session.json has the style edit', () => {
    const edit = session.edits.find((e) => e.kind === 'style');
    assert.ok(edit, 'no style edit recorded');
    assert.equal(edit.property, 'padding');
    assert.equal(edit.after, '16px');
  });
  check('element carries ancestors for the agent', () => assert.ok(session.elements[0].ancestors.length > 0));
  check('page recorded as the real dev URL, not the proxy', () =>
    assert.equal(session.elements[0].page, `http://127.0.0.1:${FIXTURE_PORT}/`));
  check('comment page recorded as the real dev URL', () =>
    assert.equal(session.comments[0].page, `http://127.0.0.1:${FIXTURE_PORT}/`));
  check('selected element attributes exclude uidit outline styles', () =>
    assert.equal(session.elements[0].attributes.style, undefined));
  check('agent README written', () => assert.ok(fs.existsSync(`${ROOT}/.uidit/README.md`)));

  // Live sync: an agent resolving a comment externally must reach the UI via SSE.
  const s = JSON.parse(fs.readFileSync(`${ROOT}/.uidit/session.json`, 'utf8'));
  s.comments[0].resolved = true;
  fs.writeFileSync(`${ROOT}/.uidit/session.json`, JSON.stringify(s, null, 2));
  await page.click('.tab:has-text("Feedback")');
  await page.waitForSelector('.item.resolved', { timeout: 5000 });
  check('external agent edit syncs over SSE', () => assert.ok(true));

  check('no page errors', () => assert.deepEqual(errors, []));

  await page.screenshot({ path: '/tmp/uidit-e2e.png' });
  await b.close();
} finally {
  dash.kill('SIGTERM');
  fixture.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);