import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i;
const redact = (s) => s.replace(/((?:token|secret|password|key)=)[^\s&]+/gi, '$1[redacted]');

export function createProcessManager({ cwd = process.cwd(), onChange = () => {}, timeout = 90_000 } = {}) {
  let child = null;
  let url = null;
  let state = 'idle';
  let error = null;
  let sequence = 0;
  const logs = [];
  const publish = () => onChange(status());
  const addLog = (stream, chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      logs.push({ id: ++sequence, at: new Date().toISOString(), stream, text: redact(line).slice(0, 4000) });
      if (logs.length > 500) logs.shift();
      const match = line.match(URL_RE);
      if (match && !url) { url = match[0].replace(/[),.;]+$/, ''); publish(); }
    }
    publish();
  };
  function status() {
    return { state, url, pid: child?.pid ?? null, command: child ? redact([child.spawnfile, ...child.spawnargs].join(' ')) : null, owned: Boolean(child), error, logs: logs.slice(-80) };
  }
  function probe(address) {
    return new Promise((resolve) => {
      let parsed;
      try { parsed = new URL(address); } catch { return resolve(false); }
      if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(parsed.hostname)) return resolve(false);
      if (parsed.hostname === '0.0.0.0') parsed.hostname = '127.0.0.1';
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(parsed, { timeout: 1200, rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }
  async function start(spec) {
    if (child) throw new Error('dev process is already running');
    if (!spec?.command) throw new Error('no development command was resolved');
    state = 'starting'; error = null; url = spec.url ?? null; publish();
    child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd ?? cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    const owned = child;
    owned.stdout.on('data', (data) => addLog('stdout', data));
    owned.stderr.on('data', (data) => addLog('stderr', data));
    owned.on('error', (err) => { error = err.message; state = 'error'; publish(); });
    owned.on('exit', (code, signal) => {
      if (child !== owned) return;
      child = null;
      if (state !== 'stopping') { state = code === 0 ? 'stopped' : 'crashed'; error = `process exited (${signal ?? code})`; }
      publish();
    });
    const until = Date.now() + timeout;
    while (Date.now() < until && child === owned) {
      if (state === 'error') break;
      if (url && await probe(url)) { state = 'ready'; publish(); return status(); }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (child !== owned) throw new Error(error ?? 'dev process exited before becoming ready');
    const failure = error ?? (url ? `No HTTP response from ${url} within ${timeout / 1000}s` : 'No local URL found in command output. Configure dev.url in .uidit/config.json.');
    if (child === owned) await stop();
    error = failure; state = 'error'; publish();
    throw new Error(failure);
  }
  async function stop() {
    if (!child) return status();
    state = 'stopping'; publish();
    const owned = child;
    const exited = new Promise((resolve) => owned.once('exit', resolve));
    try {
      if (process.platform !== 'win32' && owned.pid) process.kill(-owned.pid, 'SIGTERM');
      else owned.kill('SIGTERM');
    } catch {}
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && owned.pid) process.kill(-owned.pid, 'SIGKILL');
        else if (owned.pid) spawn('taskkill', ['/pid', String(owned.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        else owned.kill('SIGKILL');
      } catch {}
    }, 4000);
    await exited; clearTimeout(timer); state = 'stopped'; publish(); return status();
  }
  function attach(address) { url = address; child = null; error = null; state = 'attached'; publish(); return status(); }
  function detach() { if (child) throw new Error('cannot detach an owned process'); url = null; state = 'idle'; error = null; publish(); return status(); }
  return { start, stop, attach, detach, status, logs: (after = 0) => logs.filter((x) => x.id > after) };
}

/**
 * Independent managed processes for monorepos. Each child has its own manager,
 * logs, URL, and ownership. An attached service is represented as externally
 * owned and is therefore never stopped by UIDit.
 */
export function createServiceManager({ cwd = process.cwd(), onChange = () => {} } = {}) {
  let definitions = [];
  const managers = new Map();
  const notify = () => onChange(status());
  const normalize = (items) => {
    if (!Array.isArray(items) || items.length > 8) throw new Error('services must be an array of at most 8 entries');
    const ids = new Set();
    const result = items.map((item) => {
      const id = String(item?.id ?? '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id) || ids.has(id)) throw new Error(`invalid or duplicate service id: ${id}`);
      ids.add(id);
      if (!Array.isArray(item.command) || !item.command.length || item.command.length > 32 || item.command.some((arg) => typeof arg !== 'string' || arg.length > 1000)) throw new Error(`service ${id} needs a bounded argv command`);
      const relativeCwd = typeof item.cwd === 'string' ? item.cwd : '.';
      const projectRoot = fs.realpathSync(cwd);
      const resolvedCwd = path.resolve(projectRoot, relativeCwd);
      if (resolvedCwd !== projectRoot && !resolvedCwd.startsWith(`${projectRoot}${path.sep}`)) throw new Error(`service ${id} cwd must remain inside the project`);
      let actualCwd;
      try { actualCwd = fs.realpathSync(resolvedCwd); } catch { throw new Error(`service ${id} working directory does not exist`); }
      if (!fs.statSync(actualCwd).isDirectory() || (actualCwd !== projectRoot && !actualCwd.startsWith(`${projectRoot}${path.sep}`))) throw new Error(`service ${id} cwd must be an existing directory inside the project`);
      if (item.url && !URL_RE.test(item.url)) throw new Error(`service ${id} URL must be local`);
      const dependencies = Array.isArray(item.dependencies) ? [...new Set(item.dependencies.map(String))] : [];
      return { id, name: String(item.name ?? id).slice(0, 80), command: [...item.command], cwd: path.relative(projectRoot, actualCwd) || '.', url: item.url ?? null, dependencies };
    });
    for (const item of result) for (const dependency of item.dependencies) if (!ids.has(dependency) || dependency === item.id) throw new Error(`service ${item.id} has an invalid dependency: ${dependency}`);
    const visiting = new Set(), visited = new Set();
    const visit = (id) => { if (visiting.has(id)) throw new Error(`service dependency cycle contains ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dep of result.find((item) => item.id === id).dependencies) visit(dep); visiting.delete(id); visited.add(id); };
    for (const item of result) visit(item.id);
    return result;
  };
  const configure = (items) => {
    const next = normalize(items);
    for (const [id, manager] of managers) if (!next.some((item) => item.id === id) && manager.status().owned) throw new Error(`stop owned service ${id} before removing it`);
    definitions = next;
    for (const item of definitions) if (!managers.has(item.id)) managers.set(item.id, createProcessManager({ cwd: path.resolve(cwd, item.cwd), onChange: notify }));
    for (const id of managers.keys()) if (!definitions.some((item) => item.id === id)) managers.delete(id);
    notify(); return status();
  };
  const status = () => definitions.map((item) => { const runtime = managers.get(item.id)?.status() ?? {}; return { ...runtime, id: item.id, name: item.name, dependencies: [...item.dependencies], command: runtime.command ?? item.command.join(' '), cwd: item.cwd, url: runtime.url ?? item.url }; });
  const byId = (id) => { const definition = definitions.find((item) => item.id === id); if (!definition) throw new Error(`unknown service: ${id}`); return { definition, manager: managers.get(id) }; };
  const startOne = async (id, started = new Set(), launched = []) => {
    if (started.has(id)) return byId(id).manager.status();
    const { definition, manager } = byId(id);
    for (const dependency of definition.dependencies) await startOne(dependency, started, launched);
    started.add(id);
    if (manager.status().state === 'ready') return manager.status();
    if (manager.status().state === 'attached') return manager.status();
    const result = await manager.start({ command: definition.command[0], args: definition.command.slice(1), cwd: path.resolve(cwd, definition.cwd), url: definition.url });
    launched.push(id);
    notify(); return result;
  };
  const withRollback = async (startOperation) => {
    const previouslyOwned = new Set(status().filter((item) => item.owned).map((item) => item.id));
    const launched = [];
    try { return await startOperation(launched); }
    catch (error) {
      for (const id of launched.reverse()) if (!previouslyOwned.has(id) && managers.get(id)?.status().owned) await managers.get(id).stop().catch(() => {});
      notify(); throw error;
    }
  };
  return {
    configure,
    start: async (id) => withRollback((launched) => startOne(id, new Set(), launched)),
    startAll: async () => withRollback(async (launched) => { const started = new Set(); for (const item of definitions) await startOne(item.id, started, launched); return status(); }),
    stop: async (id) => { const { manager } = byId(id); const result = await manager.stop(); notify(); return result; },
    stopAll: async () => { const result = []; for (const item of [...definitions].reverse()) result.push(await managers.get(item.id).stop()); notify(); return result; },
    status,
    logs: (id, after = 0) => byId(id).manager.logs(after),
  };
}

