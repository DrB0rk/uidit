#!/usr/bin/env node
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from '../src/server/store.js';
import { startServer } from '../src/server/server.js';
import { discoverTargets } from '../src/server/discover.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(PKG_ROOT, 'dashboard', 'dist');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  accent: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function dashboardBuilt() {
  return fs.existsSync(path.join(DIST, 'index.html'));
}

function buildDashboard() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build:dashboard'], { cwd: PKG_ROOT, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`dashboard build failed (${code})`))));
  });
}

const commands = {
  async init(cwd) {
    const { created, dir } = store.init(cwd);
    console.log(created ? `${c.accent('✓')} created ${c.bold(dir)}` : `${c.dim('•')} ${dir} already exists`);
    console.log(`\nNext: start your project's dev server, then run ${c.accent('uidit')} and hit Discover.`);
  },

  async start(cwd, argv) {
    const port = Number(argv.find((a) => /^\d+$/.test(a)) ?? store.readConfig(cwd)?.dashboardPort ?? 7717);
    if (!store.isInitialized(cwd)) store.init(cwd);
    if (!dashboardBuilt()) {
      console.log(`${c.dim('building dashboard…')}`);
      await buildDashboard();
    }
    const url = `http://127.0.0.1:${port}`;
    const { hub } = await startServer({ cwd, port });

    console.log(`\n  ${c.accent('uidit')} ${c.dim(`dashboard → ${url}`)}`);
    console.log(`  ${c.dim(`session   → ${path.join(store.uiditDir(cwd), 'session.json')}`)}`);

    const targets = await discoverTargets({ excludePorts: [port] });
    if (targets.length) {
      console.log(`\n  ${c.bold('Local servers found')} ${c.dim('— pick one with Discover, or paste a URL')}`);
      for (const t of targets) console.log(`    ${c.accent(t.url)}${t.title ? c.dim(` — ${t.title}`) : ''}`);
      // Deliberately no auto-target: the first listening port is often not a dev
      // server (CUPS, Docker proxies), and silently previewing the wrong one is worse
      // than making the user choose. Connecting in the dashboard persists the choice.
      if (!store.readConfig(cwd)?.targetUrl) {
        console.log(`\n  ${c.dim(`current target: none — pick one at ${url}`)}`);
      }
    } else {
      console.log(`\n  ${c.dim('No dev server detected. Start one, then paste its URL in the dashboard.')}`);
    }
    console.log(`\n  ${c.dim('Ctrl+C to stop.')}\n`);

    const bye = () => {
      hub.close();
      console.log(`\n  ${c.dim('uidit stopped. Your feedback is saved in .uidit/')}`);
      process.exit(0);
    };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  },

  async status(cwd) {
    const session = store.readSession(cwd);
    const open = session.comments.filter((x) => !x.resolved);
    console.log(`${c.bold('uidit')} ${path.relative(process.cwd(), store.uiditDir(cwd))}`);
    console.log(`  target    ${store.readConfig(cwd)?.targetUrl ?? c.dim('not set')}`);
    console.log(`  elements  ${session.elements.length}`);
    console.log(`  comments  ${open.length} open / ${session.comments.length} total`);
    console.log(`  edits     ${session.edits.filter((e) => !e.applied).length} pending / ${session.edits.length} total`);
    console.log(`  updated   ${session.updatedAt ?? c.dim('never')}`);
    for (const comment of open) {
      const el = session.elements.find((e) => e.id === comment.elementId);
      console.log(`\n  ${c.dim('•')} ${el ? c.accent(el.selector) : 'page'} ${c.dim(`(${comment.id})`)}\n    ${comment.text}`);
    }
  },

  async resolve(cwd, argv) {
    const ids = argv.filter((a) => !a.startsWith('-'));
    const all = ids.length === 0;
    const session = store.readSession(cwd);
    const targets = session.comments.filter((x) => !x.resolved && (all || ids.includes(x.id)));
    if (!targets.length) return console.log(c.dim('nothing to resolve'));
    for (const t of targets) store.updateRecord(cwd, 'comments', t.id, { resolved: true });
    console.log(`${c.accent('✓')} resolved ${targets.length} comment(s)`);
  },

  async build(cwd) {
    await buildDashboard();
    console.log(`${c.accent('✓')} dashboard built`);
  },
};

const [, , command = 'start', ...argv] = process.argv;
const cwd = process.cwd();

if (!commands[command]) {
  console.log(`uidit — local UI review dashboard

  uidit init              create .uidit/ in this project
  uidit                   (same as: uidit start) run the dashboard
  uidit start [--port]    run the dashboard, discover local dev servers
  uidit status            print open feedback and pending edits
  uidit resolve [ids…]    mark comments resolved (all open if no ids)
  uidit build             rebuild the dashboard UI

Everything you tag, comment, or change is written to .uidit/session.json.`);
  process.exit(0);
}

try {
  await commands[command](cwd, argv);
} catch (err) {
  console.error(`${c.dim('error:')} ${err.message}`);
  process.exit(1);
}