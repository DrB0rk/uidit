import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './Toolbar.jsx';
import Sidebar from './Sidebar.jsx';
import { AgentsPanel, ServerPanel, SettingsPanel } from './RuntimePanels.jsx';
import { DesignPanel } from './DesignPanel.jsx';
import { useSession } from '../state/useSession.js';
import { MessageSquareText, Layers3, PencilRuler, Server, Bot, Settings2, Sun, Moon, Workflow, Laptop, Tablet, Smartphone, WandSparkles } from 'lucide-react';
import { FlowsPanel } from './RuntimePanels.jsx';

const TABS = [['feedback', 'Feedback', MessageSquareText], ['design', 'Design', WandSparkles], ['inspect', 'Elements', Layers3], ['changes', 'Changes', PencilRuler], ['flows', 'Flows', Workflow], ['server', 'Server', Server], ['agents', 'Agents', Bot], ['settings', 'Settings', Settings2]];
const PREVIEW_API = new Set(['/element', '/comment', '/comment-reply', '/edit']);
// The review panel resizes by dragging its edge; the preview keeps the rest of the width.
const DRAWER_KEY = 'uidit-drawer-width';
const DRAWER_MIN = 320;
const DRAWER_MAX = 760;
const DRAWER_DEFAULT = 420;
const DRAWER_PREVIEW_MIN = 360;

function drawerMax() {
  // The preview stage sits 12px in from the left, so its width is
  // viewport - 12 - drawer; keep DRAWER_PREVIEW_MIN of it visible.
  try { return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, window.innerWidth - DRAWER_PREVIEW_MIN - 12)); } catch { return DRAWER_MAX; }
}
function clampDrawerWidth(width) {
  const cap = drawerMax();
  return Math.round(Math.max(DRAWER_MIN, Math.min(Number.isFinite(width) ? width : DRAWER_DEFAULT, cap)));
}

