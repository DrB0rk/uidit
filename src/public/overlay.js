/* UIDIT's preview bridge. The page is untrusted; all persistence is delegated to
   the trusted parent dashboard through a narrow message protocol. */
(() => {
  if (window.__uiditOverlay) return;
  window.__uiditOverlay = true;

  const pendingRequests = new Map();
  let nextRequest = 0;
  const state = {
    mode: 'off',
    selected: null,
    pendingStyle: null,
  };
  let hoverEl = null;
  let drawingTool = 'off';
  let visualState = { comments: [], elements: [] };
  let openCommentId = null;
  let drawStart = null;
  let activeFlowId = null;
  let inputTimer = null;
  let restoreNetworkHooks = null;
  let imageLibraryPromise = null;
  let recordingCaptureQueue = Promise.resolve();
  let browserInspectionEnabled = false;
  let diagnosticsTimer = null;
  let diagnosticsQueue = [];
  let diagnosticRestore = null;
  let componentStateRestore = null;
  let proposalRestore = null;

  // UIDIT's controls live in a separate-origin iframe; only accept its tiny,
  // schema-checked message set from the exact embedded window.
  const controls = document.createElement('iframe');
  const anchorKey = 'uidit-floating-anchor';
  let savedAnchor = null;
  try {
    const value = sessionStorage.getItem(anchorKey);
    if (/^(left|center|right)-(top|middle|bottom)$/.test(value || '')) savedAnchor = value;
  } catch {}
  function setAnchor(value) {
    if (!/^(left|center|right)-(top|middle|bottom)$/.test(value || '')) return;
    const [x, y] = value.split('-');
    controls.classList.remove('uidit-left', 'uidit-center', 'uidit-right', 'uidit-top', 'uidit-middle');
    controls.classList.add(`uidit-${x}`);
    if (y !== 'bottom') controls.classList.add(`uidit-${y}`);
    controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'placement', y }, controlOrigin);
  }
  const bootstrap = document.currentScript;
  const controlOrigin = bootstrap?.dataset.control || 'http://127.0.0.1:7718';
  // The dashboard may have been opened as localhost while the bridge uses the
  // numeric loopback address. Use the actual embedding origin for postMessage.
  const parentOrigin = (() => {
    try {
      const origin = new URL(document.referrer).origin;
      const parentUrl = new URL(origin);
      const expectedPort = new URL(controlOrigin).port;
      return ['localhost', '127.0.0.1', '[::1]'].includes(parentUrl.hostname) && parentUrl.port === expectedPort ? origin : controlOrigin;
    } catch { return controlOrigin; }
  })();
  window.__UIDIT_TARGET__ = bootstrap?.dataset.target || '';
  controls.src = `${controlOrigin}/floating?preview=${encodeURIComponent(location.origin)}`;
  controls.title = 'UIDIT review controls';
  controls.setAttribute('data-uidit-ui', '1');
  (document.documentElement || document).append(controls);
  if (savedAnchor) setAnchor(savedAnchor);

  const post = (type, payload = {}) => window.parent.postMessage({ source: 'uidit-overlay', type, ...payload }, parentOrigin);

  const api = (route, method, body) => new Promise((resolve, reject) => {
    if (window.parent === window) return reject(new Error('Open this preview in UIDIT to save review changes'));
    const id = `u${++nextRequest}-${Date.now()}`;
    const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error('UIDIT control bridge timed out')); }, 15000);
    pendingRequests.set(id, { resolve, reject, timer });
    window.parent.postMessage({ source: 'uidit-overlay', type: 'api-request', id, route, method, body }, parentOrigin);
  });

  const collapse = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

  // The page is served through /proxy/, but feedback must reference the real dev URL.
  const realPage = () => {
    const origin = window.__UIDIT_TARGET__;
    if (!origin) return location.href;
    const path = location.pathname.replace(/^\/proxy/, '') || '/';
    // uidit's own cache-buster (?r=) is not part of the real page URL.
    const params = new URLSearchParams(location.search);
    params.delete('r');
    const search = params.toString();
    return `${origin}${path}${search ? `?${search}` : ''}`;
  };
  const canonicalRoute = (raw) => {
    try { const url = new URL(raw); for (const key of [...url.searchParams.keys()]) if (/^(?:r|_t|t|timestamp|cacheBust|cache_bust|utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key); url.searchParams.sort(); return `${url.origin}${url.pathname}${url.search}`; }
    catch { return String(raw ?? ''); }
  };

  function uniqueSelector(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const byId = document.querySelectorAll(`#${CSS.escape(el.id)}`);
      if (byId.length === 1) return `#${CSS.escape(el.id)}`;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => c && !/^[a-z]{1,2}$/.test(c)).slice(0, 2);
      if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join('.')}`;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ') || 'body';
  }

  const describe = (el) => {
    const ancestors = [];
    let node = el.parentElement;
    while (node && node.nodeType === 1) {
      ancestors.unshift(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}`);
      node = node.parentElement;
      if (ancestors.length >= 5) break;
    }
    const attributes = {};
    for (const attr of el.attributes) {
      if (['style', 'class', 'id', 'name', 'type', 'placeholder', 'aria-label', 'href', 'src', 'role', 'alt'].includes(attr.name)) {
        attributes[attr.name] = attr.value;
      }
    }
    const labelledBy = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
    const nativeLabel = el.labels ? [...el.labels].map((label) => label.textContent).join(' ') : '';
    const accessibleName = collapse(el.getAttribute('aria-label') || labelledBy || nativeLabel || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent).slice(0, 200);
    let component = null;
    try {
      const reactKey = Object.keys(el).find((key) => key.startsWith('__reactFiber$'));
      let fiber = reactKey ? el[reactKey] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const type = fiber.type;
        const name = typeof type === 'function' ? type.displayName || type.name : typeof type === 'object' ? type?.displayName : '';
        if (name && name !== 'Anonymous') { component = { framework: 'React', name: String(name).slice(0, 100) }; break; }
      }
      if (!component && el.__vueParentComponent) {
        const type = el.__vueParentComponent.type;
        const name = type?.name || type?.__name;
        if (name) component = { framework: 'Vue', name: String(name).slice(0, 100) };
      }
      if (!component && window.ng?.getComponent) {
        const instance = window.ng.getComponent(el);
        const name = instance?.constructor?.name;
        if (name && name !== 'Object') component = { framework: 'Angular', name: String(name).slice(0, 100) };
      }
      if (!component && el.__svelte_meta?.loc) component = { framework: 'Svelte', name: 'Svelte component' };
    } catch { /* Framework introspection is best-effort and never affects inspection. */ }
    return {
      selector: uniqueSelector(el),
      selectorAlternatives: [...el.classList].map((c) => `.${CSS.escape(c)}`),
      tag: el.tagName,
      text: collapse(el.textContent).slice(0, 300),
      accessibleName,
      role: el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', IMG: 'img', INPUT: el.type === 'checkbox' ? 'checkbox' : 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[el.tagName] ?? null),
      nearbyText: collapse(el.parentElement?.innerText ?? '').slice(0, 240),
      component,
      ancestors,
      attributes,
      page: realPage(),
    };
  };

  const recordLog = (kind, message, url = location.href) => {
    if (!activeFlowId) return;
    const safe = String(message ?? '').slice(0, 1000).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/([?&](?:token|key|secret|password)=)[^&\s]*/gi, '$1[redacted]');
    post('record-log', { flowId: activeFlowId, kind, message: safe, url: String(url).slice(0, 2000) });
  };
  const isSensitive = (el) => el.matches('input[type="password"],input[type="email"],input[type="tel"],[autocomplete^="cc-"],[data-private]');
  function sendBrowserContext() {
    if (!browserInspectionEnabled) return;
    const nodes = [...document.querySelectorAll('a,button,input,select,textarea,img,[role],[data-testid],h1,h2,h3')].slice(0, 300).map((el) => {
      const rect = el.getBoundingClientRect(); const record = describe(el); const style = getComputedStyle(el);
      return { selector: record.selector, tag: el.tagName, role: record.role, name: record.accessibleName, text: record.text, ...(el.tagName === 'IMG' ? { alt: el.getAttribute('alt') } : {}), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles: { display: style.display, position: style.position, color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, padding: style.padding, margin: style.margin, gap: style.gap, overflow: style.overflow } };
    });
    post('browser-context', { url: realPage(), title: document.title, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, readyState: document.readyState, nodes });
  }
  function setBrowserInspection(enabled) {
    browserInspectionEnabled = enabled === true;
    if (!browserInspectionEnabled) { diagnosticRestore?.(); diagnosticRestore = null; diagnosticsQueue = []; clearTimeout(diagnosticsTimer); return; }
    sendBrowserContext(); if (diagnosticRestore) return;
    const originalConsoleError = console.error; const originalFetch = window.fetch; const originalXhrOpen = XMLHttpRequest.prototype.open; const originalXhrSend = XMLHttpRequest.prototype.send;
    const addDiagnostic = (kind, message, url = null) => {
      if (!browserInspectionEnabled) return;
      const safe = String(message ?? '').slice(0, 1000).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/([?&](?:token|key|secret|password)=)[^&\s]*/gi, '$1[redacted]');
      diagnosticsQueue.push({ kind, message: safe, url: typeof url === 'string' ? url.slice(0, 2000) : null }); if (diagnosticsQueue.length > 100) diagnosticsQueue.shift();
      clearTimeout(diagnosticsTimer); diagnosticsTimer = setTimeout(() => { const entries = diagnosticsQueue.splice(0, 30); if (entries.length) post('browser-diagnostics', { entries }); }, 250);
    };
    window.fetch = function (...args) { const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url; return originalFetch.apply(this, args).then((response) => { if (!response.ok) addDiagnostic('network', `HTTP ${response.status}`, requestUrl); return response; }, (error) => { addDiagnostic('network', error?.message || 'Fetch failed', requestUrl); throw error; }); };
    XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__uiditRequestUrl = String(url ?? ''); return originalXhrOpen.call(this, method, url, ...rest); };
    XMLHttpRequest.prototype.send = function (...args) { this.addEventListener('loadend', () => { if (this.status >= 400 || this.status === 0) addDiagnostic('network', `HTTP ${this.status || 'network error'}`, this.responseURL || this.__uiditRequestUrl); }, { once: true }); return originalXhrSend.apply(this, args); };
    console.error = function (...args) { addDiagnostic('console', args.map((value) => typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).join(' ')); return originalConsoleError.apply(this, args); };
    const onError = (event) => addDiagnostic('console', event.message || event.reason || 'Page error', event.filename ?? null);
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onError);
    const observer = new MutationObserver(() => { if (document.querySelector('vite-error-overlay')) addDiagnostic('hmr', 'Development server reported a client build error', location.href); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    diagnosticRestore = () => { window.fetch = originalFetch; XMLHttpRequest.prototype.open = originalXhrOpen; XMLHttpRequest.prototype.send = originalXhrSend; console.error = originalConsoleError; window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onError); observer.disconnect(); };
  }
  async function runBrowserAction(id, action = {}) {
    const reply = (value) => post('browser-action-result', { id, ...value });
    if (!browserInspectionEnabled || typeof id !== 'string') { reply({ ok: false, error: 'Live browser inspection is disabled' }); return; }
    try {
      if (action.type === 'screenshot') { const screenshot = await captureStepScreenshot(); if (!screenshot) throw new Error('Screenshot could not be captured'); reply({ ok: true, result: { screenshot } }); return; }
      if (action.type === 'navigate') {
        if (typeof action.path !== 'string' || !action.path.startsWith('/') || action.path.startsWith('//')) throw new Error('Navigation must use a local path beginning with /');
        const proxiedPath = action.path.startsWith('/proxy/') ? action.path : `/proxy${action.path}`; const next = new URL(proxiedPath, location.origin);
        if (next.origin !== location.origin || !next.pathname.startsWith('/proxy/')) throw new Error('Navigation is limited to the configured local preview');
        location.assign(next.href); reply({ ok: true, result: { url: next.href } }); return;
      }
      const selector = typeof action.selector === 'string' ? action.selector.slice(0, 1000) : ''; const element = selector ? document.querySelector(selector) : null;
      if (!element || element.closest?.('[data-uidit-ui]')) throw new Error('Target element was not found');
      if (action.type === 'click') element.click();
      else if (action.type === 'focus') element.focus();
      else if (action.type === 'hover') element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      else if (action.type === 'scroll') element.scrollIntoView({ block: 'center', behavior: 'instant' });
      else if (action.type === 'fill') {
        if (isSensitive(element)) throw new Error('Sensitive form fields cannot be controlled by an agent');
        if (!/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || typeof action.value !== 'string' || action.value.length > 1000) throw new Error('Fill requires a non-sensitive input and a value under 1000 characters');
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(element, action.value); else element.value = action.value;
        element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (action.type === 'keypress') {
        const key = typeof action.key === 'string' && ['Enter','Escape','Tab','ArrowDown','ArrowUp',' '].includes(action.key) ? action.key : '';
        if (!key) throw new Error('Only Enter, Escape, Tab, arrow keys, and Space are supported');
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      } else throw new Error('Unsupported browser action');
      setTimeout(() => { sendBrowserContext(); reply({ ok: true, result: { selector, action: action.type, url: realPage(), title: document.title } }); }, 100);
    } catch (error) { reply({ ok: false, error: error.message }); }
  }
  const loadImageLibrary = () => {
    if (window.htmlToImage?.toJpeg) return Promise.resolve(window.htmlToImage.toJpeg);
    if (!imageLibraryPromise) imageLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${controlOrigin}/html-to-image.js`; script.dataset.uiditUi = '1';
      script.onload = () => window.htmlToImage?.toJpeg ? resolve(window.htmlToImage.toJpeg) : reject(new Error('Screenshot library did not load'));
      script.onerror = () => reject(new Error('Screenshot library could not load'));
      document.head.append(script);
    });
    return imageLibraryPromise;
  };
  const captureStepScreenshot = async () => {
    const toJpeg = await loadImageLibrary();
    const width = Math.max(320, Math.min(window.innerWidth || 1280, 1280));
    const height = Math.max(240, Math.min(window.innerHeight || 900, 1000));
    const mask = document.createElement('style');
    mask.dataset.uiditUi = '1';
    mask.textContent = 'input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable="true"]{color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';
    document.head.append(mask);
    try {
      let image = await toJpeg(document.documentElement, { quality: 0.56, width, height, canvasWidth: Math.round(width * 0.72), canvasHeight: Math.round(height * 0.72), filter: (node) => !node?.hasAttribute?.('data-uidit-ui') });
      if (image.length > 3_400_000) image = await toJpeg(document.documentElement, { quality: 0.32, width, height, canvasWidth: Math.round(width * 0.5), canvasHeight: Math.round(height * 0.5), filter: (node) => !node?.hasAttribute?.('data-uidit-ui') });
      return image.length <= 3_400_000 ? image : null;
    } finally { mask.remove(); }
  };
  const recordStep = (type, el, action = type) => {
    if (!activeFlowId || !el || el.closest?.('[data-uidit-ui]')) return;
    const record = describe(el);
    const sensitive = type === 'input' && isSensitive(el);
    const flowId = activeFlowId;
    const step = { type, action, selector: uniqueSelector(el), label: record.accessibleName || record.text || record.role || record.tag, value: type === 'input' && !sensitive ? String(el.value ?? el.textContent ?? '').slice(0, 2000) : undefined, sensitive, page: realPage() };
    recordingCaptureQueue = recordingCaptureQueue.then(async () => {
      try { step.screenshot = await captureStepScreenshot(); } catch (error) { recordLog('page', `Screenshot unavailable: ${error.message}`); }
      post('record-step', { flowId, step });
    });
  };
  const setRecording = (enabled, flowId) => {
    activeFlowId = enabled && typeof flowId === 'string' ? flowId : null;
    clearTimeout(inputTimer);
    if (!activeFlowId) { restoreNetworkHooks?.(); restoreNetworkHooks = null; return; }
    if (restoreNetworkHooks) return;
    const originalFetch = window.fetch;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    const originalConsoleError = console.error;
    window.fetch = function (...args) {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      return originalFetch.apply(this, args).then((response) => { if (!response.ok) recordLog('network', `HTTP ${response.status}`, requestUrl); return response; }, (error) => { recordLog('network', error?.message || 'Fetch failed', requestUrl); throw error; });
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('loadend', () => { if (this.status >= 400 || this.status === 0) recordLog('network', `HTTP ${this.status || 'network error'}`, this.responseURL); }, { once: true });
      return originalXhrSend.apply(this, args);
    };
    console.error = function (...args) { recordLog('console', args.map((value) => typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).join(' ')); return originalConsoleError.apply(this, args); };
    const onError = (event) => recordLog('console', event.message || event.reason || 'Page error');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    restoreNetworkHooks = () => {
      window.fetch = originalFetch; XMLHttpRequest.prototype.send = originalXhrSend; console.error = originalConsoleError;
      window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onError);
    };
  };

  document.addEventListener('click', (event) => {
    if (!activeFlowId || event.button !== 0) return;
    const el = event.target?.closest?.('button,a,input,select,textarea,[role="button"],[onclick]') ?? event.target?.closest?.('*');
    if (el && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) recordStep('click', el, 'click');
  }, true);
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (!activeFlowId || !el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
    clearTimeout(inputTimer); inputTimer = setTimeout(() => recordStep('input', el, 'fill'), 500);
  }, true);
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (activeFlowId && el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) { clearTimeout(inputTimer); recordStep('input', el, el.type === 'checkbox' || el.type === 'radio' ? 'check' : 'fill'); }
  }, true);
  document.addEventListener('submit', (event) => { if (activeFlowId) recordStep('submit', event.target, 'submit'); }, true);
  window.addEventListener('hashchange', () => { if (activeFlowId) post('record-step', { flowId: activeFlowId, step: { type: 'navigation', action: 'navigate', page: realPage(), label: document.title } }); });

  function installHighlightStyles() {
    if (document.getElementById('uidit-style')) return;
    const style = document.createElement('style');
    style.id = 'uidit-style';
    style.textContent =
      '[data-uidit-hover]{outline:2px solid #6d5efc !important;outline-offset:-2px !important;' +
      'background-color:rgba(109,94,252,0.08) !important;}' +
      '[data-uidit-selected]{outline:3px solid #795cff !important;outline-offset:2px !important;' +
      'box-shadow:0 0 0 6px rgba(121,92,255,.19) !important;}';
    document.head.append(style);
  }

  const visuals = document.createElement('div');
  visuals.id = 'uidit-visuals';
  visuals.setAttribute('data-uidit-ui', '1');
  visuals.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483646;pointer-events:none;overflow:visible;';
  document.documentElement.append(visuals);
  const svgNS = 'http://www.w3.org/2000/svg';
  const anchorStatusCache = new Map();
  const fold = (value) => collapse(value).toLowerCase().slice(0, 240);
  function anchorMatch(anchor, el) {
    if (!anchor || !el) return 0;
    const candidateRole = el.getAttribute('role') || ({ A:'link', BUTTON:'button', IMG:'img', INPUT:el.type==='checkbox'?'checkbox':'textbox', SELECT:'combobox', TEXTAREA:'textbox' }[el.tagName] ?? null);
    const accessibleName = fold(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.textContent);
    const text = fold(el.textContent);
    const weights = [[anchor.role && candidateRole === anchor.role,.14],[anchor.tag && el.tagName.toLowerCase() === String(anchor.tag).toLowerCase(),.08],[anchor.accessibleName && fold(anchor.accessibleName) === accessibleName,.42],[anchor.text && fold(anchor.text) === text,.2],[anchor.component?.name && Object.keys(el).some((key)=>key.startsWith('__reactFiber$')&&String(el[key]?.type?.name||'').includes(anchor.component.name)),.12],[anchor.attributes?.['data-testid'] && el.getAttribute('data-testid') === anchor.attributes['data-testid'],.16]];
    return Math.min(1,weights.reduce((sum,[match,weight])=>sum+(match?weight:0),0));
  }
  function locateCommentTarget(comment, record) {
    const anchor = comment.originalAnchor ?? record?.anchor ?? record;
    if (!anchor) return { status: 'missing', element: null, candidates: [] };
    if (anchor.route && canonicalRoute(anchor.route) !== canonicalRoute(realPage())) return { status: 'missing', element: null, candidates: [] };
    let current = null;
    try { if (record?.selector) current = document.querySelector(record.selector); } catch {}
    if (current) {
      const score = anchorMatch(anchor, current);
      if (score >= .72 || (!anchor.accessibleName && !anchor.text && !anchor.role)) return { status: 'located', element: current, candidates: [] };
    }
    const nodes = [...document.querySelectorAll('a,button,input,select,textarea,[role],[data-testid],[data-test],h1,h2,h3,p,section,main')].slice(0, 900);
    const ranked = nodes.map((element) => ({ element, score: anchorMatch(anchor, element) })).filter((entry) => entry.score >= .72).sort((a,b)=>b.score-a.score);
    if (!ranked.length) return { status: 'missing', element: null, candidates: [] };
    const candidates = ranked.slice(0,3).map(({element,score})=>({ ...describe(element), score }));
    if (ranked[1] && ranked[0].score - ranked[1].score < .12) return { status: 'ambiguous', element: null, candidates };
    return { status: 'recovered', element: ranked[0].element, candidates };
  }
  const visualPage = () => `${location.origin}${location.pathname}${location.search}`;
  function renderVisuals() {
    const width = Math.max(document.documentElement.scrollWidth, innerWidth);
    const height = Math.max(document.documentElement.scrollHeight, innerHeight);
    visuals.style.width = `${width}px`; visuals.style.height = `${height}px`; visuals.replaceChildren();
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', width); svg.setAttribute('height', height);
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;';
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker'); marker.id = 'uidit-arrowhead'; marker.setAttribute('markerWidth','10'); marker.setAttribute('markerHeight','8'); marker.setAttribute('refX','8'); marker.setAttribute('refY','4'); marker.setAttribute('orient','auto');
    const head = document.createElementNS(svgNS, 'path'); head.setAttribute('d','M0,0 L9,4 L0,8 Z'); head.setAttribute('fill','#785bff'); marker.append(head); defs.append(marker); svg.append(defs);
    const matchesPage = (c) => !c.page || canonicalRoute(c.page) === canonicalRoute(realPage());
    const elements = new Map(visualState.elements.map((e) => [e.id, e]));
    const visibleComments = visualState.comments.filter((c) => !c.resolved && matchesPage(c));
    for (const c of visibleComments) {
      if (!c.drawing || !Array.isArray(c.drawing.points)) continue;
      const pts = c.drawing.points.map((p) => ({ x: p.x * width, y: p.y * height })); if (!pts.length) continue;
      const shape = document.createElementNS(svgNS, c.drawing.type === 'ellipse' ? 'ellipse' : c.drawing.type === 'rectangle' ? 'rect' : 'path');
      shape.setAttribute('fill', c.drawing.type === 'ellipse' || c.drawing.type === 'rectangle' ? 'rgba(120,91,255,.10)' : 'none'); shape.setAttribute('stroke','#785bff'); shape.setAttribute('stroke-width','3'); shape.setAttribute('stroke-linecap','round'); shape.setAttribute('stroke-linejoin','round');
      if (c.drawing.type === 'rectangle') { shape.setAttribute('x',Math.min(pts[0].x,pts.at(-1).x)); shape.setAttribute('y',Math.min(pts[0].y,pts.at(-1).y)); shape.setAttribute('width',Math.abs(pts.at(-1).x-pts[0].x)); shape.setAttribute('height',Math.abs(pts.at(-1).y-pts[0].y)); }
      else if (c.drawing.type === 'ellipse') { shape.setAttribute('cx',(pts[0].x+pts.at(-1).x)/2); shape.setAttribute('cy',(pts[0].y+pts.at(-1).y)/2); shape.setAttribute('rx',Math.max(2,Math.abs(pts.at(-1).x-pts[0].x)/2)); shape.setAttribute('ry',Math.max(2,Math.abs(pts.at(-1).y-pts[0].y)/2)); }
      else { shape.setAttribute('d',pts.map((p,i)=>`${i?'L':'M'}${p.x} ${p.y}`).join(' ')); if (c.drawing.type === 'arrow') shape.setAttribute('marker-end','url(#uidit-arrowhead)'); }
      const title = document.createElementNS(svgNS,'title'); title.textContent = c.text; shape.append(title); svg.append(shape);
    }
    visuals.append(svg);
    visibleComments.filter((c) => !c.drawing).forEach((c, index) => {
      const record = elements.get(c.elementId); const located = c.elementId ? locateCommentTarget(c, record) : { status: 'missing', element: null, candidates: [] }; const el = located.element;
      const signature = `${located.status}:${located.candidates.map((candidate)=>candidate.selector).join('|')}`;
      if (c.elementId && anchorStatusCache.get(c.id) !== signature) { anchorStatusCache.set(c.id, signature); post('anchor-status', { commentId: c.id, status: located.status, candidates: located.candidates }); }
      const markerNode = document.createElement('button'); markerNode.type='button'; markerNode.className='uidit-comment-marker'; markerNode.setAttribute('data-uidit-ui','1'); markerNode.textContent=String(index+1); markerNode.title=c.text; markerNode.setAttribute('aria-label',`Review comment: ${c.text}`);
      markerNode.style.cssText='position:absolute;pointer-events:auto;left:0;top:0;transform:translate(-50%,-50%);width:27px;height:27px;border:2px solid white;border-radius:50%;background:#785bff;color:white;font:700 12px system-ui;box-shadow:0 3px 14px #17132270;cursor:pointer;';
      const rect=el?.getBoundingClientRect(); const hasAnchor=Number.isFinite(c.anchor?.x)&&Number.isFinite(c.anchor?.y); const x=rect?rect.left+scrollX+rect.width/2:hasAnchor?c.anchor.x*width:width-34; const y=rect?rect.top+scrollY:hasAnchor?c.anchor.y*height:24+index*34;
      markerNode.style.left=`${x}px`; markerNode.style.top=`${y}px`;
      const pop=document.createElement('section');pop.className='uidit-comment-thread';pop.setAttribute('role','dialog');pop.setAttribute('aria-label','Comment thread');pop.hidden=c.id!==openCommentId;pop.setAttribute('data-uidit-ui','1');
      pop.style.cssText='position:absolute;z-index:1;left:0;top:0;transform:translate(18px,14px);width:min(300px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 48px));overflow:auto;padding:12px;border:1px solid #3d3a4b;border-radius:11px;background:#211f2b;color:#f5f4fa;font:12px/1.45 system-ui;box-shadow:0 10px 32px #17132255;pointer-events:auto;';
      pop.style.left=`${x}px`; pop.style.top=`${y}px`;
      const head=document.createElement('div');head.textContent=`Comment ${index+1}`;head.style.cssText='font-weight:700;font-size:11px;color:#c9c4dc;margin-bottom:6px;';
      const original=document.createElement('p');original.textContent=c.text;original.style.cssText='margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;';
      const replies=document.createElement('div');replies.style.cssText='display:grid;gap:6px;margin:7px 0;';
      (Array.isArray(c.replies)?c.replies:[]).forEach((reply)=>{const item=document.createElement('div');item.style.cssText='padding:7px 8px;border-radius:7px;background:#302e3b;';const author=document.createElement('strong');author.textContent=reply.author==='agent'?'Agent':'You';author.style.cssText='display:block;margin-bottom:2px;font-size:10px;color:#c4b9ff;';const text=document.createElement('span');text.textContent=reply.text;item.append(author,text);replies.append(item);});
      const input=document.createElement('textarea');input.maxLength=4000;input.setAttribute('aria-label','Reply to comment');input.placeholder='Reply or ask the agent a question';input.style.cssText='display:block;box-sizing:border-box;width:100%;min-height:58px;resize:vertical;padding:8px;border:1px solid #4c4959;border-radius:7px;background:#17161f;color:#fff;font:12px/1.45 system-ui;';
      const send=document.createElement('button');send.type='button';send.textContent='Reply';send.disabled=true;send.style.cssText='display:block;margin:7px 0 0 auto;padding:6px 10px;border:0;border-radius:6px;background:#a99af5;color:#171522;font:600 11px system-ui;cursor:pointer;';
      input.addEventListener('input',()=>{send.disabled=!input.value.trim();});
      send.addEventListener('click',async()=>{if(!input.value.trim())return;send.disabled=true;send.textContent='Sending…';try{await api('/comment-reply','POST',{commentId:c.id,text:input.value.trim()});input.value='';openCommentId=null;renderVisuals();}catch(err){send.disabled=false;send.textContent='Retry';post('error',{message:err.message});}});
      pop.append(head,original,replies,input,send);visuals.append(pop);
      markerNode.addEventListener('click',(ev)=>{ev.stopPropagation();openCommentId=openCommentId===c.id?null:c.id;visuals.querySelectorAll('.uidit-comment-thread').forEach((thread)=>thread.hidden=true);pop.hidden=openCommentId!==c.id;if(el){restoreSelected();state.selected={el,record:describe(el)};el.setAttribute('data-uidit-selected','1');}});
      visuals.append(markerNode);
    });
  }
  let drawSvg = null, drawShape = null;
  function setDrawingTool(tool) {
    drawingTool = tool; drawStart = null;
    if (drawSvg) drawSvg.remove(); drawSvg = null;
    document.documentElement.style.cursor = tool === 'off' ? '' : 'crosshair';
    if (tool === 'off') return;
    drawSvg = document.createElementNS(svgNS,'svg'); drawSvg.setAttribute('viewBox',`0 0 ${innerWidth} ${innerHeight}`);
    drawSvg.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:auto;touch-action:none;cursor:crosshair;';
    const defs=document.createElementNS(svgNS,'defs'), arrow=document.createElementNS(svgNS,'marker'), arrowPath=document.createElementNS(svgNS,'path');arrow.id='uidit-arrowhead';arrow.setAttribute('markerWidth','10');arrow.setAttribute('markerHeight','8');arrow.setAttribute('refX','8');arrow.setAttribute('refY','4');arrow.setAttribute('orient','auto');arrowPath.setAttribute('d','M0,0 L9,4 L0,8 Z');arrowPath.setAttribute('fill','#785bff');arrow.append(arrowPath);defs.append(arrow);drawSvg.append(defs);
    document.documentElement.append(drawSvg);
    drawSvg.addEventListener('pointerdown',e=>{if(e.target.closest?.('[data-uidit-ui]'))return;drawStart={x:e.clientX,y:e.clientY};drawShape=document.createElementNS(svgNS,tool==='ellipse'?'ellipse':tool==='rectangle'?'rect':'path');drawShape.setAttribute('fill',tool==='freehand'||tool==='arrow'?'none':'rgba(120,91,255,.10)');drawShape.setAttribute('stroke','#785bff');drawShape.setAttribute('stroke-width','3');drawShape.setAttribute('stroke-linecap','round');drawShape.setAttribute('stroke-linejoin','round');if(tool==='arrow')drawShape.setAttribute('marker-end','url(#uidit-arrowhead)');drawSvg.append(drawShape);drawSvg.setPointerCapture(e.pointerId);e.preventDefault()});
    drawSvg.addEventListener('pointermove',e=>{if(!drawStart||!drawShape)return;const x=e.clientX,y=e.clientY;if(tool==='rectangle'){drawShape.setAttribute('x',Math.min(drawStart.x,x));drawShape.setAttribute('y',Math.min(drawStart.y,y));drawShape.setAttribute('width',Math.abs(x-drawStart.x));drawShape.setAttribute('height',Math.abs(y-drawStart.y))}else if(tool==='ellipse'){drawShape.setAttribute('cx',(drawStart.x+x)/2);drawShape.setAttribute('cy',(drawStart.y+y)/2);drawShape.setAttribute('rx',Math.abs(x-drawStart.x)/2);drawShape.setAttribute('ry',Math.abs(y-drawStart.y)/2)}else drawShape.setAttribute('d',`${drawShape.getAttribute('d')||`M${drawStart.x} ${drawStart.y}`} L${x} ${y}`);e.preventDefault()});
    drawSvg.addEventListener('pointerup',async e=>{if(!drawStart||!drawShape)return;const start=drawStart;const end={x:e.clientX,y:e.clientY};drawStart=null;const pageWidth=Math.max(document.documentElement.scrollWidth,innerWidth),pageHeight=Math.max(document.documentElement.scrollHeight,innerHeight);const points=tool==='freehand'?parsePath(drawShape.getAttribute('d')).slice(0,500).map(p=>({x:(p.x+scrollX)/pageWidth,y:(p.y+scrollY)/pageHeight})):[start,end].map(p=>({x:(p.x+scrollX)/pageWidth,y:(p.y+scrollY)/pageHeight}));drawSvg.remove();drawSvg=null;document.documentElement.style.cursor='';drawingTool='off';try{await api('/comment','POST',{text:`${tool[0].toUpperCase()+tool.slice(1)} annotation for the coding agent`,elementId:null,page:realPage(),drawing:{type:tool,points,pageWidth,pageHeight}});post('drawn',{tool})}catch(err){post('error',{message:err.message})}});
  }
  function parsePath(d){return [...(d||'').matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(m=>({x:Number(m[1]),y:Number(m[2])}));}
  addEventListener('resize',renderVisuals); addEventListener('scroll',()=>{ if (!document.activeElement?.closest?.('.uidit-comment-thread')) renderVisuals(); },true);

  // Highlight via attribute, never inline styles: the element's own style attribute
  // must stay pristine so recorded `before` values are the real page values.
  function paint(el, on) {
    if (!el) return;
    if (on) el.setAttribute('data-uidit-hover', '1');
    else el.removeAttribute('data-uidit-hover');
  }

  function restoreSelected() {
    if (state.selected) state.selected.el.removeAttribute('data-uidit-selected');
    if (state.pendingStyle && state.pendingStyle.el) {
      for (const [prop, value] of Object.entries(state.pendingStyle.props)) {
        const el = state.pendingStyle.el;
        if (value) el.style.setProperty(prop, value, 'important');
        else el.style.removeProperty(prop);
      }
    }
    state.selected = null;
    state.pendingStyle = null;
  }

  function select(el) {
    restoreSelected();
    state.selected = { el, record: describe(el) };
    el.setAttribute('data-uidit-selected', '1');
    paint(el, true);
    return api('/element', 'POST', state.selected.record)
      .then(({ element }) => {
        if (state.selected?.el === el) state.selected.record = element;
        post('selected', { element });
        return element;
      })
      .catch((err) => post('error', { message: err.message }));
  }

  const contextMenu = document.createElement('div');
  contextMenu.id = 'uidit-context-menu';
  contextMenu.className = 'uidit-context-menu';
  contextMenu.setAttribute('data-uidit-ui', '1');
  contextMenu.setAttribute('role', 'menu');
  contextMenu.setAttribute('aria-label', 'Page review actions');
  contextMenu.hidden = true;
  document.documentElement.append(contextMenu);
  let contextTarget = null;
  let contextPoint = null;
  let contextElementId = null;
  function closeContextMenu() {
    contextMenu.hidden = true;
    if (contextTarget && contextTarget !== state.selected?.el) paint(contextTarget, false);
    contextTarget = null;
    contextPoint = null;
  }
  function openContextMenu(ev) {
    if (ev.target.closest?.('[data-uidit-ui]')) return;
    ev.preventDefault();
    contextTarget = ev.target.nodeType === 1 ? ev.target : ev.target.parentElement;
    contextPoint = { x: ev.clientX, y: ev.clientY };
    contextElementId = null;
    if (contextTarget && contextTarget !== document.body && contextTarget !== document.documentElement) paint(contextTarget, true);
    const pageTarget = !contextTarget || contextTarget === document.body || contextTarget === document.documentElement;
    contextMenu.setAttribute('role', 'menu');
    contextMenu.innerHTML = `<div class="uidit-context-title">UIDIT <span>${pageTarget ? 'Page actions' : 'Element actions'}</span></div>
      <button type="button" role="menuitem" data-context-action="comment">${pageTarget ? 'Add page note' : 'Comment on this element'}</button>
      ${pageTarget ? '' : '<button type="button" role="menuitem" data-context-action="inspect">Inspect this element</button><button type="button" role="menuitem" data-context-action="edit">Quick edit text</button>'}
      <div class="uidit-context-divider"></div><div class="uidit-context-label">Draw on page</div>
      <button type="button" role="menuitem" data-context-action="draw-arrow">Draw an arrow</button>
      <button type="button" role="menuitem" data-context-action="draw-rectangle">Draw a rectangle</button>
      <div class="uidit-context-divider"></div><button type="button" role="menuitem" data-context-action="copy">${pageTarget ? 'Copy page URL' : 'Copy selector'}</button>`;
    contextMenu.hidden = false;
    contextMenu.style.left = `${Math.max(8, Math.min(ev.clientX, innerWidth - 250))}px`;
    contextMenu.style.top = `${Math.max(8, Math.min(ev.clientY, innerHeight - 360))}px`;
    requestAnimationFrame(() => {
      const rect = contextMenu.getBoundingClientRect();
      contextMenu.style.left = `${Math.max(8, Math.min(ev.clientX, innerWidth - rect.width - 8))}px`;
      contextMenu.style.top = `${Math.max(8, Math.min(ev.clientY, innerHeight - rect.height - 8))}px`;
    });
  }
  contextMenu.addEventListener('click', async (ev) => {
    const button = ev.target.closest('[data-context-action]');
    if (!button) return;
    const action = button.dataset.contextAction;
    try {
      if (action === 'comment') {
        const target = contextTarget && contextTarget !== document.body && contextTarget !== document.documentElement ? contextTarget : null;
        if (target) { const element = await select(target); contextElementId = element?.id ?? null; }
        else { restoreSelected(); post('selected', { element: null }); }
        const pageOnly = !target;
        contextMenu.setAttribute('role', 'dialog');
        contextMenu.setAttribute('aria-label', pageOnly ? 'Add a page note' : 'Comment on selected element');
        contextMenu.innerHTML = `<div class="uidit-context-title">${pageOnly ? 'Page note' : 'Comment'} <span>${pageOnly ? 'Page-level' : 'Selected element'}</span></div><label class="uidit-context-sr" for="uidit-context-note">What should change?</label><textarea id="uidit-context-note" maxlength="4000" placeholder="What should change?"></textarea><div class="uidit-context-actions"><button type="button" data-context-action="cancel">Cancel</button><button type="button" class="primary" data-context-action="post" disabled>Post note</button></div>`;
        const textarea = contextMenu.querySelector('textarea');
        const submit = contextMenu.querySelector('[data-context-action="post"]');
        textarea.addEventListener('input', () => { submit.disabled = !textarea.value.trim(); });
        textarea.focus();
        contextMenu.dataset.composer = '1';
        return;
      }
      if (action === 'cancel') { delete contextMenu.dataset.composer; closeContextMenu(); return; }
      if (action === 'post') {
        const text = contextMenu.querySelector('textarea')?.value.trim();
        if (!text) return;
        const pageWidth=Math.max(document.documentElement.scrollWidth,innerWidth),pageHeight=Math.max(document.documentElement.scrollHeight,innerHeight);
        const target=contextTarget&&contextTarget!==document.body&&contextTarget!==document.documentElement;
        const anchor=!target&&contextPoint?{x:Math.max(0,Math.min(1,(contextPoint.x+scrollX)/pageWidth)),y:Math.max(0,Math.min(1,(contextPoint.y+scrollY)/pageHeight))}:null;
        await api('/comment', 'POST', { elementId: contextElementId, page: realPage(), text, anchor });
        delete contextMenu.dataset.composer; closeContextMenu(); renderVisuals(); return;
      }
      const target = contextTarget;
      if (action === 'inspect' && target && target !== document.body && target !== document.documentElement) await select(target);
      if (action === 'edit' && target && target !== document.body && target !== document.documentElement) { await select(target); await handle({ type: 'mode', mode: 'text' }); }
      if (action === 'copy') await navigator.clipboard.writeText(target && target !== document.body && target !== document.documentElement ? uniqueSelector(target) : realPage());
      if (action === 'draw-arrow') setDrawingTool('arrow');
      if (action === 'draw-rectangle') setDrawingTool('rectangle');
      delete contextMenu.dataset.composer;
      closeContextMenu();
    } catch (err) { post('error', { message: err.message }); }
  });
  document.addEventListener('contextmenu', openContextMenu, true);
  document.addEventListener('pointerdown', (ev) => { if (!contextMenu.hidden && !contextMenu.contains(ev.target)) closeContextMenu(); }, true);

  async function applyStyle(prop, value) {
    const el = state.selected?.el;
    if (!el) return;
    if (typeof prop !== 'string' || prop.length > 100 || !/^(?:--[\w-]+|[a-z-]+)$/.test(prop) || (value !== null && (typeof value !== 'string' || value.length > 500 || (prop.startsWith('--') ? /[<>]/.test(value) : !CSS.supports(prop, value))))) { post('error', { message: 'That CSS value is invalid or unsupported' }); return; }
    const before = el.style.getPropertyValue(prop);
    if (!state.pendingStyle) state.pendingStyle = { el, props: {} };
    if (!Object.hasOwn(state.pendingStyle.props, prop)) state.pendingStyle.props[prop] = before;
    if (value === null) el.style.removeProperty(prop);
    else el.style.setProperty(prop, value, 'important');
    const edit = await api('/edit', 'POST', {
      elementId: state.selected.record.id,
      kind: 'style',
      property: prop,
      before,
      after: value,
      page: realPage(),
    });
    post('edited', { edit });
  }

  function openVariantComparison(variants) {
    const source = state.selected?.el;
    if (!source || !Array.isArray(variants) || variants.length > 4) { post('error', { message: 'Select a component before comparing design directions' }); return; }
    document.getElementById('uidit-variant-compare')?.remove();
    const host = document.createElement('section'); host.id = 'uidit-variant-compare'; host.dataset.uiditUi = '1';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{position:fixed;z-index:2147483646;inset:14px;display:block;color:#f7f6fc;font:13px/1.4 system-ui,sans-serif}
      .shell{height:100%;display:flex;flex-direction:column;overflow:hidden;border:1px solid #393644;border-radius:16px;background:#18171f;box-shadow:0 18px 60px #07060b99}
      header{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid #393644}header div{flex:1}header strong{font-size:14px}header small{display:block;margin-top:2px;color:#aaa7b7;font-size:11px}
      button{padding:7px 10px;border:1px solid #464252;border-radius:7px;color:#f7f6fc;background:#25232d;font:600 11px system-ui;cursor:pointer}button:hover{border-color:#a99bff}button.apply{border:0;color:#171522;background:#b8aaff}
      .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;min-height:0;flex:1;padding:14px;overflow:auto}
      article{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px;border:1px solid #393644;border-radius:12px;background:#211f29}article h2{margin:0;font-size:12px}article p{margin:0;color:#aaa7b7;font-size:10px}
      .preview{display:flex;align-items:center;justify-content:center;min-height:180px;flex:1;overflow:hidden;padding:14px;border:1px solid #393644;border-radius:9px;background:#f7f6fc;color:#18171f}
      .preview>*{max-width:100%;max-height:100%;overflow:hidden;pointer-events:none}.footer{display:flex;justify-content:flex-end}
      @media(max-width:900px){:host{inset:8px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.preview{min-height:125px}}
    </style><div class="shell"><header><div><strong>Compare design directions</strong><small>Choose a treatment to apply it to the selected component in your page preview.</small></div><button class="close" type="button" aria-label="Close comparison">Close</button></header><div class="grid"></div></div>`;
    shadow.querySelector('.close').addEventListener('click', () => host.remove());
    const sourceNodes = [source, ...source.querySelectorAll('*')];
    for (const variant of variants) {
      if (!variant || typeof variant.name !== 'string' || !Array.isArray(variant.styles)) continue;
      const card = document.createElement('article');
      const title = document.createElement('h2'); title.textContent = variant.name.slice(0, 60);
      const preview = document.createElement('div'); preview.className = 'preview';
      const clone = source.cloneNode(true); clone.removeAttribute('id'); clone.removeAttribute('data-uidit-selected'); clone.removeAttribute('data-uidit-hover');
      const cloneNodes = [clone, ...clone.querySelectorAll('*')];
      for (let index = 0; index < Math.min(sourceNodes.length, cloneNodes.length, 120); index += 1) {
        const sourceStyle = getComputedStyle(sourceNodes[index]); const cloneNode = cloneNodes[index];
        for (let propertyIndex = 0; propertyIndex < sourceStyle.length; propertyIndex += 1) { const property = sourceStyle.item(propertyIndex); cloneNode.style.setProperty(property, sourceStyle.getPropertyValue(property)); }
        cloneNode.removeAttribute('id'); cloneNode.removeAttribute('data-uidit-selected'); cloneNode.removeAttribute('data-uidit-hover'); cloneNode.style.pointerEvents = 'none';
      }
      Object.assign(clone.style, { position: 'static', inset: 'auto', width: 'auto', height: 'auto', minWidth: '0', minHeight: '0', maxWidth: '100%', maxHeight: '100%', margin: '0', transform: 'none' });
      for (const item of variant.styles.slice(0, 8)) if (item && typeof item.property === 'string' && typeof item.value === 'string') clone.style.setProperty(item.property, item.value, 'important');
      preview.append(clone);
      const description = document.createElement('p'); description.textContent = variant.description ?? '';
      const applyButton = document.createElement('button'); applyButton.type = 'button'; applyButton.className = 'apply'; applyButton.textContent = `Apply ${variant.name}`;
      applyButton.addEventListener('click', () => { host.remove(); post('control', { action: 'applyDesignVariant', name: variant.name, styles: variant.styles.slice(0, 8) }); });
      const footer = document.createElement('div'); footer.className = 'footer'; footer.append(applyButton);
      card.append(title, description, preview, footer); shadow.querySelector('.grid').append(card);
    }
    document.body.append(host);
  }

  function onClick(ev) {
    if (state.mode !== 'inspect') return;
    if (ev.target.closest?.('[data-uidit-ui]')) return;
    ev.preventDefault();
    ev.stopPropagation();
    select(ev.target);
  }

  function onMove(ev) {
    if (state.mode !== 'inspect') return;
    const el = ev.target;
    if (el === hoverEl) return;
    if (hoverEl && hoverEl !== state.selected?.el) paint(hoverEl, false);
    hoverEl = el;
    if (el !== state.selected?.el && !el.closest?.('[data-uidit-ui]')) paint(el, true);
  }

  installHighlightStyles();

  document.addEventListener('click', onClick, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeContextMenu();
      setDrawingTool('off');
      restoreSelected();
      post('selected', { element: null });
    }
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (ev.source === controls.contentWindow && ev.origin === controlOrigin && msg?.source === 'uidit-control') {
      if (msg.type === 'resize') controls.classList.toggle('uidit-open', msg.open === true);
      if (msg.type === 'action' && msg.action === 'move' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        const rect = controls.getBoundingClientRect();
        const x = Math.max(0, Math.min(innerWidth, rect.left + msg.x));
        const y = Math.max(0, Math.min(innerHeight, rect.top + msg.y));
        const column = x < innerWidth / 3 ? 'left' : x < innerWidth * 2 / 3 ? 'center' : 'right';
        const row = y < innerHeight / 3 ? 'top' : y < innerHeight * 2 / 3 ? 'middle' : 'bottom';
        savedAnchor = `${column}-${row}`;
        try { sessionStorage.setItem(anchorKey, savedAnchor); } catch {}
        setAnchor(savedAnchor);
      }
      if (msg.type === 'action' && msg.action === 'inspect' && typeof msg.enabled === 'boolean') post('control', { action: 'inspect', enabled: msg.enabled });
      if (msg.type === 'action' && msg.action === 'draw' && ['arrow', 'rectangle', 'ellipse', 'freehand', 'off'].includes(msg.tool)) post('control', { action: 'draw', tool: msg.tool });
      if (msg.type === 'action' && msg.action === 'comment' && typeof msg.text === 'string' && msg.text.trim().length <= 4000) post('control', { action: 'comment', text: msg.text.trim(), page: realPage(), elementId: state.selected?.record.id ?? null });
      if (msg.type === 'action' && msg.action === 'workspace' && ['feedback', 'inspect', 'changes', 'server', 'agents', 'settings'].includes(msg.tab)) post('control', { action: 'workspace', tab: msg.tab });
      if (msg.type === 'action' && msg.action === 'hide') controls.hidden = true;
      return;
    }
    if (ev.source !== window.parent || ev.origin !== parentOrigin || !msg || msg.source !== 'uidit-dashboard') return;
    if (msg.type === 'api-response' && typeof msg.id === 'string') {
      const pending = pendingRequests.get(msg.id); if (!pending) return;
      clearTimeout(pending.timer); pendingRequests.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result); else pending.reject(new Error(msg.error || 'UIDIT request failed'));
      return;
    }
    if (msg.type === 'recordMode') { setRecording(msg.enabled === true, msg.flowId); return; }
    if (msg.type === 'variantCompare') { openVariantComparison(msg.variants); return; }
    if (msg.type === 'replayStep') {
      const { id, step } = msg;
      try {
        const isUrlAssertion = step?.type === 'assertion' && step.action === 'assertUrl';
        const el = step?.selector ? document.querySelector(step.selector) : null;
        if (step?.type !== 'navigation' && !isUrlAssertion && !el) throw new Error(`Element not found: ${step?.selector ?? 'missing selector'}`);
        if (step?.type === 'assertion') {
          if (step.action === 'assertUrl') {
            const expectedPath = (() => { try { return new URL(step.value, realPage()).pathname; } catch { return step.value; } })();
            if (new URL(realPage()).pathname !== expectedPath) throw new Error(`Expected route ${expectedPath}; observed ${new URL(realPage()).pathname}`);
          } else if (step.action === 'assertVisible') {
            const style = getComputedStyle(el); const bounds = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || bounds.width <= 0 || bounds.height <= 0) throw new Error('Element is not visible');
          } else if (step.action === 'assertText' && !collapse(el.textContent).includes(step.value ?? '')) throw new Error(`Expected text to include: ${step.value}`);
          else if (step.action === 'assertEnabled' && (el.disabled === true || el.getAttribute('aria-disabled') === 'true')) throw new Error('Element is disabled');
          post('replay-result', { id, ok: true, observed: step.action === 'assertUrl' ? realPage() : collapse(el.textContent).slice(0, 300) }); return;
        }
        if (step?.action === 'click') el.click();
        else if (step?.action === 'fill') {
          if (step.sensitive) throw new Error('Sensitive form value was not recorded');
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, step.value ?? ''); else el.value = step.value ?? '';
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (step?.action === 'check') {
          el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (step?.action === 'submit') {
          if (el.requestSubmit) el.requestSubmit(); else el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        } else if (step?.type === 'navigation' && step.page && realPage() !== step.page) throw new Error(`Open ${step.page} before replaying this flow`);
        post('replay-result', { id, ok: true });
      } catch (error) { post('replay-result', { id, ok: false, error: error.message }); }
      return;
    }
    if (msg.type === 'state') {
      setBrowserInspection(msg.browserInspection === true);
      if (!savedAnchor) setAnchor(msg.position === 'bottom-right' ? 'right-bottom' : 'left-bottom');
      if (Array.isArray(msg.comments) && Array.isArray(msg.elements)) { visualState = { comments: msg.comments, elements: msg.elements }; renderVisuals(); }
      // Keep the bridge's trusted discriminator after spreading dashboard
      // state, which carries its own `source` field.
      controls.contentWindow?.postMessage({ ...msg, source: 'uidit-preview', type: 'state' }, controlOrigin); return;
    }
    if (msg.type === 'browserAction') { runBrowserAction(msg.id, msg.action); return; }
    if (msg.type === 'componentStatePreview') {
      if (msg.state === 'reset') { componentStateRestore?.(); componentStateRestore = null; post('component-state', { state: 'reset', ok: true }); return; }
      const el = state.selected?.el;
      if (!el) { post('component-state', { state: msg.state, ok: false, error: 'Select an element first' }); return; }
      componentStateRestore?.(); componentStateRestore = null;
      if (msg.state === 'focus') {
        const previous = document.activeElement;
        const oldTabindex = el.getAttribute('tabindex');
        if (!el.matches('a[href],button,input,select,textarea,[tabindex]')) el.setAttribute('tabindex', '-1');
        el.focus?.({ preventScroll: true });
        componentStateRestore = () => { if (document.activeElement === el) el.blur?.(); if (oldTabindex === null) el.removeAttribute('tabindex'); else el.setAttribute('tabindex', oldTabindex); if (previous && previous !== document.body && previous.isConnected) previous.focus?.({ preventScroll: true }); };
        post('component-state', { state: 'focus', ok: true, label: 'Browser focus state; app state unchanged' }); return;
      }
      if (msg.state === 'disabled') {
        if (!('disabled' in el)) { post('component-state', { state: 'disabled', ok: false, error: 'This element does not support the disabled state' }); return; }
        const wasDisabled = el.disabled; el.disabled = true;
        componentStateRestore = () => { if (el.isConnected) el.disabled = wasDisabled; };
        post('component-state', { state: 'disabled', ok: true, label: 'Temporary DOM state; reload or Reset restores it' }); return;
      }
      if (['loading','error','empty','success','open','closed','selected'].includes(msg.state)) {
        const fixtures = window.__UIDIT_STATE_FIXTURES__;
        const fixture = fixtures && typeof fixtures === 'object' ? fixtures[msg.state] : null;
        if (typeof fixture !== 'function') { post('component-state', { state: msg.state, ok: false, error: `Add an app fixture at window.__UIDIT_STATE_FIXTURES__.${msg.state}` }); return; }
        try {
          const restore = fixture(el);
          if (typeof restore !== 'function') { post('component-state', { state: msg.state, ok: false, error: 'State fixture must return a restore function' }); return; }
          componentStateRestore = () => restore();
          post('component-state', { state: msg.state, ok: true, label: 'App fixture active; Reset restores the previous state' }); return;
        } catch (error) { post('component-state', { state: msg.state, ok: false, error: `State fixture failed: ${error.message}` }); return; }
      }
      post('component-state', { state: msg.state, ok: false, error: 'This state needs an application fixture and is not available through generic DOM preview' });
      return;
    }
    if (msg.type === 'browserControlRevoke') { setBrowserInspection(false); return; }
    if (msg.type === 'theme' && ['light', 'dark'].includes(msg.theme)) {
      controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'theme', theme: msg.theme }, controlOrigin); return;
    }
    if (msg.type === 'drawMode') { setDrawingTool(msg.tool); return; }
    if (msg.type === 'escape') { controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'escape' }, controlOrigin); }
    if (msg.type === 'hideControls') { controls.hidden = true; return; }
    handle(msg).catch((err) => post('error', { message: err.message }));
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key.toLowerCase() === 'u' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !/INPUT|TEXTAREA/.test(ev.target?.tagName ?? '')) controls.hidden = false;
  });

  async function handle(msg) {

    if (msg.type === 'mode') {
      state.mode = msg.mode;
      post('mode', { mode: state.mode });
      if (msg.mode === 'text' && state.selected) {
        state.selected.el.setAttribute('contenteditable', 'true');
        state.selected.el.focus();
        state.selected.el.addEventListener(
          'input',
          () => post('textdraft', { elementId: state.selected.record.id, text: collapse(state.selected.el.textContent) }),
          { once: true },
        );
      }
    }

    if (msg.type === 'comment') {
      const comment = await api('/comment', 'POST', {
        elementId: state.selected?.record.id ?? null,
        page: realPage(),
        text: msg.text,
      });
      post('commented', { comment });
    }

    if (msg.type === 'flashSelector') {
      const el = document.querySelector(msg.selector);
      if (el) {
        restoreSelected();
        state.selected = { el, record: describe(el) };
        el.setAttribute('data-uidit-selected', '1');
        paint(el, true);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        renderVisuals();
        api('/element', 'POST', state.selected.record)
          .then(({ element }) => post('selected', { element }))
          .catch((err) => post('error', { message: err.message }));
      } else {
        post('error', { message: `selector not found on this page: ${msg.selector}` });
      }
    }

    if (msg.type === 'style') applyStyle(msg.property, msg.value);

    if (msg.type === 'proposalPreview') {
      const el = state.selected?.el;
      if (!el || !Array.isArray(msg.changes) || msg.changes.length < 1 || msg.changes.length > 12 || !['style', 'text', 'class', 'attribute'].includes(msg.operation)) { post('error', { message: 'Select the proposal target before previewing it' }); return; }
      proposalRestore?.();
      const originalText = el.textContent;
      const originalClass = el.getAttribute('class');
      const before = msg.changes.map(({ property }) => ({ property, value: msg.operation === 'style' ? el.style.getPropertyValue(property) : msg.operation === 'attribute' ? el.getAttribute(property) : null }));
      const safeStyles = new Set(['color','background-color','padding','margin','gap','border','border-radius','box-shadow','font-size','font-weight','line-height','letter-spacing','text-align','width','max-width','min-height','display','align-items','justify-content']);
      const safeAttributes = new Set(['aria-label','title','alt','role']);
      try {
        for (const change of msg.changes) {
          if (msg.operation === 'style') { if (!safeStyles.has(change.property) || typeof change.value !== 'string' || !CSS.supports(change.property, change.value)) throw new Error(`Unsupported style proposal: ${change.property}`); el.style.setProperty(change.property, change.value); }
          else if (msg.operation === 'text') { if (typeof change.value !== 'string' || change.value.length > 500) throw new Error('Invalid text proposal'); el.textContent = change.value; }
          else if (msg.operation === 'class') { if (typeof change.value !== 'string' || !/^[\w-]{1,80}$/.test(change.value)) throw new Error('Invalid class proposal'); el.classList.add(change.value); }
          else { if (!safeAttributes.has(change.property) || typeof change.value !== 'string' || change.value.length > 200) throw new Error(`Unsupported attribute proposal: ${change.property}`); el.setAttribute(change.property, change.value); }
        }
      } catch (error) {
        for (const prior of before) if (msg.operation === 'style') { if (prior.value) el.style.setProperty(prior.property, prior.value); else el.style.removeProperty(prior.property); } else if (msg.operation === 'attribute') { if (prior.value === null) el.removeAttribute(prior.property); else el.setAttribute(prior.property, prior.value); }
        if (msg.operation === 'text') el.textContent = originalText;
        if (msg.operation === 'class') { if (originalClass === null) el.removeAttribute('class'); else el.setAttribute('class', originalClass); }
        post('error', { message: error.message }); return;
      }
      proposalRestore = () => { if (!el.isConnected) return; if (msg.operation === 'style') for (const prior of before) { if (prior.value) el.style.setProperty(prior.property, prior.value); else el.style.removeProperty(prior.property); } else if (msg.operation === 'text') el.textContent = originalText; else if (msg.operation === 'class') { if (originalClass === null) el.removeAttribute('class'); else el.setAttribute('class', originalClass); } else for (const prior of before) { if (prior.value === null) el.removeAttribute(prior.property); else el.setAttribute(prior.property, prior.value); } };
      post('proposal-preview', { ok: true, operation: msg.operation });
    }
    if (msg.type === 'proposalReset') { proposalRestore?.(); proposalRestore = null; post('proposal-preview', { ok: true, reset: true }); }

    if (msg.type === 'commitText') {
      const el = state.selected?.el;
      if (!el) return;
      const before = el.getAttribute('data-uidit-original-text') ?? collapse(msg.previous);
      el.setAttribute('data-uidit-original-text', before);
      el.removeAttribute('contenteditable');
      el.blur();
      const edit = await api('/edit', 'POST', {
        elementId: state.selected.record.id,
        kind: 'text',
        before,
        after: collapse(el.textContent),
        page: realPage(),
      });
      post('edited', { edit });
    }

    if (msg.type === 'attribute') {
      const el = state.selected?.el;
      if (!el) return;
      const before = el.getAttribute(msg.property);
      if (msg.value === null) el.removeAttribute(msg.property);
      else el.setAttribute(msg.property, msg.value);
      const edit = await api('/edit', 'POST', {
        elementId: state.selected.record.id,
        kind: 'attribute',
        property: msg.property,
        before,
        after: msg.value,
        page: realPage(),
      });
      post('edited', { edit });
    }

    if (msg.type === 'toggleClass') {
      const el = state.selected?.el;
      if (!el) return;
      const name = msg.name;
      const before = el.classList.contains(name);
      el.classList.toggle(name, msg.force ?? undefined);
      const edit = await api('/edit', 'POST', {
        elementId: state.selected.record.id,
        kind: 'class',
        property: name,
        before: before ? 'present' : 'absent',
        after: el.classList.contains(name) ? 'present' : 'absent',
        page: realPage(),
      });
      post('edited', { edit });
    }

    if (msg.type === 'remove') {
      const el = state.selected?.el;
      if (!el) return;
      const edit = await api('/edit', 'POST', {
        elementId: state.selected.record.id,
        kind: 'remove',
        before: collapse(el.textContent).slice(0, 120),
        after: null,
        page: realPage(),
      });
      el.remove();
      post('edited', { edit });
    }

    if (msg.type === 'revert') {
      proposalRestore?.(); proposalRestore = null;
      restoreSelected();
      post('selected', { element: null });
    }
  }

  post('ready', { url: realPage(), title: document.title });
})();
