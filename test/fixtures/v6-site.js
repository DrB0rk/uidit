import http from 'node:http';

// Mirrors Vite: root-absolute asset URLs, and an IPv6-only bind like `[::1]:5273`.
const page = `<!doctype html><html><head><title>Vite-ish 5273</title>
<script type="module" src="/@vite/client"></script>
</head><body>
  <main id="app"><h1>PolderGraph UI</h1><p>IPv6-only dev server fixture.</p>
  <button id="save" class="btn">Save</button></main>
  <script type="module" src="/src/main.js"></script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/src/main.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end("document.getElementById('app')?.setAttribute('data-hydrated', '1');");
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.listen(5273, '::1', () => console.log('ipv6-only fixture on http://[::1]:5273'));

export { server };