/**
 * Browser compatibility matrix against real dev servers. This exercises the
 * proxy and review overlay, not just whether a framework can serve HTML.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { init } from '../src/server/store.js';
import { chromium } from 'playwright';

const ROOT = '/tmp/uidit-stacks';
const UIDIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const servers = [];
const fixtureRoots = new Map();
let dash;

async function freePort() {
  const s = net.createServer();
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  }));
}

function writeFixture(name, files) {
  const root = path.join(ROOT, name);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

async function viteTarget(name, files, plugins = []) {
  const root = writeFixture(name, files);
  fixtureRoots.set(name, root);
  const server = await createViteServer({
    root,
    configFile: false,
    appType: 'spa',
    plugins,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: { clientPort: 0 } },
  });
  await server.listen();
  servers.push(() => server.close());
  return `http://127.0.0.1:${server.httpServer.address().port}`;
}

async function waitFor(url, processHandle, output) {
  for (let i = 0; i < 80; i++) {
    if (processHandle?.exitCode !== null && processHandle?.exitCode !== undefined) {
      throw new Error(`dev server exited (${processHandle.exitCode}): ${output()}`);
    }
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`dev server did not start: ${output()}`);
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
// Framework roots are isolated in /tmp, but use the exact versions installed
// for the UIDIT test run instead of pulling dependencies at test time.
fs.symlinkSync(path.join(UIDIT, 'node_modules'), path.join(ROOT, 'node_modules'), 'dir');
init(ROOT);

// Keep a non-Vite, streaming, IPv6-only target in the matrix too. It catches
// proxy behavior independent of the Vite dev client.
const http = await import('node:http');
const chunkedHtml = '<!doctype html><html><head><title>Chunked</title></head><body><main><h1>Chunked Node App</h1><button>Go</button></main></body></html>';
const chunked = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write(chunkedHtml.slice(0, 31));
  res.end(chunkedHtml.slice(31));
});
await new Promise((resolve) => chunked.listen(0, '::1', resolve));
servers.push(() => new Promise((resolve) => chunked.close(resolve)));

const targets = [
  { name: 'Node HTTP: IPv6 + chunked response', url: `http://localhost:${chunked.address().port}`, expect: 'Chunked Node App' },
  {
    name: 'Vite vanilla SPA: root assets + history fallback',
    url: await viteTarget('vanilla', {
      'index.html': '<div id="app"></div><script type="module" src="/src/main.js"></script>',
      'src/main.js': "document.querySelector('#app').innerHTML='<h1>Vite Vanilla App</h1><button>Go</button>'",
    }), expect: 'Vite Vanilla App',
  },
  {
    name: 'React 19 + Vite: JSX + HMR client + target API',
    url: await viteTarget('react', {
      'index.html': '<div id="root"></div><script type="module" src="/src/main.jsx"></script>',
      'src/main.jsx': "import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';function App(){const [api,setApi]=useState('loading');useEffect(()=>{fetch('/api/status').then(r=>r.json()).then(d=>setApi(d.source))},[]);return <main><h1>React Vite App</h1><button onClick={()=>document.querySelector('#status').textContent='React clicked'}>React action</button><p id='status'>ready</p><p>React API: {api}</p></main>}const root=window.__uiditReactRoot||(window.__uiditReactRoot=createRoot(document.getElementById('root')));root.render(<App/>);",
    }, [react(), {
      name: 'fixture-target-api',
      configureServer(server) {
        server.middlewares.use('/api/status', (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ source: 'target' })); });
      },
    }]), expect: 'React Vite App', action: 'React action',
    async afterLoad({ frame }) {
      await frame.getByText('React API: target').waitFor({ timeout: 10000 });
      const file = path.join(fixtureRoots.get('react'), 'src/main.jsx');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('React Vite App', 'React HMR Updated'));
      await frame.getByRole('heading', { name: 'React HMR Updated' }).waitFor({ timeout: 10000 });
    },
  },
  {
    name: 'Vue 3 + Vite: SFC + root assets',
    url: await viteTarget('vue', {
      'index.html': '<div id="app"></div><script type="module" src="/src/main.js"></script>',
      'src/main.js': "import{createApp}from'vue';import App from './App.vue';createApp(App).mount('#app')",
      'src/App.vue': '<template><main><h1>Vue Vite App</h1><button @click="count++">Vue action</button><p>{{ count }}</p></main></template><script setup>import{ref}from\'vue\';const count=ref(0)</script>',
    }, [vue()]), expect: 'Vue Vite App', action: 'Vue action',
  },
  {
    name: 'Svelte 5 + Vite: compiled component',
    url: await viteTarget('svelte', {
      'index.html': '<div id="app"></div><script type="module" src="/src/main.js"></script>',
      'src/main.js': "import{mount}from'svelte';import App from './App.svelte';mount(App,{target:document.getElementById('app')})",
      'src/App.svelte': '<main><h1>Svelte Vite App</h1><button onclick={() => count++}>Svelte action</button><p>{count}</p></main>{#snippet unused()}{/snippet}<script>let count=$state(0)</script>',
    }, [svelte()]), expect: 'Svelte Vite App', action: 'Svelte action',
  },
];

// Astro's own dev server covers its HTML transforms and file-based route system.
const astroRoot = writeFixture('astro', {
  'src/pages/index.astro': '<html><head><title>Astro App</title></head><body><main><h1>Astro App</h1><button id="astro-action">Astro action</button></main></body></html>',
  'src/pages/nested.astro': '<html><body><h1>Astro Nested Route</h1><button>Nested action</button></body></html>',
});
const astroPort = await freePort();
let astroOutput = '';
const astro = spawn(process.execPath, [path.join(UIDIT, 'node_modules/astro/bin/astro.mjs'), 'dev', '--ignore-lock', '--host', '127.0.0.1', '--port', String(astroPort), '--root', astroRoot], {
  cwd: UIDIT, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
astro.stdout.on('data', (d) => { astroOutput += d.toString(); });
astro.stderr.on('data', (d) => { astroOutput += d.toString(); });
servers.push(() => new Promise((resolve) => { astro.kill('SIGTERM'); astro.once('exit', resolve); setTimeout(resolve, 2000).unref(); }));
await waitFor(`http://127.0.0.1:${astroPort}/`, astro, () => astroOutput);
targets.push({ name: 'Astro dev server + file routes + nested route', url: `http://127.0.0.1:${astroPort}`, expect: 'Astro App', action: 'Astro action' });

const logFile = fs.openSync(path.join(ROOT, 'dash.log'), 'w');
const DASH = await freePort();
dash = spawn('node', [`${UIDIT}/bin/uidit.js`, 'start', String(DASH)], { cwd: ROOT, stdio: ['ignore', logFile, logFile] });
await waitFor(`http://127.0.0.1:${DASH}/api/state`, dash, () => 'uidit dashboard did not start');

let failures = 0;
const browser = await chromium.launch({ executablePath: BROWSER_PATH });
try {
  for (const target of targets) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const configured = await fetch(`http://127.0.0.1:${DASH}/api/config`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${DASH}` },
        body: JSON.stringify({ targetUrl: target.url }),
      });
      assert.equal(configured.status, 200, 'could not set target');
      await page.goto(`http://127.0.0.1:${DASH}/?workspace=1`);
      await page.waitForSelector('iframe.immersive-preview', { timeout: 10000 });
      let frame;
      for (let i = 0; i < 60 && !frame; i++) {
        frame = page.frames().find((f) => f.url().includes('/proxy/'));
        if (!frame) await page.waitForTimeout(200);
      }
      assert.ok(frame, 'preview frame never loaded');
      await frame.getByRole('heading', { name: target.expect }).waitFor({ timeout: 10000 });
      assert.equal(await frame.evaluate(() => !!window.__uiditOverlay), true, 'overlay did not boot');
      if (target.afterLoad) await target.afterLoad({ frame, page });
      await page.getByRole('button', { name: 'Inspect', exact: true }).click();
      const action = target.action ? frame.getByRole('button', { name: target.action }) : frame.getByRole('button');
      await action.click();
      await page.waitForSelector('#sel-selector:not(:empty)', { timeout: 5000 });
      assert.deepEqual(errors, [], `browser runtime errors: ${errors.join(' | ')}`);

      // Exercise a second URL for Astro to verify server-side route handling
      // survives the proxy's base path rewriting.
      if (target.name.startsWith('Astro')) {
        const previewOrigin = new URL(await page.locator('iframe.immersive-preview').getAttribute('src')).origin;
        const nested = await fetch(`${previewOrigin}/proxy/nested`).then((r) => r.text());
        assert.match(nested, /Astro Nested Route/, `Astro nested route proxy response: ${nested.slice(0, 120)}`);
      }
      console.log(`  ok  ${target.name}`);
    } catch (error) {
      failures++;
      console.error(`  FAIL ${target.name}: ${error.message}`);
      console.error(`       frames: ${page.frames().map((f) => f.url()).join(' | ')}`);
      if (errors.length) console.error(`       page errors: ${errors.join(' | ')}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  dash.kill('SIGTERM');
  for (const close of servers.reverse()) await close().catch(() => {});
  fs.closeSync(logFile);
}

console.log(failures ? `\n${failures} compatibility check(s) failed` : `\nall ${targets.length} framework/server checks passed`);
process.exit(failures ? 1 : 0);
