import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uiditDir, readSession, writeSession } from './store.js';

/**
 * Fan-out hub. Every dashboard client holds one SSE connection; mutations made
 * through the API are pushed immediately, and a filesystem watcher pushes when a
 * coding agent edits .uidit/session.json outside uidit. Both paths converge on
 * the same snapshot payload so clients never need to poll.
 */
export function createHub({ cwd = process.cwd() } = {}) {
  const clients = new Set();
  const listeners = new Set();
  let watcher = null;
  let timer = null;
  let selection = null;
  let browserContext = null;
  let browserDiagnostics = [];
  const browserActionWaiters = new Map();
  const pendingBrowserActions = new Map();
  let lastRevision = readSession(cwd).revision ?? 0;

  const push = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  const emit = (type, data) => { for (const listener of listeners) listener(type, data); };
  const broadcastSession = () => { const data = readSession(cwd); push('session', data); emit('session', data); };
  const broadcastConfig = () => { const data = { config: readConfigSafe(cwd) }; push('config', data); emit('config', data); };
  const broadcastDev = (data) => { push('dev', data); emit('dev', data); };
  const broadcastSelection = (data) => { selection = data; push('selection', data); emit('selection', data); };
  const broadcastMcp = (data) => { push('mcp', data); emit('mcp', data); };
  const broadcastCollaboration = (data) => { push('collaboration', data); emit('collaboration', data); };
  const notifyBrowserContext = (data) => { browserContext = data; push('browser-context', data); emit('browser-context', data); };
  const notifyBrowserDiagnostics = (entries) => { browserDiagnostics = [...browserDiagnostics, ...entries].slice(-250); push('browser-diagnostics', entries); emit('browser-diagnostics', entries); };
  const requestBrowserAction = (action, timeout = 12000) => new Promise((resolve, reject) => {
    if (!clients.size) return reject(new Error('No UIDIT dashboard is connected to the live preview'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { browserActionWaiters.delete(id); pendingBrowserActions.delete(id); reject(new Error('Browser action timed out')); }, Math.max(1000, Math.min(30000, timeout)));
    pendingBrowserActions.set(id, action.type);
    browserActionWaiters.set(id, (result) => { clearTimeout(timer); browserActionWaiters.delete(id); result?.ok ? resolve(result) : reject(new Error(result?.error ?? 'Browser action failed')); });
    push('browser-action', { id, action });
  });
  const resolveBrowserAction = (id, result) => { const resolve = browserActionWaiters.get(id); if (!resolve) return false; pendingBrowserActions.delete(id); resolve(result); return true; };

  function readConfigSafe(dir) {
    try {
      const file = path.join(uiditDir(dir), 'config.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  const watch = () => {
    if (watcher) return;
    const dir = uiditDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== 'session.json' && filename !== 'config.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (filename === 'config.json') broadcastConfig();
        else {
          try {
            let session = readSession(cwd);
            if (session.revision <= lastRevision) session = writeSession(cwd, session);
            lastRevision = session.revision;
          } catch { /* preserve malformed external edits and report via API on read */ }
          broadcastSession();
        }
      }, 80);
    });
  };

  return {
    add(res) {
      clients.add(res);
      res.write(`retry: 1000\n\n`);
      broadcastTo(res);
      return () => clients.delete(res);
    },
    /** Called after any uidit mutation; debounced so one action = one push. */
    notify() {
      clearTimeout(timer);
      timer = setTimeout(() => { lastRevision = readSession(cwd).revision ?? lastRevision; broadcastSession(); }, 60);
    },
    notifyConfig() {
      broadcastConfig();
    },
    notifyDev: broadcastDev,
    notifySelection: broadcastSelection,
    notifyMcp: broadcastMcp,
    notifyCollaboration: broadcastCollaboration,
    notifyBrowserContext,
    notifyBrowserDiagnostics,
    requestBrowserAction,
    resolveBrowserAction,
    isBrowserActionPending(id, type) { return pendingBrowserActions.get(id) === type; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    watch,
    close() {
      clearTimeout(timer);
      watcher?.close();
      watcher = null;
      for (const res of clients) res.end();
      clients.clear();
      listeners.clear();
    },
    get clientCount() {
      return clients.size;
    },
    get selection() { return selection; },
    get browserContext() { return browserContext; },
    get browserDiagnostics() { return browserDiagnostics.slice(-250); },
  };

  function broadcastTo(res) {
    res.write(`event: session\ndata: ${JSON.stringify(readSession(cwd))}\n\n`);
  }
}
