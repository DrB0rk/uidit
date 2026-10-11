import http from 'node:http';

// Mimics a React dev server: hashed bundle assets, JSON API, /app/ base, and a
// redirect at the root — the combination that breaks naive HTML rewriting.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>React App</title>
<script type="module" src="/assets/index-abc123.js"></script></head>
<body><div id="root"></div></body></html>`;

const appHtml = `<!doctype html><html><head><meta charset="utf-8"><title>React App</title>
<script type="module" src="/assets/index-abc123.js"></script></head>
<body><div id="root"></div></body></html>`;

export function reactServer(port = 0, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/assets/index-abc123.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      // Fetches its own API from inside the preview: these must reach the target
      // dev server, not collide with uidit's namespace.
      return res.end(
        "fetch('/api/status').then(r => r.json()).then(d =>"
        + " document.getElementById('root').innerHTML ="
        + " '<h1>React App</h1><p id=\"who\">' + d.source + '</p>' +"
        + " '<button id=\"buy\">Buy now</button>');",
      );
    }
    if (url.pathname === '/api/user') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ name: 'Ada' }));
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, source: 'target' }));
    }
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/app/' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(appHtml);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port: server.address().port })));
}

if (process.argv[1]?.endsWith('react-site.js')) {
  reactServer(5274).then(({ port }) => console.log(`react fixture on http://127.0.0.1:${port}`));
  void html;
}