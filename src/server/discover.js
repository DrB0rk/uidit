import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';

// Ports dev servers commonly bind to. Probed in parallel, cheap (connect-only).
const COMMON_PORTS = [3000, 3001, 3002, 4000, 4200, 5000, 5173, 5174, 5175, 5273, 7000, 8000, 8080, 8081, 8888, 9000, 1234];

// Ports uidit itself may be listening on, so it never reports itself as a target.
const SELF_PORTS = new Set(['7717', '7801', '7802', '7803', '7805', '7806']);

// Vite and friends often bind IPv6-only ([::1]), so both loopbacks must be probed.
const HOSTS = ['127.0.0.1', '::1'];

/** Every TCP port currently listening on this machine — the real source of truth. */
function listeningPorts() {
  return new Promise((resolve) => {
    const child = execFile('ss', ['-ltnH'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve([]);
      const ports = new Set();
      for (const line of stdout.split('\n')) {
        const m = line.match(/\]:(\d+)\s|:(\d+)\s/);
        const port = m && (m[1] ?? m[2]);
        if (port) ports.add(Number(port));
      }
      resolve([...ports]);
    });
    child.on('error', () => resolve([]));
  });
}

function probe(port, host, timeout = 250) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function probeEitherHost(port) {
  return Promise.any(HOSTS.map((h) => probe(port, h))).catch(() => null);
}

function fetchTarget(url, timeout = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      const type = String(res.headers['content-type'] ?? '');
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 20000) res.destroy();
      });
      const answer = () => {
        const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        finish({ url, status: res.statusCode, title: m ? m[1].trim() : null, isHtml: type.includes('text/html') });
      };
      res.on('end', answer);
      // Truncating a huge body destroys the stream: 'aborted' is the terminal event.
      res.on('aborted', answer);
      res.on('close', answer);
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

/**
 * Find local web dev servers. Strategy: enumerate every port actually listening, then
 * add the well-known dev ports in case something is still binding. Only HTML responses
 * are reported — that keeps API servers, SSH tunnels, and CUPS out of the list.
 *
 * The URL keeps whatever host form the user will paste (localhost, 127.0.0.1, [::1])
 * so the dashboard and the preview agree on how to reach the same server.
 */
export async function discoverTargets({ extraPorts = [], excludePorts = [], includeNonHtml = false } = {}) {
  const listening = await listeningPorts();
  const skip = new Set([...SELF_PORTS, ...excludePorts.map(String)]);
  const candidates = [...new Set([...listening, ...COMMON_PORTS, ...extraPorts.map(Number)])]
    .filter((p) => p > 0 && p < 65536 && !skip.has(String(p)))
    .sort((a, b) => a - b);

  const open = await Promise.all(candidates.map((p) => probeEitherHost(p)));
  const ports = candidates.filter((_, i) => open[i] !== null);

  const urls = ports.flatMap((p) => HOSTS.map((h) => ({
    port: p,
    url: `http://${h === '::1' ? '[::1]' : h}:${p}/`,
  })));

  const results = await Promise.all(urls.map((u) => fetchTarget(u.url)));

  // One entry per port: IPv4 first, so the reported URL matches what people type.
  const byPort = new Map();
  results
    .map((r, i) => (r ? { ...r, port: urls[i].port } : null))
    .filter(Boolean)
    .filter((r) => r.status && r.status < 500)
    .filter((r) => includeNonHtml || r.isHtml)
    .forEach((r) => { if (!byPort.has(r.port)) byPort.set(r.port, r); });

  // A titled page is almost certainly the dev server; untitled hits go last.
  return [...byPort.values()].sort((a, b) => Number(Boolean(b.title)) - Number(Boolean(a.title)));
}