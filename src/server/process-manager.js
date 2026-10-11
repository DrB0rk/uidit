import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

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
    return { state, url, pid: child?.pid ?? null, command: child ? [child.spawnfile, ...child.spawnargs].join(' ') : null, error, logs: logs.slice(-80) };
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
      try { if (process.platform !== 'win32' && owned.pid) process.kill(-owned.pid, 'SIGKILL'); else owned.kill('SIGKILL'); } catch {}
    }, 4000);
    await exited; clearTimeout(timer); state = 'stopped'; publish(); return status();
  }
  return { start, stop, status, logs: (after = 0) => logs.filter((x) => x.id > after) };
}

