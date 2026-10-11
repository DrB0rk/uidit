/* uidit overlay — injected into the previewed page by the uidit dashboard server.
   Talks to the dashboard with postMessage, and persists everything to .uidit
   through the dashboard's own API (same origin). */
(() => {
  if (window.__uiditOverlay) return;
  window.__uiditOverlay = true;

  const API = '/api';
  const state = {
    mode: 'off',
    selected: null,
    pendingStyle: null,
  };
  let hoverEl = null;
  let savedOutline = '';

  // UIDIT's controls live in a separate-origin iframe; only accept its tiny,
  // schema-checked message set from the exact embedded window.
  const controls = document.createElement('iframe');
  const controlOrigin = window.__UIDIT_CONTROL__ || 'http://127.0.0.1:7718';
  controls.src = `${controlOrigin}/floating`;
  controls.title = 'UIDIT review controls';
  controls.setAttribute('data-uidit-ui', '1');
  controls.style.cssText = 'position:fixed;right:16px;bottom:16px;width:52px;height:52px;border:0;z-index:2147483647;background:transparent';
  (document.documentElement || document).append(controls);

  const post = (type, payload) => window.parent.postMessage({ source: 'uidit-overlay', type, ...payload }, '*');

  const api = async (route, method, body) => {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`);
    return res.json();
  };

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
    return {
      selector: uniqueSelector(el),
      selectorAlternatives: [...el.classList].map((c) => `.${CSS.escape(c)}`),
      tag: el.tagName,
      text: collapse(el.textContent).slice(0, 300),
      ancestors,
      attributes,
      page: realPage(),
    };
  };

  function installHighlightStyles() {
    if (document.getElementById('uidit-style')) return;
    const style = document.createElement('style');
    style.id = 'uidit-style';
    style.textContent =
      '[data-uidit-hover]{outline:2px solid #6d5efc !important;outline-offset:-2px !important;' +
      'background-color:rgba(109,94,252,0.08) !important;}';
    document.head.append(style);
  }

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
    api('/element', 'POST', state.selected.record)
      .then(({ element }) => {
        state.selected.record = element;
        post('selected', { element });
      })
      .catch((err) => post('error', { message: err.message }));
  }

  async function applyStyle(prop, value) {
    const el = state.selected?.el;
    if (!el) return;
    const before = el.style.getPropertyValue(prop);
    if (!state.pendingStyle) state.pendingStyle = { el, props: {} };
    state.pendingStyle.props[prop] = before;
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
      restoreSelected();
      post('selected', { element: null });
    }
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (ev.source === controls.contentWindow && ev.origin === controlOrigin && msg?.source === 'uidit-control') {
      if (msg.type === 'resize') { controls.style.width = msg.open === true ? '264px' : '52px'; controls.style.height = msg.open === true ? '360px' : '52px'; }
      if (msg.type === 'inspect') { state.mode = state.mode === 'inspect' ? 'off' : 'inspect'; post('mode', { mode: state.mode }); }
      if (msg.type === 'comment' && typeof msg.text === 'string' && msg.text.trim().length <= 4000) {
        api('/comment', 'POST', { elementId: state.selected?.record.id ?? null, page: realPage(), text: msg.text.trim() })
          .then(({ comment }) => post('commented', { comment }))
          .catch((err) => post('error', { message: err.message }));
      }
      return;
    }
    if (!msg || msg.source !== 'uidit-dashboard') return;
    handle(msg).catch((err) => post('error', { message: err.message }));
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
        api('/element', 'POST', state.selected.record)
          .then(({ element }) => post('selected', { element }))
          .catch((err) => post('error', { message: err.message }));
      } else {
        post('error', { message: `selector not found on this page: ${msg.selector}` });
      }
    }

    if (msg.type === 'style') applyStyle(msg.property, msg.value);

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
      restoreSelected();
      post('selected', { element: null });
    }
  }

  post('ready', { url: realPage(), title: document.title });
})();
