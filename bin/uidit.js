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
import { createProcessManager, createServiceManager } from '../src/server/process-manager.js';
import { startMcpServer, readMcpToken, runStdioBridge } from '../src/server/mcp/server.js';
import { acquireProjectLock } from '../src/server/runtime-lock.js';
import { createHub } from '../src/server/realtime.js';
import { CollaborationManager } from '../src/server/collaboration.js';
import { createSelectiveVerifier } from '../src/server/verification.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(PKG_ROOT, 'dashboard', 'dist');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  accent: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const USAGE = `uidit — local UI review dashboard

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
  uidit build             rebuild the dashboard UI`;

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
  help() { console.log(USAGE); },
  async init(cwd) {
    const { created, dir } = store.init(cwd);
    console.log(created ? `${c.accent('✓')} created ${c.bold(dir)}` : `${c.dim('•')} ${dir} already exists`);
    console.log(`\nRun ${c.accent('uidit')} to start a detected dev server, or configure .uidit/config.json.`);
  },

  async start(cwd, argv) {
    const initialConfig = store.readConfig(cwd);
    let port = Number(initialConfig?.controlPort ?? initialConfig?.dashboardPort ?? store.DEFAULT_CONTROL_PORT);
    const configuredPreviewPort = Number(initialConfig?.previewPort ?? 7717);
    const separator = argv.indexOf('--');
    const optionArgs = separator < 0 ? argv : argv.slice(0, separator);
    const portIndex = optionArgs.indexOf('--port');
    const legacyPort = optionArgs.length === 1 && /^\d+$/.test(optionArgs[0]) ? optionArgs[0] : null;
    if (portIndex >= 0 || legacyPort) { const value = Number(portIndex >= 0 ? argv[portIndex + 1] : legacyPort); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('--port requires a valid TCP port'); port = value; }
    if (!store.isInitialized(cwd)) store.init(cwd);
    const runtimeLock = acquireProjectLock(cwd);
    process.once('exit', runtimeLock.release);
    if (!dashboardBuilt()) {
      console.log(`${c.dim('building dashboard…')}`);
      await buildDashboard();
    }
    let hub = createHub({ cwd });
    const collaborationManager = new CollaborationManager({ cwd, hub });
    const processManager = createProcessManager({ cwd, onChange: (status) => {
      hub?.notifyDev(status);
      if (status.url && status.url !== store.readConfig(cwd)?.targetUrl) { store.writeConfig(cwd, { targetUrl: status.url, dev: { url: status.url } }); hub?.notifyConfig(); }
    } });
    const serviceManager = createServiceManager({ cwd, onChange: (services) => hub?.notifyDev({ services }) });
    serviceManager.configure(initialConfig?.services ?? []);
    const verifier = createSelectiveVerifier({ cwd, hub, onError: (error) => hub?.notifyDev({ hmrVerification: { state: 'unsupported', reason: error.message } }) });
    const preview = await startServer({ cwd, port: configuredPreviewPort, controlPort: port, previewOnly: true, hub, collaborationManager });
    let mcp;
    try { mcp = await startMcpServer({ cwd, port, fallbackPort: store.FALLBACK_CONTROL_PORT, previewPort: preview.port, processManager, serviceManager, hub, collaborationManager }); }
    catch (err) { collaborationManager.close(); hub.close(); preview.server.close(); throw err; }
    verifier.start();
    let stopping = false;
    const bye = async () => {
      if (stopping) return;
      stopping = true;
      verifier.close();
      await serviceManager.stopAll();
      await processManager.stop();
      collaborationManager.close();
      hub.close(); await mcp.close(); preview.server.close();
      runtimeLock.release();
      console.log(`\n  ${c.dim('uidit stopped. Your feedback is saved in .uidit/')}`);
      process.exit(0);
    };
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
    store.writeConfig(cwd, { dashboardPort: mcp.port, controlPort: mcp.port, previewPort: preview.port });
    hub.notifyConfig();
    const url = mcp.controlUrl;

    console.log(`\n  ${c.accent('uidit')} ${c.dim(`dashboard → ${url}`)}`);
    console.log(`  ${c.dim(`preview   → ${preview.url}`)}`);
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
      processManager.attach(parsed.href);
      console.log(`\n  ${c.dim(`attached → ${parsed.href} (uidit will not stop it)`)}`);
    } else if (!noStart) {
      const spec = resolveDevCommand(cwd, explicit);
      if (spec) {
        store.writeConfig(cwd, { dev: { command: [spec.command, ...spec.args], cwd: path.relative(cwd, spec.cwd) || '.' } });
        console.log(`\n  ${c.dim(`starting → ${[spec.command, ...spec.args].join(' ')}`)}`);
        try { await processManager.start(spec); }
        catch (err) { await processManager.stop(); hub.close(); await mcp.close(); preview.server.close(); throw err; }
        console.log(`  ${c.accent(`ready → ${processManager.status().url}`)}`);
      } else {
        console.log(`\n  ${c.dim('No dev command found; use uidit -- <command> or uidit --attach http://127.0.0.1:3000')}`);
      }
    }
    const targets = await discoverTargets({ excludePorts: [preview.port, mcp.port] });
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

  },

  async mcp(cwd, argv) {
    const sub = argv[0] ?? 'info';
    if (sub === 'info') {
      const config = store.readConfig(cwd);
      const port = config?.controlPort ?? store.DEFAULT_CONTROL_PORT;
      console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, transport: 'Streamable HTTP', token: readMcpToken(cwd), stdio: 'uidit mcp stdio (requires a running uidit instance)' }, null, 2));
      return;
    }
    if (sub === 'stdio') {
      try {
        return await runStdioBridge({ cwd });
      } catch (error) {
        const port = store.readConfig(cwd)?.controlPort ?? store.DEFAULT_CONTROL_PORT;
        console.error(`${c.bold('uidit mcp stdio')} could not reach http://127.0.0.1:${port}/mcp${error?.message ? ` (${error.message})` : ''}`);
        console.error(`  ${c.dim('Start `uidit` in this project, then let your MCP client reconnect.')}`);
        process.exitCode = 1;
        return;
      }
    }
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
const helpFlag = rawArgs[0] === '--help' || rawArgs[0] === '-h';
const command = helpFlag ? 'help' : rawArgs.length === 0 || rawArgs[0].startsWith('-') ? 'start' : rawArgs[0];
const argv = command === 'start' && rawArgs[0] !== 'start' ? rawArgs : rawArgs.slice(1);
const cwd = process.cwd();

if (!commands[command]) {
  console.log(`${USAGE}\n\nEverything you tag, comment, or change is written to .uidit/session.json.`);
  process.exit(0);
}

try {
  await commands[command](cwd, argv);
} catch (err) {
  console.error(`${c.dim('error:')} ${err.message}`);
  process.exit(1);
}
