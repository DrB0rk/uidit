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
  let textEditing = null;
  let drawingTool = 'off';
  let visualState = { comments: [], elements: [] };
  let openCommentId = null;
  const replyDrafts = new Map();
  let suppressCommentClickId = null;
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
  let agentAction = null;
  let agentVisual = null;
  let agentVisualFrame = 0;

  // UIDIT's controls live in a separate-origin iframe; only accept its tiny,
  // schema-checked message set from the exact embedded window.
  const controls = document.createElement('iframe');
  // The button is placed wherever the reviewer drags it, in viewport pixels. The
  // frame around it is sized and offset from that point, so the button keeps its
  // place when the panel opens or the window resizes.
  const positionKey = 'uidit-floating-position';
  const BUTTON = 48;
  const PANEL_MIN = 430; // button + gap + a panel tall enough to be worth opening
  let floating = null;
  let positionPinned = false;
  try {
    const [x, y] = String(sessionStorage.getItem(positionKey) || '').split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) { floating = { x, y }; positionPinned = true; }
  } catch {}

  function clampFloating(x, y) {
    return {
      x: Math.max(8, Math.min(x, Math.max(8, innerWidth - BUTTON - 8))),
      y: Math.max(8, Math.min(y, Math.max(8, innerHeight - BUTTON - 8))),
    };
  }

  function place() {
    if (!floating) return;
    const open = controls.classList.contains('uidit-open');
    // The frame takes the room beside the button (up to 320px) rather than moving
    // the button, so a narrow preview narrows the panel instead of shifting it.
    const roomRight = innerWidth - 8 - (floating.x - 6);
    const roomLeft = floating.x + 54 - 8;
    const growLeft = roomLeft > roomRight;
    const width = open ? Math.min(320, Math.max(180, growLeft ? roomLeft : roomRight)) : 62;
    const left = growLeft ? floating.x + 54 - width : floating.x - 6;
    const belowRoom = innerHeight - (floating.y - 6) - 8;
    const aboveRoom = floating.y + 54 - 8;
    const below = belowRoom >= PANEL_MIN || belowRoom >= aboveRoom;
    const height = open ? Math.max(70, Math.min(660, below ? belowRoom : aboveRoom)) : 62;
    const top = below ? floating.y - 6 : floating.y + 54 - height;
    controls.style.left = `${Math.round(Math.max(0, Math.min(left, innerWidth - width)))}px`;
    controls.style.top = `${Math.round(Math.max(0, Math.min(top, innerHeight - height)))}px`;
    controls.style.bottom = 'auto';
    controls.style.height = open ? `${Math.round(height)}px` : '';
    if (open) controls.style.width = `${Math.round(width)}px`;
    else controls.style.width = '';
    controls.classList.toggle('uidit-grow-left', growLeft);
    controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'placement', y: below ? 'below' : 'above', x: growLeft ? 'left' : 'right' }, controlOrigin);
  }

  function setFloating(x, y, persist = true) {
    floating = clampFloating(x, y);
    if (persist) {
      positionPinned = true;
      try { sessionStorage.setItem(positionKey, `${Math.round(floating.x)},${Math.round(floating.y)}`); } catch {}
    }
    place();
  }
  const bootstrap = document.currentScript;
  const controlOrigin = bootstrap?.dataset.control || 'http://127.0.0.1:12321';
  // The dashboard may have been opened as localhost while the bridge uses the
  // numeric loopback address. Use the actual embedding origin for postMessage.
  // `data-bridge` adds origins that may host the preview from another local port
  // (the agent-native review workspace); without it only the control port is trusted.
  const parentOrigin = (() => {
    const allowedBridge = new Set(String(bootstrap?.dataset.bridge || '').split(/\s+/).filter(Boolean));
    try {
      const origin = new URL(document.referrer).origin;
      const parentUrl = new URL(origin);
      const expectedPort = new URL(controlOrigin).port;
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parentUrl.hostname);
      return loopback && (parentUrl.port === expectedPort || allowedBridge.has(origin)) ? origin : controlOrigin;
    } catch { return controlOrigin; }
  })();
  window.__UIDIT_TARGET__ = bootstrap?.dataset.target || '';
  controls.src = `${controlOrigin}/floating?preview=${encodeURIComponent(location.origin)}`;
  controls.title = 'UIDIT review controls';
  controls.setAttribute('data-uidit-ui', '1');
  (document.documentElement || document).append(controls);
  if (!floating) floating = clampFloating(24, innerHeight - BUTTON - 24);
  place();
  window.addEventListener('resize', () => { floating = clampFloating(floating.x, floating.y); place(); });
  window.addEventListener('resize', scheduleAgentVisual, { passive: true });
  window.addEventListener('scroll', scheduleAgentVisual, { passive: true, capture: true });

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

  const agentErrorCode = (error) => {
    const text = String(error?.message ?? '').toLowerCase();
    if (text.includes('not found') || text.includes('not connected')) return 'target_missing';
    if (text.includes('sensitive')) return 'sensitive_target';
    if (text.includes('navigation')) return 'invalid_navigation';
    return 'action_failed';
  };

  function clearAgentVisual() {
    cancelAnimationFrame(agentVisualFrame);
    agentVisualFrame = 0;
    agentVisual?.remove();
    agentVisual = null;
  }

  function measureAgentVisual() {
    agentVisualFrame = 0;
    if (!agentVisual || !agentAction) return;
    const target = agentAction.element;
    const viewportAction = ['navigate', 'screenshot'].includes(agentAction.command.type);
    if (!viewportAction && (!target || !target.isConnected)) { clearAgentVisual(); return; }
    const bounds = viewportAction ? { left: 12, top: 12, width: Math.max(1, innerWidth - 24), height: Math.max(1, innerHeight - 24) } : target.getBoundingClientRect();
    const offscreen = bounds.right < 0 || bounds.bottom < 0 || bounds.left > innerWidth || bounds.top > innerHeight;
    const left = Math.max(8, Math.min(bounds.left, innerWidth - 28));
    const top = Math.max(8, Math.min(bounds.top, innerHeight - 28));
    agentVisual.style.setProperty('--agent-left', `${Math.round(left)}px`);
    agentVisual.style.setProperty('--agent-top', `${Math.round(top)}px`);
    agentVisual.style.setProperty('--agent-width', `${Math.max(2, Math.round(bounds.width))}px`);
    agentVisual.style.setProperty('--agent-height', `${Math.max(2, Math.round(bounds.height))}px`);
    if (offscreen) agentVisual.dataset.offscreen = bounds.left < 0 ? 'left' : bounds.left > innerWidth ? 'right' : bounds.top < 0 ? 'up' : 'down';
    else agentVisual.removeAttribute('data-offscreen');
  }

  function scheduleAgentVisual() {
    if (!agentVisualFrame) agentVisualFrame = requestAnimationFrame(measureAgentVisual);
  }

  function showAgentVisual(command, element) {
    clearAgentVisual();
    const visual = document.createElement('div');
    visual.className = 'uidit-agent-visual';
    visual.dataset.uiditUi = '1';
    visual.setAttribute('aria-hidden', 'true');
    visual.innerHTML = '<span class="uidit-agent-target"></span><span class="uidit-agent-cursor"></span><span class="uidit-agent-label"></span><span class="uidit-agent-direction"></span>';
    visual.querySelector('.uidit-agent-label').textContent = `${command.type} in progress`;
    document.documentElement.append(visual);
    agentVisual = visual;
    scheduleAgentVisual();
  }

  function actionTarget(command) {
    if (['navigate', 'screenshot'].includes(command.type)) return null;
    if (typeof command.selector !== 'string' || command.selector.length > 1000) return null;
    const element = document.querySelector(command.selector);
    return element && !element.closest?.('[data-uidit-ui]') ? element : null;
  }

  function actionBounds(element, command) {
    if (['navigate', 'screenshot'].includes(command.type)) return null;
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
  }

  function actionVisibility(bounds, command) {
    if (['navigate', 'screenshot'].includes(command.type)) return 'onscreen';
    if (!bounds || bounds.width < 1 || bounds.height < 1) return 'offscreen';
    if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > innerWidth || bounds.y + bounds.height > innerHeight) return 'partial';
    return 'onscreen';
  }

  function prepareAgentAction(msg) {
    const { actionId, generation, bridgeNonce, command } = msg;
    if (typeof actionId !== 'string' || !Number.isInteger(generation) || typeof bridgeNonce !== 'string' || !command || typeof command.type !== 'string') return;
    const element = actionTarget(command);
    if (!['navigate', 'screenshot'].includes(command.type) && !element) {
      post('browser-action-prepared', { actionId, generation, bridgeNonce, bounds: null, visibility: 'offscreen', errorCode: 'target_missing' });
      return;
    }
    agentAction = { actionId, generation, bridgeNonce, command, element };
    showAgentVisual(command, element);
    const bounds = actionBounds(element, command);
    post('browser-action-prepared', { actionId, generation, bridgeNonce, bounds, visibility: actionVisibility(bounds, command) });
  }

  async function executeAgentAction(msg) {
    if (!agentAction || msg.actionId !== agentAction.actionId || msg.generation !== agentAction.generation || msg.bridgeNonce !== agentAction.bridgeNonce || typeof msg.executeToken !== 'string') return;
    const { actionId, generation, bridgeNonce, command } = agentAction;
    try {
      if (command.type === 'navigate') {
        if (typeof command.path !== 'string' || !command.path.startsWith('/') || command.path.startsWith('//')) throw new Error('Invalid navigation');
        sessionStorage.setItem('uidit-agent-navigation', JSON.stringify({ actionId, navigationToken: msg.navigationToken, path: new URL(command.path, location.href).pathname }));
        post('browser-action-navigation-started', { actionId, generation, bridgeNonce, executeToken: msg.executeToken, navigationToken: msg.navigationToken });
        location.assign(new URL(command.path.startsWith('/proxy/') ? command.path : `/proxy${command.path}`, location.origin));
        return;
      }
      const element = agentAction.element;
      if (command.type === 'screenshot') {
        const screenshot = await captureStepScreenshot();
        if (!screenshot) throw new Error('Screenshot failed');
        post('browser-action-result', { actionId, generation, bridgeNonce, executeToken: msg.executeToken, outcome: 'ok', screenshot });
      } else {
        if (!element?.isConnected) throw new Error('Target not found');
        if (command.type === 'click') element.click();
        else if (command.type === 'focus') element.focus();
        else if (command.type === 'hover') element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
        else if (command.type === 'scroll') { element.scrollIntoView({ block: 'center', behavior: 'instant' }); scheduleAgentVisual(); }
        else if (command.type === 'fill') {
          if (isSensitive(element)) throw new Error('Sensitive target');
          if (!/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || typeof command.value !== 'string') throw new Error('Target not found');
          const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(element, command.value); else element.value = command.value;
          element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (command.type === 'keypress') {
          const key = ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', ' '].includes(command.key) ? command.key : null;
          if (!key) throw new Error('Invalid key');
          element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        } else throw new Error('Unsupported action');
        post('browser-action-result', { actionId, generation, bridgeNonce, executeToken: msg.executeToken, outcome: 'ok' });
      }
    } catch (error) {
      post('browser-action-result', { actionId, generation, bridgeNonce, executeToken: msg.executeToken, outcome: 'error', errorCode: agentErrorCode(error) });
    }
  }

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
    if ((!browserInspectionEnabled && action.type !== 'share-page-view') || typeof id !== 'string') { reply({ ok: false, error: 'Live browser inspection is disabled' }); return; }
    try {
      if (action.type === 'screenshot') { const screenshot = await captureStepScreenshot(); if (!screenshot) throw new Error('Screenshot could not be captured'); reply({ ok: true, result: { screenshot } }); return; }
      if (action.type === 'share-page-view') { reply({ ok: true, result: await captureHtmlSnapshot() }); return; }
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
  const captureHtmlSnapshot = async () => {
    const width = Math.max(320, Math.min(window.innerWidth || 1280, 10000));
    const height = Math.max(240, Math.min(window.innerHeight || 900, 10000));
    const source = document.documentElement;
    const clone = source.cloneNode(true);
    const sourceNodes = [source, ...source.querySelectorAll('*')];
    const cloneNodes = [clone, ...clone.querySelectorAll('*')];
    let embeddedAssetBytes = 0;
    const assetCache = new Map();
    const assetUrl = (rawUrl) => {
      try {
        const url = new URL(rawUrl, location.href);
        return url.origin === location.origin && url.pathname.startsWith('/proxy/') ? url.href : null;
      } catch { return null; }
    };
    const inlineLocalAsset = async (url) => {
      try {
        if (!url || embeddedAssetBytes >= 1_200_000) return null;
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 700);
        const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal }).finally(() => clearTimeout(timeout));
        const mime = response.headers.get('content-type')?.split(';')[0] || '';
        const blob = await response.blob();
        if (!response.ok || !/^image\/(?:jpeg|png|gif|webp|avif)$/.test(mime) || blob.size > 400_000 || embeddedAssetBytes + blob.size > 1_200_000) return null;
        embeddedAssetBytes += blob.size;
        const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return `data:${mime};base64,${btoa(binary)}`;
      } catch { return null; }
    };
    const visualProperties = 'display visibility position inset top right bottom left z-index box-sizing width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left overflow overflow-x overflow-y flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content justify-items gap row-gap column-gap grid grid-template-columns grid-template-rows grid-column grid-row order float clear transform transform-origin opacity color background-color background-image background-size background-position background-repeat border border-top border-right border-bottom border-left border-radius box-shadow object-fit object-position font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration text-transform white-space word-break overflow-wrap list-style list-style-type cursor';
    const properties = visualProperties.split(' ');
    const backgroundAssets = [];
    const imageAssets = [];
    for (let index = 0; index < sourceNodes.length; index += 1) {
      const original = sourceNodes[index];
      if (original.closest?.('[data-uidit-ui]')) continue;
      const background = getComputedStyle(original).getPropertyValue('background-image');
      for (const match of background.matchAll(/url\((?:"|')?(.*?)(?:"|')?\)/g)) backgroundAssets.push(assetUrl(match[1]));
      if (original.matches?.('img')) imageAssets.push(assetUrl(original.currentSrc || original.getAttribute('src') || ''));
    }
    // Fetch a bounded, de-duplicated set concurrently. A slow local image cannot hold
    // the rest of the snapshot hostage, and all results still pass the byte/type caps.
    const candidates = [...new Set([...backgroundAssets, ...imageAssets].filter(Boolean))].slice(0, 20);
    await Promise.all(candidates.map(async (url) => assetCache.set(url, await inlineLocalAsset(url))));
    const embeddedAsset = (rawUrl) => assetCache.get(assetUrl(rawUrl)) ?? null;
    for (let index = 0; index < sourceNodes.length; index += 1) {
      const original = sourceNodes[index], target = cloneNodes[index];
      if (!target || original.closest?.('[data-uidit-ui]')) continue;
      const computed = getComputedStyle(original);
      const declarations = [];
      for (const name of properties) {
        let value = computed.getPropertyValue(name);
        if (name === 'background-image' && value.includes('url(')) {
          const matches = [...value.matchAll(/url\((?:"|')?(.*?)(?:"|')?\)/g)];
          for (const match of matches) { const dataUrl = embeddedAsset(match[1]); if (dataUrl) value = value.replace(match[0], `url("${dataUrl}")`); }
        }
        declarations.push(`${name}:${value}`);
      }
      target.setAttribute('style', declarations.join(';'));
      if (original.matches?.('input,textarea,select,[contenteditable="true"]')) {
        target.removeAttribute('value'); target.removeAttribute('checked'); target.removeAttribute('selected');
        if (target.matches('textarea') || target.isContentEditable) target.textContent = '';
      }
    }
    clone.querySelectorAll('[data-uidit-ui],script,noscript,iframe,object,embed,base,meta[http-equiv],link,style').forEach((node) => node.remove());
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || (['href','src','xlink:href','action','formaction'].includes(attribute.name.toLowerCase()) && /^\s*javascript:/i.test(attribute.value))) node.removeAttribute(attribute.name);
      }
    }
    clone.querySelectorAll('form').forEach((form) => form.removeAttribute('action'));
    const imagePairs = sourceNodes.map((node, index) => node.matches?.('img') ? [node, cloneNodes[index]] : null).filter(Boolean);
    for (const [original, image] of imagePairs) {
      if (!image?.isConnected) continue;
      image.removeAttribute('srcset');
      const embedded = embeddedAsset(original?.currentSrc || image.getAttribute('src') || '');
      if (embedded) image.setAttribute('src', embedded);
      else {
        try { const asset = new URL(image.getAttribute('src') || '', location.href); if (asset.origin === location.origin && asset.pathname.startsWith('/proxy/')) image.setAttribute('src', `${window.__UIDIT_TARGET__}${asset.pathname.slice('/proxy'.length)}${asset.search}`); }
        catch { image.removeAttribute('src'); }
      }
    }
    clone.setAttribute('data-uidit-snapshot', '1');
    const html = `<!doctype html>${clone.outerHTML}`;
    if (html.length > 2_000_000) throw new Error('HTML snapshot exceeds 2 MB; use a smaller page or a page image');
    return { html, width, height, url: realPage() };
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
  visuals.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none;overflow:visible;';
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
      const sameImage = anchor.tag?.toLowerCase() === 'img' && current.tagName === 'IMG'
        && (!anchor.accessibleName || fold(current.getAttribute('aria-label') || current.alt || current.title) === fold(anchor.accessibleName))
        && (!anchor.attributes?.src || current.getAttribute('src') === anchor.attributes.src);
      if (sameImage) return { status: 'located', element: current, candidates: [] };
      if (score >= .7 || (!anchor.accessibleName && !anchor.text && !anchor.role)) return { status: 'located', element: current, candidates: [] };
    }
    const nodes = [...document.querySelectorAll('a,button,input,select,textarea,img,[role],[data-testid],[data-test],h1,h2,h3,p,section,main')].slice(0, 900);
    const threshold = anchor.tag?.toLowerCase() === 'img' ? .64 : .7;
    const ranked = nodes.map((element) => ({ element, score: anchorMatch(anchor, element) })).filter((entry) => entry.score >= threshold).sort((a,b)=>b.score-a.score);
    if (!ranked.length) return { status: 'missing', element: null, candidates: [] };
    const candidates = ranked.slice(0,3).map(({element,score})=>({ ...describe(element), score }));
    if (ranked[1] && ranked[0].score - ranked[1].score < .12) return { status: 'ambiguous', element: null, candidates };
    return { status: 'recovered', element: ranked[0].element, candidates };
  }
  const visualPage = () => `${location.origin}${location.pathname}${location.search}`;
  // The controls and this overlay's visuals hang off <html>, so a documentElement
  // measurement would include them and grow with every render. Measure the app.
  function pageSize() {
    return {
      width: Math.max(document.body?.scrollWidth ?? 0, innerWidth),
      height: Math.max(document.body?.scrollHeight ?? 0, innerHeight),
    };
  }
  function moveFeedback(comment, dx, dy) {
    const { width, height } = pageSize();
    let patch;
    if (comment.drawing && Array.isArray(comment.drawing.points)) {
      patch = { drawing: { ...comment.drawing, points: comment.drawing.points.map((point) => ({
        x: Math.max(0, Math.min(1, point.x + dx / width)),
        y: Math.max(0, Math.min(1, point.y + dy / height)),
      })) } };
    } else {
      const element = comment.elementId && locateCommentTarget(comment, visualState.elements.find((item) => item.id === comment.elementId)).element;
      if (element) {
        const offset = comment.markerOffset ?? { x: 0, y: 0 };
        patch = { markerOffset: { x: Math.max(-1, Math.min(1, offset.x + dx / width)), y: Math.max(-1, Math.min(1, offset.y + dy / height)) } };
      } else {
        const anchor = comment.anchor ?? { x: (innerWidth - 34 + scrollX) / width, y: (24 + scrollY) / height };
        patch = { anchor: { x: Math.max(0, Math.min(1, anchor.x + dx / width)), y: Math.max(0, Math.min(1, anchor.y + dy / height)) } };
      }
    }
    Object.assign(comment, patch);
    renderVisuals();
    post('comment-move', { commentId: comment.id, patch });
  }
  function bindFeedbackMove(node, comment, { shape = false, x = 0, y = 0 } = {}) {
    let drag = null;
    node.setAttribute('aria-grabbed', 'false');
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      node.setAttribute('aria-grabbed', 'true');
      node.setPointerCapture?.(event.pointerId);
    });
    node.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      event.preventDefault();
      if (shape) node.setAttribute('transform', `translate(${dx} ${dy})`);
      else { node.style.left = `${x + dx}px`; node.style.top = `${y + dy}px`; }
    });
    const finish = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const current = drag; drag = null;
      node.setAttribute('aria-grabbed', 'false');
      if (current.moved) {
        if (!shape) suppressCommentClickId = comment.id;
        moveFeedback(comment, event.clientX - current.x, event.clientY - current.y);
        if (!shape) setTimeout(() => { if (suppressCommentClickId === comment.id) suppressCommentClickId = null; }, 0);
      }
    };
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', () => { drag = null; node.setAttribute('aria-grabbed', 'false'); node.removeAttribute('transform'); });
    node.addEventListener('keydown', (event) => {
      const moves = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
      const delta = moves[event.key];
      if (!delta) return;
      event.preventDefault();
      moveFeedback(comment, delta[0], delta[1]);
    });
  }
  function renderVisuals() {
    const { width, height } = pageSize();
    visuals.style.width = `${innerWidth}px`; visuals.style.height = `${innerHeight}px`; visuals.replaceChildren();
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`); svg.setAttribute('width', innerWidth); svg.setAttribute('height', innerHeight);
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;';
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker'); marker.id = 'uidit-arrowhead'; marker.setAttribute('markerWidth','10'); marker.setAttribute('markerHeight','8'); marker.setAttribute('refX','8'); marker.setAttribute('refY','4'); marker.setAttribute('orient','auto');
    const head = document.createElementNS(svgNS, 'path'); head.setAttribute('d','M0,0 L9,4 L0,8 Z'); head.setAttribute('fill','#785bff'); marker.append(head); defs.append(marker); svg.append(defs);
    const matchesPage = (c) => !c.page || canonicalRoute(c.page) === canonicalRoute(realPage());
    const elements = new Map(visualState.elements.map((e) => [e.id, e]));
    const visibleComments = visualState.comments.filter((c) => !c.resolved && matchesPage(c));
    for (const c of visibleComments) {
      if (!c.drawing || !Array.isArray(c.drawing.points)) continue;
      const pts = c.drawing.points.map((p) => ({ x: p.x * width - scrollX, y: p.y * height - scrollY })); if (!pts.length) continue;
      const group = document.createElementNS(svgNS, 'g');
      group.classList.add('uidit-drawing'); group.dataset.commentId = c.id; group.tabIndex = 0; group.setAttribute('role', 'button'); group.setAttribute('aria-label', `Move ${c.drawing.type} annotation`); group.style.cursor = 'grab';
      const shape = document.createElementNS(svgNS, c.drawing.type === 'ellipse' ? 'ellipse' : c.drawing.type === 'rectangle' ? 'rect' : 'path');
      shape.style.pointerEvents = 'all';
      shape.setAttribute('fill', c.drawing.type === 'ellipse' || c.drawing.type === 'rectangle' ? 'rgba(120,91,255,.10)' : 'none'); shape.setAttribute('stroke','#785bff'); shape.setAttribute('stroke-width','3'); shape.setAttribute('stroke-linecap','round'); shape.setAttribute('stroke-linejoin','round');
      if (c.drawing.type === 'rectangle') { shape.setAttribute('x',Math.min(pts[0].x,pts.at(-1).x)); shape.setAttribute('y',Math.min(pts[0].y,pts.at(-1).y)); shape.setAttribute('width',Math.abs(pts.at(-1).x-pts[0].x)); shape.setAttribute('height',Math.abs(pts.at(-1).y-pts[0].y)); }
      else if (c.drawing.type === 'ellipse') { shape.setAttribute('cx',(pts[0].x+pts.at(-1).x)/2); shape.setAttribute('cy',(pts[0].y+pts.at(-1).y)/2); shape.setAttribute('rx',Math.max(2,Math.abs(pts.at(-1).x-pts[0].x)/2)); shape.setAttribute('ry',Math.max(2,Math.abs(pts.at(-1).y-pts[0].y)/2)); }
      else { shape.setAttribute('d',pts.map((p,i)=>`${i?'L':'M'}${p.x} ${p.y}`).join(' ')); if (c.drawing.type === 'arrow') shape.setAttribute('marker-end','url(#uidit-arrowhead)'); }
      if (c.drawing.type === 'arrow' || c.drawing.type === 'freehand') {
        const hitTarget = shape.cloneNode(false);
        hitTarget.removeAttribute('marker-end');
        hitTarget.setAttribute('stroke', 'transparent'); hitTarget.setAttribute('stroke-width', '18');
        hitTarget.style.pointerEvents = 'stroke';
        group.append(hitTarget);
      }
      const title = document.createElementNS(svgNS,'title'); title.textContent = c.text; shape.append(title); group.append(shape); bindFeedbackMove(group, c, { shape: true }); svg.append(group);
    }
    visuals.append(svg);
    visibleComments.filter((c) => !c.drawing).forEach((c, index) => {
      const record = elements.get(c.elementId); const located = c.elementId ? locateCommentTarget(c, record) : { status: 'missing', element: null, candidates: [] }; const el = located.element;
      const signature = `${located.status}:${located.candidates.map((candidate)=>candidate.selector).join('|')}`;
      if (c.elementId && anchorStatusCache.get(c.id) !== signature) { anchorStatusCache.set(c.id, signature); post('anchor-status', { commentId: c.id, status: located.status, candidates: located.candidates }); }
      const markerNode = document.createElement('button'); markerNode.type='button'; markerNode.className='uidit-comment-marker'; markerNode.setAttribute('data-uidit-ui','1'); markerNode.dataset.uiditCommentId=c.id; markerNode.textContent=String(index+1); markerNode.title=c.text; markerNode.setAttribute('aria-label',`Review comment: ${c.text}`);
      markerNode.style.cssText='position:fixed;pointer-events:auto;left:0;top:0;transform:translate(-50%,-50%);width:27px;height:27px;border:2px solid white;border-radius:50%;background:#785bff;color:white;font:700 12px system-ui;box-shadow:0 3px 14px #17132270;cursor:pointer;';
      const rect=el?.getBoundingClientRect(); const hasAnchor=Number.isFinite(c.anchor?.x)&&Number.isFinite(c.anchor?.y); const offset=c.markerOffset??{x:0,y:0}; const x=rect?rect.left+rect.width/2+offset.x*width:hasAnchor?c.anchor.x*width-scrollX:innerWidth-34; const y=rect?rect.top+offset.y*height:hasAnchor?c.anchor.y*height-scrollY:24+index*34;
      markerNode.style.left=`${x}px`; markerNode.style.top=`${y}px`;
      markerNode.setAttribute('aria-description', 'Drag to move this feedback marker. Use arrow keys while focused to nudge it.');
      bindFeedbackMove(markerNode, c, { x, y });
      const pop=document.createElement('section');pop.className='uidit-comment-thread';pop.setAttribute('role','dialog');pop.setAttribute('aria-label','Comment thread');pop.hidden=c.id!==openCommentId;pop.setAttribute('data-uidit-ui','1');
      pop.style.cssText='position:fixed;z-index:1;left:0;top:0;transform:translate(18px,14px);width:min(300px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 48px));overflow:auto;padding:12px;border:1px solid #3d3a4b;border-radius:11px;background:#211f2b;color:#f5f4fa;font:12px/1.45 system-ui;box-shadow:0 10px 32px #17132255;pointer-events:auto;';
      pop.style.left=`${x}px`; pop.style.top=`${y}px`;
      const head=document.createElement('div');head.textContent=`Comment ${index+1}`;head.style.cssText='font-weight:700;font-size:11px;color:#c9c4dc;margin-bottom:6px;';
      const original=document.createElement('p');original.textContent=c.text;original.style.cssText='margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;';
      const replies=document.createElement('div');replies.style.cssText='display:grid;gap:6px;margin:7px 0;';
      (Array.isArray(c.replies)?c.replies:[]).forEach((reply)=>{const item=document.createElement('div');item.style.cssText='padding:7px 8px;border-radius:7px;background:#302e3b;';const author=document.createElement('strong');author.textContent=reply.author==='agent'?'Agent':'You';author.style.cssText='display:block;margin-bottom:2px;font-size:10px;color:#c4b9ff;';const text=document.createElement('span');text.textContent=reply.text;item.append(author,text);replies.append(item);});
      const input=document.createElement('textarea');input.maxLength=4000;input.setAttribute('aria-label','Reply to comment');input.placeholder='Reply or ask the agent a question';input.style.cssText='display:block;box-sizing:border-box;width:100%;min-height:58px;resize:vertical;padding:8px;border:1px solid #4c4959;border-radius:7px;background:#17161f;color:#fff;font:12px/1.45 system-ui;';input.value=replyDrafts.get(c.id)||'';
      const send=document.createElement('button');send.type='button';send.textContent='Reply';send.disabled=!input.value.trim();send.style.cssText='display:block;margin:7px 0 0 auto;padding:6px 10px;border:0;border-radius:6px;background:#a99af5;color:#171522;font:600 11px system-ui;cursor:pointer;';
      input.addEventListener('input',()=>{replyDrafts.set(c.id,input.value);send.disabled=!input.value.trim();});
      send.addEventListener('click',async()=>{if(!input.value.trim())return;send.disabled=true;send.textContent='Sending…';try{await api('/comment-reply','POST',{commentId:c.id,text:input.value.trim()});replyDrafts.delete(c.id);input.value='';openCommentId=null;renderVisuals();}catch(err){send.disabled=false;send.textContent='Retry';post('error',{message:err.message});}});
      pop.append(head,original,replies,input,send);visuals.append(pop);
      markerNode.addEventListener('click',(ev)=>{ev.stopPropagation();if(suppressCommentClickId===c.id){suppressCommentClickId=null;return}openCommentId=openCommentId===c.id?null:c.id;visuals.querySelectorAll('.uidit-comment-thread').forEach((thread)=>thread.hidden=true);pop.hidden=openCommentId!==c.id;if(el){restoreSelected();state.selected={el,record:describe(el)};el.setAttribute('data-uidit-selected','1');}});
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
    drawSvg.addEventListener('pointerup',async e=>{if(!drawStart||!drawShape)return;const start=drawStart;const end={x:e.clientX,y:e.clientY};drawStart=null;const {width:pageWidth,height:pageHeight}=pageSize();const points=tool==='freehand'?parsePath(drawShape.getAttribute('d')).slice(0,500).map(p=>({x:(p.x+scrollX)/pageWidth,y:(p.y+scrollY)/pageHeight})):[start,end].map(p=>({x:(p.x+scrollX)/pageWidth,y:(p.y+scrollY)/pageHeight}));drawSvg.remove();drawSvg=null;document.documentElement.style.cursor='';drawingTool='off';try{await api('/comment','POST',{text:`${tool[0].toUpperCase()+tool.slice(1)} annotation for the coding agent`,elementId:null,page:realPage(),drawing:{type:tool,points,pageWidth,pageHeight}});post('drawn',{tool})}catch(err){post('error',{message:err.message})}});
  }
  function parsePath(d){return [...(d||'').matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(m=>({x:Number(m[1]),y:Number(m[2])}));}
  function renderVisualsPreservingThread() {
    const thread = document.activeElement?.closest?.('.uidit-comment-thread');
    const input = thread?.querySelector('textarea');
    const value = input?.value;
    const start = input?.selectionStart;
    const end = input?.selectionEnd;
    renderVisuals();
    if (input && openCommentId) {
      const nextInput = visuals.querySelector('.uidit-comment-thread:not([hidden]) textarea');
      if (nextInput) { nextInput.value = value; nextInput.focus({ preventScroll: true }); nextInput.setSelectionRange(start, end); }
    }
  }
  addEventListener('resize',renderVisuals); addEventListener('scroll',renderVisualsPreservingThread,true);

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

  function beginTextEditing() {
    const el = state.selected?.el;
    if (!el || textEditing?.el === el) return;
    if (textEditing) finishTextEditing(true);
    textEditing = {
      el,
      before: collapse(el.textContent),
      contentEditable: el.getAttribute('contenteditable'),
      elementId: state.selected.record?.id ?? null,
    };
    el.setAttribute('contenteditable', 'true');
    el.focus({ preventScroll: true });
  }

  function placeTextCaret(ev) {
    if (!textEditing) return;
    const range = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
    if (!range || !textEditing.el.contains(range.startContainer)) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function finishTextEditing(commit = true) {
    const editing = textEditing;
    if (!editing) return;
    textEditing = null;
    if (!editing.el.isConnected) return;
    const after = collapse(editing.el.textContent);
    if (editing.contentEditable === null) editing.el.removeAttribute('contenteditable');
    else editing.el.setAttribute('contenteditable', editing.contentEditable);
    editing.el.blur();
    if (!commit || after === editing.before) return;
    let elementId = editing.elementId;
    if (!elementId) {
      const { element } = await api('/element', 'POST', describe(editing.el));
      elementId = element.id;
      if (state.selected?.el === editing.el) state.selected.record = element;
    }
    const edit = await api('/edit', 'POST', { elementId, kind: 'text', before: editing.before, after, page: realPage() });
    post('edited', { edit });
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
  let contextCommentId = null;
  function closeContextMenu() {
    contextMenu.hidden = true;
    if (contextTarget && contextTarget !== state.selected?.el) paint(contextTarget, false);
    contextTarget = null;
    contextPoint = null;
    contextCommentId = null;
  }
  function openContextMenu(ev) {
    const commentMarker = ev.target.closest?.('.uidit-comment-marker');
    if (commentMarker) {
      ev.preventDefault();
      ev.stopPropagation();
      const comment = visualState.comments.find((item) => item.id === commentMarker.dataset.uiditCommentId);
      if (!comment) return;
      contextCommentId = comment.id;
      contextTarget = commentMarker;
      contextPoint = { x: ev.clientX, y: ev.clientY };
      contextMenu.setAttribute('role', 'menu');
      contextMenu.setAttribute('aria-label', 'Comment actions');
      contextMenu.innerHTML = `<div class="uidit-context-title">Comment <span>Review note</span></div><button type="button" role="menuitem" data-context-action="edit-comment">Edit comment</button><button type="button" role="menuitem" data-context-action="delete-comment">Delete comment</button>`;
      contextMenu.hidden = false;
      contextMenu.style.left = `${Math.max(8, Math.min(ev.clientX, innerWidth - 250))}px`;
      contextMenu.style.top = `${Math.max(8, Math.min(ev.clientY, innerHeight - 120))}px`;
      requestAnimationFrame(() => {
        const rect = contextMenu.getBoundingClientRect();
        contextMenu.style.left = `${Math.max(8, Math.min(ev.clientX, innerWidth - rect.width - 8))}px`;
        contextMenu.style.top = `${Math.max(8, Math.min(ev.clientY, innerHeight - rect.height - 8))}px`;
      });
      return;
    }
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
      if (action === 'edit-comment') {
        const comment = visualState.comments.find((item) => item.id === contextCommentId);
        if (!comment) { closeContextMenu(); return; }
        contextMenu.setAttribute('role', 'dialog');
        contextMenu.setAttribute('aria-label', 'Edit comment');
        contextMenu.innerHTML = `<div class="uidit-context-title">Edit comment <span>Review note</span></div><label class="uidit-context-sr" for="uidit-context-note">Comment text</label><textarea id="uidit-context-note" maxlength="4000"></textarea><div class="uidit-context-actions"><button type="button" data-context-action="cancel">Cancel</button><button type="button" class="primary" data-context-action="save-comment" disabled>Save</button></div>`;
        const textarea = contextMenu.querySelector('textarea');
        textarea.value = comment.text;
        const submit = contextMenu.querySelector('[data-context-action="save-comment"]');
        const updateEnabled = () => { submit.disabled = !textarea.value.trim() || textarea.value.trim() === comment.text; };
        textarea.addEventListener('input', updateEnabled);
        textarea.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
          event.preventDefault();
          if (!submit.disabled) submit.click();
        });
        textarea.focus();
        return;
      }
      if (action === 'save-comment') {
        const text = contextMenu.querySelector('textarea')?.value.trim();
        if (!text || !contextCommentId) return;
        await api('/comment-update', 'POST', { commentId: contextCommentId, text });
        closeContextMenu(); renderVisuals(); return;
      }
      if (action === 'delete-comment') {
        if (!contextCommentId) return;
        await api('/comment-delete', 'POST', { commentId: contextCommentId });
        closeContextMenu(); renderVisuals(); return;
      }
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
        textarea.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
          event.preventDefault();
          if (!submit.disabled) submit.click();
        });
        textarea.focus();
        contextMenu.dataset.composer = '1';
        return;
      }
      if (action === 'cancel') { delete contextMenu.dataset.composer; closeContextMenu(); return; }
      if (action === 'post') {
        const text = contextMenu.querySelector('textarea')?.value.trim();
        if (!text) return;
        const {width:pageWidth,height:pageHeight}=pageSize();
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
    if (textEditing?.el.contains(ev.target)) {
      ev.preventDefault();
      ev.stopPropagation();
      placeTextCaret(ev);
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const selected = state.selected?.el;
    // A child is a separate inspect target. Only a second click on the exact
    // same element switches into inline text editing.
    if (selected && selected === ev.target) {
      beginTextEditing();
      placeTextCaret(ev);
      return;
    }
    if (textEditing) {
      finishTextEditing(true).then(() => select(ev.target));
      return;
    }
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
    const key = ev.key.toLowerCase();
    const typing = /INPUT|TEXTAREA|SELECT/.test(ev.target?.tagName ?? '') || ev.target?.isContentEditable === true;
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && key === 'z' && !typing) {
      ev.preventDefault();
      ev.stopPropagation();
      post('shortcut', { key: 'undo' });
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (key === 'escape') {
      ev.preventDefault();
      ev.stopPropagation();
      handleEscape();
      return;
    }
    if (/INPUT|TEXTAREA|SELECT/.test(ev.target?.tagName ?? '') || ev.target?.isContentEditable === true) return;
    // The panel owns review state, so the preview reports these instead of acting on them.
    if (key === 'i' || key === 'c' || key === 'g') post('shortcut', { key });
  }, true);

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (ev.source === controls.contentWindow && ev.origin === controlOrigin && msg?.source === 'uidit-control') {
      if (msg.type === 'resize') { controls.classList.toggle('uidit-open', msg.open === true); place(); }
      // The control frame carries the button; moving it by the pointer's own deltas
      // keeps the button under the pointer without a position round trip per event.
      if (msg.type === 'action' && msg.action === 'dragMove' && (Number.isFinite(msg.dx) || Number.isFinite(msg.dy))) {
        document.documentElement.classList.add('uidit-dragging');
        setFloating(floating.x + (Number(msg.dx) || 0), floating.y + (Number(msg.dy) || 0), false);
      }
      if (msg.type === 'action' && msg.action === 'dragCommit') {
        document.documentElement.classList.remove('uidit-dragging');
        setFloating(floating.x, floating.y);
      }
      if (msg.type === 'action' && msg.action === 'dragCancel') document.documentElement.classList.remove('uidit-dragging');
      if (msg.type === 'action' && msg.action === 'shortcut' && ['i', 'c', 'g', 'escape'].includes(msg.key)) post('shortcut', { key: msg.key });
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
      if (['light', 'dark'].includes(msg.theme)) document.documentElement.dataset.uiditTheme = msg.theme;
      setBrowserInspection(msg.browserInspection === true);
      if (!positionPinned) setFloating(msg.position === 'bottom-right' ? innerWidth - BUTTON - 24 : 24, innerHeight - BUTTON - 24, false);
      if (Array.isArray(msg.comments) && Array.isArray(msg.elements)) { visualState = { comments: msg.comments, elements: msg.elements }; renderVisuals(); }
      // Keep the bridge's trusted discriminator after spreading dashboard
      // state, which carries its own `source` field.
      controls.contentWindow?.postMessage({ ...msg, source: 'uidit-preview', type: 'state' }, controlOrigin); return;
    }
    if (msg.type === 'browser-action-prepare') { prepareAgentAction(msg); return; }
    if (msg.type === 'browser-action-execute') { executeAgentAction(msg); return; }
    if (msg.type === 'browser-action-cancel') {
      if (agentAction && msg.actionId === agentAction.actionId && msg.generation === agentAction.generation && msg.bridgeNonce === agentAction.bridgeNonce) {
        clearAgentVisual(); agentAction = null;
        post('browser-action-cancel-ack', { actionId: msg.actionId, generation: msg.generation, bridgeNonce: msg.bridgeNonce, code: typeof msg.code === 'string' ? msg.code : 'action_failed' });
      }
      return;
    }
    if (msg.type === 'browser-action-navigation-complete' && typeof msg.actionId === 'string') {
      try {
        const carried = JSON.parse(sessionStorage.getItem('uidit-agent-navigation') || 'null');
        if (carried?.actionId === msg.actionId) sessionStorage.removeItem('uidit-agent-navigation');
      } catch {}
      clearAgentVisual(); agentAction = null;
      return;
    }
    if (msg.type === 'browser-action-complete' && agentAction && msg.actionId === agentAction.actionId && msg.generation === agentAction.generation && msg.bridgeNonce === agentAction.bridgeNonce) {
      clearAgentVisual(); agentAction = null;
      return;
    }
    if (msg.type === 'browser-action-clear') { clearAgentVisual(); agentAction = null; return; }
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
      document.documentElement.dataset.uiditTheme = msg.theme;
      controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'theme', theme: msg.theme }, controlOrigin); return;
    }
    if (msg.type === 'drawMode') { setDrawingTool(msg.tool); return; }
    if (msg.type === 'escape') {
      handleEscape();
      controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'escape' }, controlOrigin);
    }
    if (msg.type === 'hideControls') { controls.hidden = true; return; }
    if (msg.type === 'showControls') { controls.hidden = false; return; }
    handle(msg).catch((err) => post('error', { message: err.message }));
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key.toLowerCase() === 'u' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !/INPUT|TEXTAREA/.test(ev.target?.tagName ?? '')) controls.hidden = false;
  });

  async function handle(msg) {

    if (msg.type === 'mode') {
      state.mode = msg.mode === 'inspect' || msg.mode === 'text' ? 'inspect' : 'off';
      if (msg.mode === 'text') beginTextEditing();
      else if (state.mode === 'off' && textEditing) await finishTextEditing(true);
      post('mode', { mode: state.mode });
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
      await finishTextEditing(true);
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

  function handleEscape() {
    if (!contextMenu.hidden) { closeContextMenu(); return; }
    if (drawingTool !== 'off') { setDrawingTool('off'); return; }
    const clearSelection = () => {
      if (state.selected) {
        const selectedEl = state.selected.el;
        restoreSelected();
        if (hoverEl === selectedEl) {
          paint(hoverEl, false);
          hoverEl = null;
        }
        post('selected', { element: null });
        return;
      }
      if (state.mode !== 'off') {
        state.mode = 'off';
        post('mode', { mode: 'off' });
      }
    };
    if (textEditing) {
      finishTextEditing(true)
        .then(clearSelection)
        .catch((err) => post('error', { message: err.message }));
      return;
    }
    clearSelection();
  }

  post('ready', { url: realPage(), title: document.title });
  let carriedNavigation = null;
  try {
    const candidate = JSON.parse(sessionStorage.getItem('uidit-agent-navigation') || 'null');
    if (candidate && typeof candidate.actionId === 'string' && typeof candidate.navigationToken === 'string') carriedNavigation = candidate;
  } catch {}
  post('browser-executor-preview-ready', {
    navigation: carriedNavigation ? { actionId: carriedNavigation.actionId, navigationToken: carriedNavigation.navigationToken, currentPath: `${location.pathname.replace(/^\/proxy/, '') || '/'}${location.search}` } : null,
  });
})();
