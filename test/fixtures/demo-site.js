import http from 'node:http';

// A compact, self-contained storefront used by the browser suite and README
// screenshots. Keep the page dependency-free so it behaves like a real local
// preview even when the test runner has no network access.
const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#f5f4f0">
  <title>Demo Shop — Checkout</title>
  <style>
    :root{color-scheme:light;--ink:#20251f;--muted:#777d74;--line:#e8e9e3;--paper:#fff;--canvas:#f5f4f0;--green:#315f48;--lime:#d6eea2;--serif:Georgia,serif}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}button{font:inherit;cursor:pointer}a{color:inherit;text-decoration:none}.shell{max-width:1180px;margin:auto;padding:0 36px}
    .topbar{height:76px;border-bottom:1px solid #e9e8e2;background:#f8f7f3}.topbar-inner{height:100%;display:flex;align-items:center;justify-content:space-between}.brand{font:800 20px Manrope,sans-serif;letter-spacing:-1px}.brand-mark{display:inline-grid;place-items:center;background:var(--green);color:white;width:28px;height:28px;border-radius:9px;margin-right:8px;font:700 14px Manrope}.nav{display:flex;gap:30px;color:#697066;font-size:13px}.nav a:first-child{color:var(--ink);font-weight:700}.top-actions{display:flex;align-items:center;gap:17px}.avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(145deg,#e4b28b,#754b3f);display:inline-grid;place-items:center;color:white;font-weight:700;font-size:11px;border:2px solid white;box-shadow:0 0 0 1px #ddd}
    .crumbs{padding:22px 0 18px;color:#858a81;font-size:12px}.crumbs span{padding:0 8px;color:#b0b3ab}.crumbs b{color:#3d463d;font-weight:600}.page-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:25px}.eyebrow{font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#849077}.page-head h1{font:800 clamp(29px,4vw,39px)/1.1 Manrope,sans-serif;letter-spacing:-1.8px;margin:6px 0 7px}.page-head p{margin:0;color:var(--muted);font-size:13px}.secure{display:flex;align-items:center;gap:8px;color:#69756b;font-size:11px;padding-bottom:4px}.secure-icon{display:grid;place-items:center;width:25px;height:25px;background:#e7eee5;color:#3e7054;border-radius:50%;font-size:13px}
    .progress{display:flex;align-items:center;gap:10px;margin:0 0 25px;color:#979b92;font-size:11px}.step{display:flex;align-items:center;gap:8px;white-space:nowrap}.step b{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;border:1px solid #d7d9d1;font-size:10px}.step.active{color:#315f48;font-weight:700}.step.active b{background:var(--green);border-color:var(--green);color:white}.step.done{color:#596d5c}.step.done b{background:#e4ede3;border-color:#e4ede3;color:#477354}.progress-line{height:1px;background:#dcdfd7;width:55px}
    .layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.9fr);gap:24px;align-items:start}.stack{display:grid;gap:15px}.card{background:var(--paper);border:1px solid #e8e9e3;border-radius:15px;padding:23px;box-shadow:0 3px 12px #303b2207}.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}.card-head h2{font:700 15px Manrope,sans-serif;letter-spacing:-.25px;margin:0}.card-head a{font-size:11px;color:#53735b;font-weight:700}.tiny-label{font-size:10px;color:#92978d}
    .items-note{display:flex;justify-content:space-between;align-items:center;background:#f5f7f1;border-radius:9px;padding:9px 11px;margin:-2px 0 15px;color:#65705f;font-size:11px}.items-note strong{color:#3f6247;font-size:10px}.products{display:grid;gap:13px}.product{display:grid;grid-template-columns:68px 1fr auto;gap:13px;align-items:center}.product-art{height:68px;border-radius:10px;position:relative;overflow:hidden;display:grid;place-items:center}.art-mug{background:linear-gradient(140deg,#e8e4d7,#d8d3c5)}.mug{width:35px;height:39px;border-radius:7px 7px 12px 12px;background:linear-gradient(100deg,#ece8dc,#c7c0b1);box-shadow:inset -4px 0 #bdb5a5,0 7px 12px #51483826;position:relative}.mug:after{content:'';position:absolute;right:-11px;top:8px;width:14px;height:17px;border:4px solid #c8c0b0;border-left:0;border-radius:0 9px 9px 0}.art-lamp{background:linear-gradient(145deg,#dce7e1,#c2d4ca)}.lamp{position:relative;width:45px;height:46px}.lamp:before{content:'';position:absolute;left:10px;top:3px;width:27px;height:24px;background:#f5d38c;clip-path:polygon(20% 0,80% 0,100% 85%,0 85%);border-radius:12px;filter:drop-shadow(0 5px 9px #e2b36088)}.lamp:after{content:'';position:absolute;left:22px;top:25px;width:3px;height:17px;background:#526b5a;box-shadow:-8px 17px 0 3px #526b5a,8px 17px 0 3px #526b5a}.art-vase{background:linear-gradient(145deg,#f2dfd5,#e8c9bc)}.vase{width:28px;height:38px;background:linear-gradient(90deg,#bd7962,#dd9d7e);border-radius:8px 8px 13px 13px;clip-path:polygon(35% 0,65% 0,68% 28%,100% 45%,92% 100%,8% 100%,0 45%,32% 28%);position:relative}.product-name{font-weight:700;font-size:12px}.product-meta{font-size:10px;color:#92978d;margin-top:3px}.qty{display:flex;align-items:center;gap:10px;color:#778074;font-size:11px;margin-top:7px}.qty button{width:20px;height:20px;border:1px solid #e4e6df;border-radius:6px;background:white;color:#667060;padding:0}.price{text-align:right;font-size:12px;font-weight:700;align-self:start;padding-top:3px}.old{font-size:10px;color:#a1a49c;text-decoration:line-through;font-weight:400;margin-top:2px}.divider{height:1px;background:#eff0eb;margin:16px 0}.promo{display:flex;gap:8px}.promo input,.field input{width:100%;border:1px solid #e2e5dd;border-radius:8px;background:white;padding:10px 11px;font:11px 'DM Sans';outline:none}.promo input:focus,.field input:focus{border-color:#6c9678;box-shadow:0 0 0 3px #dceade}.promo button{border:1px solid #dfe4db;border-radius:8px;background:white;padding:0 13px;color:#4c6651;font-weight:700;font-size:10px}.subtotals{display:grid;gap:9px;font-size:11px;color:#747b71}.subtotals div{display:flex;justify-content:space-between}.subtotals strong{color:#323a32;font-weight:600}.total{font-size:14px!important;color:#222b23!important;font-weight:700}.total strong{font-size:18px}.tax-note{font-size:9px;color:#9a9e95;text-align:right;margin-top:-3px}
    .field-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:10px;font-weight:700;color:#656d63}.field input{height:39px}.field input::placeholder{color:#afb3aa}.payment-options{display:grid;grid-template-columns:1fr 1fr;gap:9px}.pay-option{border:1px solid #e4e7df;border-radius:9px;padding:11px;display:flex;align-items:center;gap:9px;font-size:11px;font-weight:600}.pay-option.selected{border-color:#598268;box-shadow:0 0 0 2px #e5eee5;color:#315f48}.radio{width:14px;height:14px;border:1px solid #cbd0c7;border-radius:50%;display:grid;place-items:center}.selected .radio:after{content:'';width:7px;height:7px;border-radius:50%;background:#467452}.card-brand{margin-left:auto;font-weight:800;color:#415f80;letter-spacing:-1px}.amex{color:#507d9e;font-size:9px}
    .order-card{position:sticky;top:20px}.order-top{display:flex;justify-content:space-between;align-items:center}.order-top h2{font:700 15px Manrope;margin:0}.edit-link{color:#54765b;font-size:10px;font-weight:700}.delivery{background:#f6f7f3;border:1px solid #eceee7;border-radius:10px;padding:13px;margin:15px 0}.delivery-top{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:11px}.delivery-top span:last-child{font-size:9px;color:#63806a;background:#e5eee4;padding:4px 7px;border-radius:20px}.delivery p{color:#858c80;font-size:10px;margin:5px 0 0}.eta{display:flex;gap:9px;align-items:center;margin-top:12px}.eta-bar{height:4px;background:#e1e6dc;border-radius:10px;flex:1;overflow:hidden}.eta-bar i{display:block;width:68%;height:100%;background:#789777;border-radius:10px}.eta small{font-size:9px;color:#758071}.summary-lines{display:grid;gap:10px}.summary-lines div{display:flex;justify-content:space-between;color:#747b71;font-size:11px}.summary-lines b{color:#384037;font-weight:600}.summary-total{display:flex;align-items:end;justify-content:space-between;margin-top:16px}.summary-total span{font-size:11px;color:#6d756a}.summary-total strong{font:800 25px Manrope;letter-spacing:-1px}.currency{font-size:10px;color:#82877e;margin-left:4px}.pay-button{width:100%;height:48px;border:0;border-radius:9px;background:#315f48;color:white;font-weight:700;font-size:12px;margin-top:17px;box-shadow:0 5px 12px #315f4825;transition:transform .15s,background .15s}.pay-button:hover{background:#244c39;transform:translateY(-1px)}.pay-button:focus-visible{outline:3px solid #b8d7bb;outline-offset:3px}.secure-foot{display:flex;align-items:center;justify-content:center;gap:6px;color:#8a9186;font-size:9px;margin-top:11px}.secure-foot span{color:#56805e}.trust{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:13px}.trust div{background:#f7f8f4;border-radius:8px;padding:10px 7px;text-align:center;font-size:9px;color:#747c70}.trust b{display:block;color:#4f7255;font-size:12px;margin-bottom:2px}.testimonial{display:flex;gap:11px;align-items:center;border-top:1px solid #f0f0eb;margin-top:18px;padding-top:15px}.faces{display:flex;padding-left:4px}.faces i{width:22px;height:22px;border-radius:50%;border:2px solid white;margin-left:-4px;background:linear-gradient(135deg,#c78167,#784a44)}.faces i:nth-child(2){background:linear-gradient(135deg,#ebc797,#8d684f)}.faces i:nth-child(3){background:linear-gradient(135deg,#899d83,#425747)}.testimonial p{font-size:9px;color:#80867d;margin:0}.testimonial strong{color:#535d52}.footer{padding:26px 0 35px;color:#92978e;font-size:10px;display:flex;justify-content:space-between}.footer nav{display:flex;gap:18px}
    @media(max-width:760px){.shell{padding:0 20px}.topbar{height:64px}.nav{display:none}.page-head{align-items:start}.secure{font-size:0}.secure-icon{font-size:13px}.layout{grid-template-columns:1fr;gap:14px}.order-card{position:static;grid-row:1}.stack{grid-row:2}.order-card .card{padding:18px}.trust{grid-template-columns:repeat(3,1fr)}.page-head h1{font-size:30px}.progress-line{width:min(8vw,40px)}}
    @media(max-width:420px){.shell{padding:0 14px}.crumbs{padding:16px 0}.progress{gap:6px;font-size:9px}.step{gap:5px}.step b{width:20px;height:20px}.progress-line{width:14px}.card{padding:17px}.product{grid-template-columns:58px 1fr auto;gap:10px}.product-art{height:58px}.field-grid{gap:9px}.footer{font-size:9px}.footer nav{gap:10px}}
  </style>
</head>
<body>
  <header class="topbar"><div class="shell topbar-inner">
    <a class="brand" href="#"><span class="brand-mark">n</span>northstar<span style="color:#7c8a75">.</span></a>
    <nav class="nav" aria-label="Main navigation"><a href="#">Shop</a><a href="#">Our story</a><a href="#">Journal</a><a href="#">Help</a></nav>
    <div class="top-actions"><span style="font-size:12px;color:#788075">Bag <b style="color:#30382f">3</b></span><span class="avatar" aria-label="Account: Alex Morgan">AM</span></div>
  </div></header>
  <main class="shell">
    <div class="crumbs">Home <span>›</span> Your bag <span>›</span> <b>Checkout</b></div>
    <section class="page-head"><div><div class="eyebrow">Almost yours</div><h1>Checkout</h1><p>A few thoughtful things, on their way to you.</p></div><div class="secure"><span class="secure-icon">♧</span>Secure checkout</div></section>
    <div class="progress" aria-label="Checkout progress"><div class="step done"><b>✓</b> Bag</div><i class="progress-line"></i><div class="step active"><b>2</b> Details</div><i class="progress-line"></i><div class="step"><b>3</b> Confirmation</div></div>
    <div class="layout">
      <div class="stack">
        <section class="card" aria-labelledby="order-items"><div class="card-head"><h2 id="order-items">Your selection</h2><a href="#">Edit bag</a></div>
          <div class="items-note"><span>3 items waiting for review.</span><strong>Saved for 20 min</strong></div>
          <div class="products">
            <article class="product"><div class="product-art art-mug"><img id="mug-photo" alt="Everyday stoneware mug" style="width:100%;height:100%;object-fit:cover" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2210%22 fill=%22%23e8e4d7%22/%3E%3Cpath d=%22M17 20h26v28H17zM43 25h6a7 7 0 0 1 0 14h-6%22 fill=%22%23bba98c%22 stroke=%22%238b775a%22 stroke-width=%223%22/%3E%3C/svg%3E"></div><div><div class="product-name">Everyday stoneware mug</div><div class="product-meta">Oat · 12 oz</div><div class="qty"><button aria-label="Decrease mug quantity">−</button><span>1</span><button aria-label="Increase mug quantity">+</button></div></div><div class="price">$28.00<div class="old">$34.00</div></div></article>
            <article class="product"><div class="product-art art-lamp" aria-hidden="true"><div class="lamp"></div></div><div><div class="product-name">Dawn bedside lamp</div><div class="product-meta">Sage / warm white</div><div class="qty"><button aria-label="Decrease lamp quantity">−</button><span>1</span><button aria-label="Increase lamp quantity">+</button></div></div><div class="price">$86.00</div></article>
            <article class="product"><div class="product-art art-vase" aria-hidden="true"><div class="vase"></div></div><div><div class="product-name">Sunday bud vase</div><div class="product-meta">Terracotta · handmade</div><div class="qty"><button aria-label="Decrease vase quantity">−</button><span>1</span><button aria-label="Increase vase quantity">+</button></div></div><div class="price">$32.00</div></article>
          </div>
          <div class="divider"></div><div class="promo"><input aria-label="Gift card or discount code" placeholder="Gift card or discount code"><button type="button" id="apply-code">Apply code</button></div>
        </section>
        <section class="card"><div class="card-head"><h2>Contact &amp; delivery</h2><span class="tiny-label">Step 2 of 3</span></div>
          <div class="field-grid"><div class="field full"><label for="email">Email address</label><input id="email" type="email" placeholder="alex@example.com" value="alex.morgan@email.com"></div><div class="field"><label for="first">First name</label><input id="first" value="Alex"></div><div class="field"><label for="last">Last name</label><input id="last" value="Morgan"></div><div class="field full"><label for="address">Street address</label><input id="address" placeholder="House number and street name" value="42 Willow Lane"></div><div class="field"><label for="city">City</label><input id="city" value="Portland"></div><div class="field"><label for="zip">ZIP code</label><input id="zip" value="97205"></div></div>
        </section>
        <section class="card"><div class="card-head"><h2>Payment method</h2><span class="tiny-label">All transactions are encrypted</span></div>
          <div class="payment-options"><div class="pay-option selected"><span class="radio"></span>Card<span class="card-brand">VISA</span></div><div class="pay-option"><span class="radio"></span>PayPal<span class="amex">PAYPAL</span></div></div>
          <div class="field-grid" style="margin-top:14px"><div class="field full"><label for="cardnumber">Card number</label><input id="cardnumber" placeholder="0000 0000 0000 0000" value="••••  ••••  ••••  4242"></div><div class="field"><label for="expiry">Expiration</label><input id="expiry" placeholder="MM / YY" value="08 / 28"></div><div class="field"><label for="security">Security code</label><input id="security" placeholder="CVC" value="•••"></div></div>
        </section>
      </div>
      <aside class="card order-card"><div class="order-top"><h2>Order summary</h2><a class="edit-link" href="#">Edit</a></div>
        <div class="delivery"><div class="delivery-top"><span>Standard delivery</span><span>Free</span></div><p>Arrives Thu, Oct 24 – Sat, Oct 26</p><div class="eta"><div class="eta-bar"><i></i></div><small>Ships in 1–2 days</small></div></div>
        <div class="summary-lines"><div><span>Subtotal · 3 items</span><b>$146.00</b></div><div><span>Shipping</span><b style="color:#57805e">Free</b></div><div><span>Estimated tax</span><b>$11.68</b></div></div>
        <div class="divider" style="margin:15px 0 11px"></div><div class="summary-total"><span>Total</span><div><strong>$157.68</strong><span class="currency">USD</span></div></div><div class="tax-note">Including $11.68 in taxes</div>
        <button id="pay" class="pay-button" type="button">Pay now&nbsp; <span aria-hidden="true">→</span></button>
        <div class="secure-foot"><span>◆</span> Payment step is slow on mobile. Your details stay protected.</div>
        <div class="trust"><div><b>↗</b>Free shipping</div><div><b>♧</b>Easy returns</div><div><b>♡</b>Made with care</div></div>
        <div class="testimonial"><div class="faces" aria-hidden="true"><i></i><i></i><i></i></div><p><strong>Loved by 12,000+ homes</strong><br>“The little details make it.” · ★★★★★</p></div>
      </aside>
    </div>
    <footer class="footer"><span>© 2025 northstar goods · Made for slower mornings.</span><nav aria-label="Footer"><a href="#">Shipping</a><a href="#">Returns</a><a href="#">Privacy</a></nav></footer>
  </main>
  <script>
    document.querySelectorAll('.qty button').forEach(button => button.addEventListener('click', () => {
      const count = button.parentElement.querySelector('span');
      count.textContent = Math.max(1, Number(count.textContent) + (button.textContent.trim() === '+' ? 1 : -1));
    }));
    document.querySelectorAll('.pay-option').forEach(option => option.addEventListener('click', () => {
      document.querySelectorAll('.pay-option').forEach(item => item.classList.remove('selected'));
      option.classList.add('selected');
    }));
    document.querySelector('#apply-code').addEventListener('click', event => {
      const input = document.querySelector('[aria-label="Gift card or discount code"]');
      event.currentTarget.textContent = input.value.trim() ? 'Applied ✓' : 'Add a code';
    });
    document.querySelector('#pay').addEventListener('pointerover', event => {
      document.body.dataset.uiditAgentHover = event.pointerType || 'unknown';
    });
    document.querySelector('#pay').addEventListener('keydown', event => {
      document.body.dataset.uiditAgentKey = event.key;
    });
    document.querySelector('#pay').addEventListener('click', () => {
      document.body.dataset.uiditAgentClicks = String(Number(document.body.dataset.uiditAgentClicks || 0) + 1);
    });
  </script>
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
