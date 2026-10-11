/**
 * Cross-stack check: the same uidit instance, pointed at dev servers shaped
 * differently from one another (chunked HTML + root-absolute assets, IPv6-only
 * bind, redirect + hashed bundles + JSON API). The preview must render and the
 * overlay must tag elements in every case.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { init } from '../src/server/store.js';
import { chromium } from 'playwright';
import { reactServer } from './fixtures/react-site.js';

const ROOT = '/tmp/uidit-stacks';
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

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
init(ROOT);

function chunkedServer({ host = '127.0.0.1', port = 0 } = {}) {
  const html = '<!doctype html><html><head><title>Chunked</title></head><body>'
    + '<script type="module" src="/@vite/client"></script>'
    + '<main><h1>Chunked App</h1><button id="go">Go</button></main></body></html>';
  const server = http.createServer((req, res) => {
    if (req.url === '/@vite/client') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('export const hot = 1;');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write(html.slice(0, 15));
    res.end(html.slice(15));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port: server.address().port })));
}

const http = await import('node:http');

const v6 = await chunkedServer({ host: '::1' });
const react = await reactServer();
const logFile = fs.openSync('/tmp/uidit-stacks/dash.log', 'w');
DASH = await freePort();
const dash = spawn('node', [`${UIDIT}/bin/uidit.js`, 'start', String(DASH)], { cwd: ROOT, stdio: ['ignore', logFile, logFile] });
// Wait for the dashboard to answer, not for a fixed delay.
for (let i = 0; i < 60; i++) {
  const up = await fetch(`http://127.0.0.1:${DASH}/api/state`).then((r) => r.ok).catch(() => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 250));
}

const targets = [
  { name: 'ipv6-only + chunked + root-absolute assets', url: `http://localhost:${v6.port}`, expect: 'Go' },
  { name: 'react: redirect + hashed bundle + JSON API', url: `http://127.0.0.1:${react.port}`, expect: 'Buy now' },
];

let failures = 0;
const b = await chromium.launch();
try {
  for (const target of targets) {
    // A fresh page per target: reusing one carries the previous frame and the
    // previous island's state into the next assertion.
    const page = await b.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.log('   [pageerror]', e.message); });

    const set = await fetch(`http://127.0.0.1:${DASH}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUrl: target.url }),
    });
    assert.equal(set.status, 200, 'could not set target');

    await page.goto(`http://127.0.0.1:${DASH}/`);
    await page.waitForSelector('iframe#preview.live', { timeout: 10000 });
    await page.waitForTimeout(1200);

    const frame = page.frames().find((f) => f.url().includes('/proxy'));
    const text = frame ? await frame.evaluate(() => document.body.innerText) : '';
    const overlay = frame ? await frame.evaluate(() => !!window.__uiditOverlay) : false;

    try {
      assert.ok(frame, 'preview frame never loaded');
      assert.ok(overlay, 'overlay did not boot');
      assert.match(text, new RegExp(target.expect), `page did not render: ${text.slice(0, 80)}`);
      await frame.click('button');
      await page.waitForSelector('#sel-selector:not(:empty)', { timeout: 5000 });
      console.log(`  ok  ${target.name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL ${target.name}: ${err.message}`);
      console.error(`       frames: ${page.frames().map((f) => f.url()).join(' | ')}`);
      console.error(`       page state: ${JSON.stringify(await page.evaluate(() => fetch('/api/state').then((r) => r.json()).catch((e) => ({ err: e.message })))).slice(0, 160)}`);
      console.error(`       iframe class: ${await page.getAttribute('iframe#preview', 'class').catch(() => 'none')}`);
    }

    if (errors.length) {
      failures++;
      console.error(`  FAIL page errors on ${target.name}: ${errors.join(' | ')}`);
    }
    await page.close();
  }
} finally {
  await b.close();
  dash.kill('SIGTERM');
  v6.server.close();
  react.server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall stacks render');
process.exit(failures ? 1 : 0);