export default function Dashboard() {
  const { config, session, status: live, dev, mcp, collaboration, selection, browserContext, browserDiagnostics, browserAction, actions } = useSession();
  const frameRef = useRef(null);
  const replayWaiters = useRef(new Map());
  const [mode, setMode] = useState('off');
  const [selected, setSelected] = useState(null);
  const [anchorStatuses, setAnchorStatuses] = useState({});
  const [status, setStatus] = useState({ text: 'ready', kind: '' });
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [tab, setTab] = useState('feedback');
  const [reloadKey, setReloadKey] = useState(0);
  const [replayState, setReplayState] = useState(null);
  const [device, setDevice] = useState(() => { try { return ['desktop', 'tablet', 'phone'].includes(localStorage.getItem('uidit-device')) ? localStorage.getItem('uidit-device') : 'desktop'; } catch { return 'desktop'; } });
  const [customViewport, setCustomViewport] = useState({ width: 390, height: 844 });
  const [reference, setReference] = useState(null);
  const [compareMode, setCompareMode] = useState('overlay');
  const [referenceOpacity, setReferenceOpacity] = useState(50);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('uidit-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('uidit-theme', theme); } catch {}
  }, [theme]);

  useEffect(() => { try { localStorage.setItem('uidit-device', device); } catch {} }, [device]);

  const [drawerWidth, setDrawerWidth] = useState(() => {
    try { const stored = Number(localStorage.getItem(DRAWER_KEY)); return stored > 0 ? clampDrawerWidth(stored) : DRAWER_DEFAULT; } catch { return DRAWER_DEFAULT; }
  });
  const [resizingDrawer, setResizingDrawer] = useState(false);
  const drawerDrag = useRef(null);
  const mainRef = useRef(null);

  // The width lands on the element itself rather than a rendered style attribute:
  // the server render has no access to the stored value, and hydration keeps the
  // server's attribute for custom properties.
  useEffect(() => { mainRef.current?.style.setProperty('--drawer-width', `${drawerWidth}px`); }, [drawerWidth]);

  useEffect(() => { try { localStorage.setItem(DRAWER_KEY, String(drawerWidth)); } catch {} }, [drawerWidth]);

  useEffect(() => {
    const onResize = () => setDrawerWidth((width) => clampDrawerWidth(width));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('workspace') === '1') setWorkspaceOpen(true);
    const initialTab = params.get('tab');
    if (TABS.some(([id]) => id === initialTab)) setTab(initialTab);
  }, []);

  const targetUrl = config?.targetUrl ?? null;
  const previewOrigin = useMemo(() => { try { return new URL(config?.previewUrl).origin; } catch { return ''; } }, [config?.previewUrl]);

  const toOverlay = useCallback((message) => {
    if (previewOrigin) frameRef.current?.contentWindow?.postMessage({ source: 'uidit-dashboard', ...message }, previewOrigin);
  }, [previewOrigin]);

  const showWorkspace = useCallback((nextTab = 'feedback') => {
    setTab(TABS.some(([id]) => id === nextTab) ? nextTab : 'feedback');
    setWorkspaceOpen(true);
  }, []);

  const runShortcut = useCallback((key) => {
    if (key === 'escape') { toOverlay({ type: 'escape' }); if (workspaceOpen) setWorkspaceOpen(false); else setMode('off'); return; }
    if (key === 'i') { const next = mode === 'inspect' ? 'off' : 'inspect'; setMode(next); toOverlay({ type: 'mode', mode: next }); return; }
    if (key === 'g' || key === 'c') { showWorkspace('feedback'); return; }
    if (key === 'u') toOverlay({ type: 'showControls' });
  }, [mode, showWorkspace, toOverlay, workspaceOpen]);

  const syncOverlay = useCallback(() => {
    toOverlay({ type: 'mode', mode });
    toOverlay({ type: 'state', openComments: session.comments.filter((c) => !c.resolved).length, pendingEdits: session.edits.filter((e) => !e.applied).length, dev, mcpClients: mcp.clientCount, position: config?.ui?.position, browserInspection: config?.ui?.allowBrowserInspection === true, comments: session.comments, elements: session.elements, theme });
  }, [mode, session, dev, mcp.clientCount, config?.ui?.position, config?.ui?.allowBrowserInspection, theme, toOverlay]);

  const onStatus = useCallback((text, kind = '') => setStatus({ text, kind }), []);

  const bridgeApi = useCallback(async (msg) => {
    if (!PREVIEW_API.has(msg.route) || msg.method !== 'POST' || !msg.body || typeof msg.body !== 'object') throw new Error('Unsupported preview request');
    const body = { ...msg.body };
    if (msg.route === '/comment') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new Error('Comment text must be 1–4000 characters');
      body.text = body.text.trim();
      body.elementId = typeof body.elementId === 'string' ? body.elementId.slice(0, 200) : null;
      body.page = typeof body.page === 'string' ? body.page.slice(0, 2000) : null;
      if (body.anchor && typeof body.anchor === 'object' && Number.isFinite(body.anchor.x) && Number.isFinite(body.anchor.y)) body.anchor = { x: Math.max(0, Math.min(1, body.anchor.x)), y: Math.max(0, Math.min(1, body.anchor.y)) };
      else body.anchor = null;
      if (body.drawing && typeof body.drawing === 'object') {
        const { type, points } = body.drawing;
        if (!['arrow', 'rectangle', 'ellipse', 'freehand'].includes(type) || !Array.isArray(points) || points.length > 500 || points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) throw new Error('Invalid drawing annotation');
        const pageWidth = Number(body.drawing.pageWidth), pageHeight = Number(body.drawing.pageHeight);
        body.drawing = { type, points: points.map(({ x, y }) => ({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) })), pageWidth: Number.isFinite(pageWidth) ? Math.max(1, Math.min(100000, pageWidth)) : null, pageHeight: Number.isFinite(pageHeight) ? Math.max(1, Math.min(100000, pageHeight)) : null };
      } else body.drawing = null;
      return actions.comment(body);
    }
    if (msg.route === '/element') {
      for (const key of ['selector', 'tag', 'page', 'text']) if (typeof body[key] === 'string') body[key] = body[key].slice(0, key === 'text' ? 300 : 2000);
      if (typeof body.selector !== 'string' || !body.selector) throw new Error('Element selector is required');
      return actions.element(body);
    }
    if (msg.route === '/comment-reply') {
      if (typeof body.commentId !== 'string' || !body.commentId || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new Error('Reply text must be 1–4000 characters');
      return actions.reply(body.commentId.slice(0, 200), { text: body.text.trim(), author: 'reviewer' });
    }
    if (!['text', 'style', 'attribute', 'class', 'remove'].includes(body.kind)) throw new Error('Unsupported preview edit');
    body.before = body.before == null ? null : String(body.before).slice(0, 2000);
    body.after = body.after == null ? null : String(body.after).slice(0, 2000);
    if (typeof body.property === 'string') body.property = body.property.slice(0, 100);
    body.page = typeof body.page === 'string' ? body.page.slice(0, 2000) : null;
    return actions.edit(body);
  }, [actions]);

  useEffect(() => {
    if (!targetUrl || !previewOrigin) return;
    const onMessage = async (ev) => {
      if (ev.source !== frameRef.current?.contentWindow || ev.origin !== previewOrigin) return;
      const msg = ev.data;
      if (!msg || msg.source !== 'uidit-overlay') return;
      // Shortcuts pressed while the preview has focus arrive here through the overlay.
      if (msg.type === 'shortcut' && typeof msg.key === 'string') { runShortcut(msg.key); return; }
      if (msg.type === 'record-step' && msg.step && typeof msg.flowId === 'string') {
        actions.addFlowStep(msg.flowId, msg.step).catch((error) => onStatus(error.message, 'error'));
        return;
      }
      if (msg.type === 'record-log' && typeof msg.flowId === 'string') {
        actions.addFlowLog(msg.flowId, { kind: msg.kind, message: msg.message, url: msg.url }).catch((error) => onStatus(error.message, 'error'));
        return;
      }
      if (msg.type === 'replay-result' && typeof msg.id === 'string') {
        replayWaiters.current.get(msg.id)?.(msg);
        replayWaiters.current.delete(msg.id);
        return;
      }
      if (msg.type === 'api-request') {
        if (typeof msg.id !== 'string' || msg.id.length > 100) return;
        try {
          const result = await bridgeApi(msg);
          frameRef.current?.contentWindow?.postMessage({ source: 'uidit-dashboard', type: 'api-response', id: msg.id, ok: true, result }, previewOrigin);
        } catch (error) {
          frameRef.current?.contentWindow?.postMessage({ source: 'uidit-dashboard', type: 'api-response', id: msg.id, ok: false, error: error.message }, previewOrigin);
        }
        return;
      }
      if (msg.type === 'ready') {
        syncOverlay();
      }
      if (msg.type === 'selected') setSelected(msg.element ?? null);
      if (msg.type === 'browser-context') actions.browserContext(msg).catch((error) => onStatus(error.message, 'error'));
      if (msg.type === 'browser-diagnostics' && Array.isArray(msg.entries)) actions.browserDiagnostics(msg.entries).catch((error) => onStatus(error.message, 'error'));
      if (msg.type === 'browser-action-result' && typeof msg.id === 'string') actions.browserActionResult(msg.id, { ok: msg.ok === true, error: msg.error, result: msg.result }).catch((error) => onStatus(error.message, 'error'));
      if (msg.type === 'component-state' && typeof msg.state === 'string') onStatus(msg.ok ? `${msg.state} state previewed${msg.label ? ` · ${msg.label}` : ''}` : msg.error ?? 'Component state preview is unavailable', msg.ok ? 'ok' : 'error');
      if (msg.type === 'proposal-preview') onStatus('Proposal changes are previewed in the page', 'ok');
      if (msg.type === 'anchor-status' && typeof msg.commentId === 'string' && ['located', 'recovered', 'ambiguous', 'missing'].includes(msg.status)) setAnchorStatuses((current) => ({ ...current, [msg.commentId]: msg }));
      if (msg.type === 'reattach-comment' && typeof msg.commentId === 'string' && msg.element && typeof msg.element.selector === 'string') {
        try { const { element } = await actions.element(msg.element); await actions.reattachComment(msg.commentId, element.id); onStatus('Comment reattached to the selected page element', 'ok'); }
        catch (error) { onStatus(error.message, 'error'); }
      }
      if (msg.type === 'error') onStatus(msg.message, 'error');
      if (msg.type === 'control') {
        if (msg.action === 'inspect' && typeof msg.enabled === 'boolean') { setMode(msg.enabled ? 'inspect' : 'off'); toOverlay({ type: 'mode', mode: msg.enabled ? 'inspect' : 'off' }); }
        if (msg.action === 'draw' && ['arrow', 'rectangle', 'ellipse', 'freehand', 'off'].includes(msg.tool)) toOverlay({ type: 'drawMode', tool: msg.tool });
        if (msg.action === 'applyDesignVariant' && Array.isArray(msg.styles) && msg.styles.length <= 8) {
          const allowed = new Set(['border-radius', 'box-shadow', 'padding', 'background-color', 'color', 'font-weight', 'font-size', 'gap']);
          const styles = msg.styles.map((item) => Array.isArray(item) ? { property: item[0], value: item[1] } : item).filter((item) => item && allowed.has(item.property) && typeof item.value === 'string' && item.value.length <= 120);
          if (styles.length) { for (const style of styles) toOverlay({ type: 'style', property: style.property, value: style.value }); onStatus(`${String(msg.name ?? 'Design direction').slice(0, 50)} applied to the preview`, 'ok'); }
        }
        if (msg.action === 'comment' && typeof msg.text === 'string' && msg.text.trim()) {
          try { await actions.comment({ text: msg.text.trim().slice(0, 4000), elementId: msg.elementId ?? null, page: typeof msg.page === 'string' ? msg.page.slice(0, 2000) : null }); onStatus('Comment saved to the shared review', 'ok'); }
          catch (error) { onStatus(error.message, 'error'); }
        }
        if (msg.action === 'workspace') {
          showWorkspace(msg.tab);
          if (msg.quickEdit === true) { setMode('text'); toOverlay({ type: 'mode', mode: 'text' }); }
        }
      }
      if (msg.type === 'mode' && typeof msg.mode === 'string') setMode(msg.mode);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [actions, bridgeApi, onStatus, previewOrigin, session, showWorkspace, syncOverlay, targetUrl, toOverlay]);

  useEffect(() => {
    if (!browserAction?.id) return;
    setStatus({ text: `Agent ${browserAction.action?.type ?? 'browser'} action running`, kind: 'ok' });
    toOverlay({ type: 'browserAction', id: browserAction.id, action: browserAction.action });
  }, [browserAction, toOverlay]);

  const recordingFlowId = session.flows?.find((flow) => flow.status === 'recording')?.id ?? null;
  useEffect(() => {
    toOverlay({ type: 'recordMode', enabled: Boolean(recordingFlowId), flowId: recordingFlowId });
  }, [recordingFlowId, toOverlay, targetUrl]);

  const replayFlow = useCallback(async (flow) => {
    if (!targetUrl) { onStatus('Connect a preview before replaying a flow', 'error'); return; }
    setReplayState({ flowId: flow.id, running: true, passed: 0, failed: 0, messages: [] });
    let passed = 0; const messages = [];
    for (const step of flow.steps) {
      if (step.sensitive) { messages.push(`Skipped sensitive step: ${step.label || step.action}`); continue; }
      const id = crypto.randomUUID();
      const response = new Promise((resolve) => {
        const timer = setTimeout(() => { replayWaiters.current.delete(id); resolve({ ok: false, error: 'Timed out waiting for the preview' }); }, 8000);
        replayWaiters.current.set(id, (value) => { clearTimeout(timer); resolve(value); });
      });
      toOverlay({ type: 'replayStep', id, step });
      const result = await response;
      if (result.ok) passed += 1; else messages.push(`${step.label || step.action}: ${result.error}`);
      setReplayState({ flowId: flow.id, running: true, passed, failed: messages.length, messages: [...messages] });
      if (result.ok) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    setReplayState({ flowId: flow.id, running: false, passed, failed: messages.length, messages });
    onStatus(messages.length ? `Flow replay finished with ${messages.length} issue(s)` : `Flow replay passed ${passed} step(s)`, messages.length ? 'error' : 'ok');
  }, [onStatus, targetUrl, toOverlay]);

  useEffect(() => {
    syncOverlay();
  }, [syncOverlay]);

  useEffect(() => {
    if (selection?.selector) toOverlay({ type: 'flashSelector', selector: selection.selector });
  }, [selection?.id, selection?.selectedAt, selection?.selector, toOverlay]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName ?? '') || event.target?.isContentEditable === true;
      if (event.key === 'Escape' && typing) { event.target.blur(); return; }
      if (typing) return;
      runShortcut(event.key.toLowerCase());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runShortcut]);

  const connect = async (url) => {
    try { await actions.setTargetUrl(url); setSelected(null); onStatus(`Connected to ${url}`, 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
  };
  const previewService = async (service) => {
    try { await actions.setTargetUrl(service.url); setSelected(null); setReloadKey((key) => key + 1); onStatus(`Previewing ${service.name}`, 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
  };
  const discover = async () => {
    try { const found = await actions.discover(); onStatus(found.length ? `${found.length} local server${found.length === 1 ? '' : 's'} found` : 'No local dev server found', found.length ? 'ok' : 'error'); return found; }
    catch (error) { onStatus(error.message, 'error'); return []; }
  };
  const select = (id) => { const item = session.elements.find((element) => element.id === id); if (!item) return; setSelected(item); toOverlay({ type: 'flashSelector', selector: item.selector }); };
  const hideControls = () => { toOverlay({ type: 'hideControls' }); setWorkspaceOpen(false); };
  const startDrawerResize = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawerDrag.current = { x: event.clientX, width: drawerWidth };
    setResizingDrawer(true);
  };
  const moveDrawerResize = (event) => {
    const drag = drawerDrag.current;
    if (!drag) return;
    setDrawerWidth(clampDrawerWidth(drag.width - (event.clientX - drag.x)));
  };
  const endDrawerResize = (event) => {
    if (!drawerDrag.current) return;
    drawerDrag.current = null;
    setResizingDrawer(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const nudgeDrawer = (event) => {
    const step = event.shiftKey ? 96 : 24;
    const next = event.key === 'ArrowLeft' ? drawerWidth + step
      : event.key === 'ArrowRight' ? drawerWidth - step
      : event.key === 'Home' ? DRAWER_MIN
      : event.key === 'End' ? DRAWER_MAX
      : null;
    if (next === null) return;
    event.preventDefault();
    setDrawerWidth(clampDrawerWidth(next));
  };
  const changeTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    toOverlay({ type: 'theme', theme: next });
  };

  return <main ref={mainRef} className={`immersive${workspaceOpen ? ' workspace-open' : ''}${resizingDrawer ? ' resizing' : ''}`}>
    {targetUrl ? <>
      <div className={`preview-device-stage device-${device}${reference && compareMode === 'side' ? ' compare-side' : ''}`} style={{ '--reference-opacity': referenceOpacity / 100, '--custom-width': `${customViewport.width}px`, '--custom-height': `${customViewport.height}px` }}>
        <div className={`preview-live-frame device-${device}`}>
          <iframe key={reloadKey} ref={frameRef} className="immersive-preview" title={`${device} live application preview`} src={`${config?.previewUrl}/proxy/?r=${reloadKey}`} onLoad={syncOverlay} />
          {reference && compareMode === 'overlay' && <img className="preview-reference-overlay" src={reference.dataUrl} alt="Reference design overlay" />}
        </div>
        {reference && compareMode === 'side' && <div className="preview-reference-side"><span>Reference</span><img src={reference.dataUrl} alt={`Reference: ${reference.name}`} /></div>}
      </div>
      {workspaceOpen && <div className="device-toolbar" role="group" aria-label="Preview device size">
        {[['desktop', 'Desktop', Laptop], ['tablet', 'Tablet', Tablet], ['phone', 'Phone', Smartphone]].map(([key, label, Icon]) => <button type="button" key={key} aria-pressed={device === key} className={device === key ? 'active' : ''} onClick={() => setDevice(key)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>)}
        <label className="custom-viewport">Custom <input aria-label="Custom viewport width" type="number" min="240" max="2560" value={customViewport.width} onChange={(event) => setCustomViewport((value) => ({ ...value, width: Math.max(240, Math.min(2560, Number(event.target.value) || 240)) }))} /> × <input aria-label="Custom viewport height" type="number" min="320" max="1800" value={customViewport.height} onChange={(event) => setCustomViewport((value) => ({ ...value, height: Math.max(320, Math.min(1800, Number(event.target.value) || 320)) }))} /><button type="button" className="btn sm" onClick={() => setDevice('custom')}>Apply</button></label>
      </div>}
    </> : <section className="immersive-empty"><h1>Start reviewing your app</h1><p>Run <code>uidit</code> from your project to launch its development server, or connect a local server below.</p><Toolbar config={config} onConnect={connect} onDiscover={discover} onReload={() => setReloadKey((key) => key + 1)} mode={mode} onMode={setMode} /></section>}
    {workspaceOpen && <section className={`workspace-drawer${drawerWidth < 400 ? ' compact' : ''}`} id="uidit-workspace" aria-label="UIDIT review workspace">
      <div
        className="workspace-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review panel"
        aria-controls="uidit-workspace"
        aria-valuemin={DRAWER_MIN}
        aria-valuemax={Math.round(drawerMax())}
        aria-valuenow={drawerWidth}
        tabIndex={0}
        onPointerDown={startDrawerResize}
        onPointerMove={moveDrawerResize}
        onPointerUp={endDrawerResize}
        onPointerCancel={endDrawerResize}
        onKeyDown={nudgeDrawer}
      />
      <header className="workspace-head"><div><div className="workspace-brand">uidit <span>WORKSPACE</span></div><div className="workspace-caption">{(() => { try { return targetUrl ? new URL(targetUrl).host : 'Local development review'; } catch { return 'Local development review'; } })()}</div></div><div className="workspace-head-actions"><button className="theme-toggle" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={changeTheme}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span></button><button className="workspace-close" type="button" aria-label="Close workspace" onClick={() => setWorkspaceOpen(false)}>×</button></div></header>
      {targetUrl && <Toolbar compact config={config} onConnect={connect} onDiscover={discover} onReload={() => setReloadKey((key) => key + 1)} mode={mode} onMode={setMode} />}
      <nav className="workspace-tabs" aria-label="Review workspace sections">{TABS.map(([id, label, Icon]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} aria-label={label} title={label} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} strokeWidth={1.8} aria-hidden="true"/><span className="tab-label">{label}</span>{id === 'feedback' && session.comments.some((c) => !c.resolved) ? <span className="tab-count">{session.comments.filter((c) => !c.resolved).length}</span> : null}</button>)}</nav>
      <div className="workspace-content">
        {['feedback', 'inspect', 'changes'].includes(tab) && <Sidebar session={session} selectedId={selected?.id} anchorStatuses={anchorStatuses} onSelect={select} actions={actions} onOverlay={toOverlay} onStatus={onStatus} page={targetUrl} collaboration={collaboration} tab={tab} showTabs={false} />}
        {tab === 'design' && <DesignPanel selected={selected} onOverlay={toOverlay} onStatus={onStatus} onClearSelection={() => setSelected(null)} reference={reference} onReferenceChange={setReference} compareMode={compareMode} onCompareMode={setCompareMode} opacity={referenceOpacity} onOpacity={setReferenceOpacity} />}
        {tab === 'flows' && <FlowsPanel session={session} actions={actions} onStatus={onStatus} onRecording={(flowId) => toOverlay({ type: 'recordMode', enabled: Boolean(flowId), flowId })} onReplay={replayFlow} replayState={replayState} />}
        {tab === 'server' && <><Toolbar config={config} onConnect={connect} onDiscover={discover} onReload={() => setReloadKey((key) => key + 1)} mode={mode} onMode={setMode} /><ServerPanel config={config} dev={dev} actions={actions} onStatus={onStatus} onPreviewService={previewService} browserContext={browserContext} browserDiagnostics={browserDiagnostics} /></>}
        {tab === 'agents' && <AgentsPanel config={config} mcp={mcp} collaboration={collaboration} session={session} actions={actions} onStatus={onStatus} />}
        {tab === 'settings' && <SettingsPanel config={config} actions={actions} onStatus={onStatus} onHide={hideControls} />}
      </div>
      <footer className="workspace-foot"><span className={`status-dot ${['ready', 'attached'].includes(dev?.state) ? 'online' : ''}`} /><span>Server {dev?.state ?? 'idle'}</span><span className="spacer" /><span>{live}</span></footer>
    </section>}
    <div className={`toast ${workspaceOpen ? 'visible' : ''}`} role="status" aria-live="polite"><span className="dot"/><span>{status.text}</span></div>
  </main>;
}
