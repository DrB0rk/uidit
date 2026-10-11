#!/usr/bin/env node
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from '../src/server/store.js';
import { startServer } from '../src/server/server.js';
import { discoverTargets } from '../src/server/discover.js';
import { resolveDevCommand } from '../src/server/command-resolver.js';
import { createProcessManager } from '../src/server/process-manager.js';
import { startMcpServer, readMcpToken, runStdioBridge } from '../src/server/mcp/server.js';

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
    const ignore = path.join(cwd, '.gitignore');
    if (fs.existsSync(path.join(cwd, '.git')) || fs.existsSync(path.join(cwd, '.gitignore'))) {
      const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
      if (!/(^|\n)\.uidit\/(?:\n|$)/.test(current)) fs.appendFileSync(ignore, `${current && !current.endsWith('\n') ? '\n' : ''}.uidit/\n`);
    }
    console.log(created ? `${c.accent('✓')} created ${c.bold(dir)}` : `${c.dim('•')} ${dir} already exists`);
    console.log(`\nRun ${c.accent('uidit')} to start a detected dev server, or configure .uidit/config.json.`);
  },

  async start(cwd, argv) {
    let port = Number(store.readConfig(cwd)?.dashboardPort ?? 7717);
    const portIndex = argv.indexOf('--port');
    const legacyPort = argv.find((a) => /^\d+$/.test(a));
    if (portIndex >= 0 || legacyPort) { const value = Number(portIndex >= 0 ? argv[portIndex + 1] : legacyPort); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('--port requires a valid TCP port'); port = value; }
    if (!store.isInitialized(cwd)) store.init(cwd);
    if (!dashboardBuilt()) {
      console.log(`${c.dim('building dashboard…')}`);
      await buildDashboard();
    }
    const url = `http://127.0.0.1:${port}`;
    const { server: dashboardServer, hub } = await startServer({ cwd, port });
    const processManager = createProcessManager({ cwd, onChange: (status) => { if (status.url && status.url !== store.readConfig(cwd)?.targetUrl) { store.writeConfig(cwd, { targetUrl: status.url, dev: { url: status.url } }); hub.notifyConfig(); } } });
    let mcp;
    try { mcp = await startMcpServer({ cwd, port: store.readConfig(cwd)?.controlPort ?? 7718, dashboardPort: port, processManager, hub }); }
    catch (err) { hub.close(); dashboardServer.close(); throw err; }

    console.log(`\n  ${c.accent('uidit')} ${c.dim(`dashboard → ${url}`)}`);
    console.log(`  ${c.dim(`mcp       → ${mcp.url}`)}`);
    console.log(`  ${c.dim(`session   → ${path.join(store.uiditDir(cwd), 'session.json')}`)}`);

    const explicit = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : null;
    const noStart = argv.includes('--no-start') || argv.includes('--attach') || (store.readConfig(cwd)?.dev?.autoStart === false && !explicit?.length);
    const attachIndex = argv.indexOf('--attach');
    const attachedUrl = attachIndex >= 0 ? argv[attachIndex + 1] : null;
    if (attachedUrl) {
      const parsed = new URL(attachedUrl);
      if (!/^https?:$/.test(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('--attach must be a local http(s) URL');
      store.writeConfig(cwd, { targetUrl: parsed.href });
      console.log(`\n  ${c.dim(`attached → ${parsed.href} (uidit will not stop it)`)}`);
    } else if (!noStart) {
      const spec = resolveDevCommand(cwd, explicit);
      if (spec) {
        console.log(`\n  ${c.dim(`starting → ${[spec.command, ...spec.args].join(' ')}`)}`);
        try { await processManager.start(spec); }
        catch (err) { await processManager.stop(); hub.close(); await mcp.close(); dashboardServer.close(); throw err; }
        console.log(`  ${c.accent(`ready → ${processManager.status().url}`)}`);
      } else {
        console.log(`\n  ${c.dim('No dev command found; use uidit -- <command> or uidit --attach http://127.0.0.1:3000')}`);
      }
    }
    const targets = await discoverTargets({ excludePorts: [port, store.readConfig(cwd)?.controlPort ?? 7718] });
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

    const bye = async () => {
      await processManager.stop();
      hub.close(); await mcp.close(); dashboardServer.close();
      console.log(`\n  ${c.dim('uidit stopped. Your feedback is saved in .uidit/')}`);
      process.exit(0);
    };
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  },

  async mcp(cwd, argv) {
    const sub = argv[0] ?? 'info';
    if (sub === 'info') {
      const config = store.readConfig(cwd);
      const port = config?.controlPort ?? 7718;
      console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, transport: 'Streamable HTTP', token: readMcpToken(cwd), stdio: 'uidit mcp stdio (requires a running uidit instance)' }, null, 2));
      return;
    }
    if (sub === 'stdio') return runStdioBridge({ cwd });
    throw new Error(`unknown mcp command: ${sub}`);
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

  async build(cwd, argv) {
    // npm's `prepare` hook runs this on install; a shipped build makes it a no-op.
    if (argv.includes('--if-needed') && dashboardBuilt()) return;
    await buildDashboard();
    if (!argv.includes('--if-needed')) console.log(`${c.accent('✓')} dashboard built`);
  },
};

const rawArgs = process.argv.slice(2);
const command = rawArgs.length === 0 || rawArgs[0].startsWith('-') ? 'start' : rawArgs[0];
const argv = command === 'start' && rawArgs[0] !== 'start' ? rawArgs : rawArgs.slice(1);
const cwd = process.cwd();

if (!commands[command]) {
  console.log(`uidit — local UI review dashboard

  uidit init              create .uidit/ in this project
  uidit                   (same as: uidit start) run the dashboard
  uidit [-- command...]   start a detected or explicit project dev server and review UI
  uidit --attach <url>    attach to a local server without owning its process
  uidit --no-start        legacy dashboard and manual discovery mode
  uidit start [--port N]  run the dashboard
  uidit mcp info          show local MCP endpoint and client setup
  uidit mcp stdio         bridge a local stdio MCP client to the running instance
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
