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
  let drawStart = null;

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
    const matchesPage = (c) => !c.page || (() => { try { const a = new URL(c.page), current = new URL(realPage()); return a.origin === current.origin && a.pathname === current.pathname; } catch { return true; } })();
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
      const record = elements.get(c.elementId); let el = null;
      try { if (record?.selector) el = document.querySelector(record.selector); } catch {}
      const markerNode = document.createElement('button'); markerNode.type='button'; markerNode.className='uidit-comment-marker'; markerNode.textContent=String(index+1); markerNode.title=c.text; markerNode.setAttribute('aria-label',`Review comment: ${c.text}`);
      markerNode.style.cssText='position:absolute;pointer-events:auto;left:0;top:0;transform:translate(-50%,-50%);width:27px;height:27px;border:2px solid white;border-radius:50%;background:#785bff;color:white;font:700 12px system-ui;box-shadow:0 3px 14px #17132270;cursor:pointer;';
      const rect=el?.getBoundingClientRect(); const hasAnchor=Number.isFinite(c.anchor?.x)&&Number.isFinite(c.anchor?.y); const x=rect?rect.left+scrollX+rect.width/2:hasAnchor?c.anchor.x*width:width-34; const y=rect?rect.top+scrollY:hasAnchor?c.anchor.y*height:24+index*34;
      markerNode.style.left=`${x}px`; markerNode.style.top=`${y}px`;
      const pop=document.createElement('section');pop.className='uidit-comment-thread';pop.setAttribute('role','dialog');pop.setAttribute('aria-label','Comment thread');pop.hidden=true;pop.setAttribute('data-uidit-ui','1');
      pop.style.cssText='position:absolute;z-index:1;left:0;top:0;transform:translate(18px,14px);width:min(300px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 48px));overflow:auto;padding:12px;border:1px solid #3d3a4b;border-radius:11px;background:#211f2b;color:#f5f4fa;font:12px/1.45 system-ui;box-shadow:0 10px 32px #17132255;pointer-events:auto;';
      pop.style.left=`${x}px`; pop.style.top=`${y}px`;
      const head=document.createElement('div');head.textContent=`Comment ${index+1}`;head.style.cssText='font-weight:700;font-size:11px;color:#c9c4dc;margin-bottom:6px;';
      const original=document.createElement('p');original.textContent=c.text;original.style.cssText='margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;';
      const replies=document.createElement('div');replies.style.cssText='display:grid;gap:6px;margin:7px 0;';
      (Array.isArray(c.replies)?c.replies:[]).forEach((reply)=>{const item=document.createElement('div');item.style.cssText='padding:7px 8px;border-radius:7px;background:#302e3b;';const author=document.createElement('strong');author.textContent=reply.author==='agent'?'Agent':'You';author.style.cssText='display:block;margin-bottom:2px;font-size:10px;color:#c4b9ff;';const text=document.createElement('span');text.textContent=reply.text;item.append(author,text);replies.append(item);});
      const input=document.createElement('textarea');input.maxLength=4000;input.setAttribute('aria-label','Reply to comment');input.placeholder='Reply or ask the agent a question';input.style.cssText='display:block;box-sizing:border-box;width:100%;min-height:58px;resize:vertical;padding:8px;border:1px solid #4c4959;border-radius:7px;background:#17161f;color:#fff;font:12px/1.45 system-ui;';
      const send=document.createElement('button');send.type='button';send.textContent='Reply';send.disabled=true;send.style.cssText='display:block;margin:7px 0 0 auto;padding:6px 10px;border:0;border-radius:6px;background:#a99af5;color:#171522;font:600 11px system-ui;cursor:pointer;';
      input.addEventListener('input',()=>{send.disabled=!input.value.trim();});
      send.addEventListener('click',async()=>{if(!input.value.trim())return;send.disabled=true;send.textContent='Sending…';try{await api('/comment-reply','POST',{commentId:c.id,text:input.value.trim()});input.value='';pop.hidden=true;renderVisuals();}catch(err){send.disabled=false;send.textContent='Retry';post('error',{message:err.message});}});
      pop.append(head,original,replies,input,send);visuals.append(pop);
      markerNode.addEventListener('click',(ev)=>{ev.stopPropagation();const wasOpen=!pop.hidden;visuals.querySelectorAll('.uidit-comment-thread').forEach((thread)=>thread.hidden=true);pop.hidden=wasOpen;if(el){restoreSelected();state.selected={el,record};el.setAttribute('data-uidit-selected','1');el.scrollIntoView({block:'center',behavior:'smooth'});}});
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
  addEventListener('resize',renderVisuals); addEventListener('scroll',renderVisuals,true);

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
    if (msg.type === 'state') {
      if (!savedAnchor) setAnchor(msg.position === 'bottom-right' ? 'right-bottom' : 'left-bottom');
      if (Array.isArray(msg.comments) && Array.isArray(msg.elements)) { visualState = { comments: msg.comments, elements: msg.elements }; renderVisuals(); }
      controls.contentWindow?.postMessage({ source: 'uidit-preview', type: 'state', ...msg }, controlOrigin); return;
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
