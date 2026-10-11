import http from 'node:http';

const page = `<!doctype html><html><head><title>Demo Shop</title></head>
<body>
  <main id="app">
    <h1>Demo Shop</h1>
    <div class="grid">
      <article class="card"><h2>Cart</h2><p>3 items waiting for review.</p></article>
      <article class="card"><h2>Checkout</h2><p>Payment step is slow on mobile.</p></article>
    </div>
    <button id="pay">Pay now</button>
  </main>
</body></html>`;

export const server = http.createServer((req, res) => {
  if (req.url === '/api/cart') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ items: 3 }));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

if (process.argv[1]?.endsWith('demo-site.js')) {
  server.listen(4599, '127.0.0.1', () => console.log('demo dev server on http://127.0.0.1:4599'));
}