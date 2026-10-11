import net from 'node:net';
import http from 'node:http';

// Ports dev servers commonly bind to. Probed in parallel, cheap (connect-only).
const COMMON_PORTS = [
  3000, 3001, 4000, 4200, 5000, 5173, 5174, 5175, 8000, 8080, 8081, 8888, 1234, 9000,
];

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

function fetchTitle(url, timeout = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 20000) res.destroy();
      });
      const answer = () => {
        const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        finish({ url, status: res.statusCode, title: m ? m[1].trim() : null });
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

/** Find local HTTP servers that look like a dev server for this project. */
export async function discoverTargets({ host = '127.0.0.1', ports = COMMON_PORTS } = {}) {
  const open = await Promise.all(ports.map((p) => probe(p, host)));
  const candidates = ports.filter((_, i) => open[i]);
  const results = await Promise.all(
    candidates.map((p) => fetchTitle(`http://${host === '0.0.0.0' ? 'localhost' : host}:${p}/`)),
  );
  return results.filter(Boolean).filter((r) => r.status && r.status < 500);
}