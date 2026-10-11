import fs from 'node:fs';
import path from 'node:path';
import { uiditDir, readSession } from './store.js';

/**
 * Fan-out hub. Every dashboard client holds one SSE connection; mutations made
 * through the API are pushed immediately, and a filesystem watcher pushes when a
 * coding agent edits .uidit/session.json outside uidit. Both paths converge on
 * the same snapshot payload so clients never need to poll.
 */
export function createHub({ cwd = process.cwd() } = {}) {
  const clients = new Set();
  let watcher = null;
  let timer = null;

  const push = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  const broadcastSession = () => push('session', readSession(cwd));
  const broadcastConfig = () => push('config', { config: readConfigSafe(cwd) });

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
        else broadcastSession();
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
      timer = setTimeout(broadcastSession, 60);
    },
    notifyConfig() {
      broadcastConfig();
    },
    watch,
    close() {
      clearTimeout(timer);
      watcher?.close();
      watcher = null;
      for (const res of clients) res.end();
      clients.clear();
    },
    get clientCount() {
      return clients.size;
    },
  };

  function broadcastTo(res) {
    res.write(`event: session\ndata: ${JSON.stringify(readSession(cwd))}\n\n`);
  }
}