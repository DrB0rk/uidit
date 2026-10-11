import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './Toolbar.jsx';
import Sidebar from './Sidebar.jsx';
import { AgentsPanel, ServerPanel, SettingsPanel } from './RuntimePanels.jsx';
import { useSession } from '../state/useSession.js';

const TABS = [['feedback', 'Feedback'], ['inspect', 'Inspect'], ['changes', 'Changes'], ['server', 'Server'], ['agents', 'Agents'], ['settings', 'Settings']];
const PREVIEW_API = new Set(['/element', '/comment', '/edit']);

export default function Dashboard() {
  const { config, session, status: live, dev, mcp, selection, actions } = useSession();
  const frameRef = useRef(null);
  const [mode, setMode] = useState('off');
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState({ text: 'ready', kind: '' });
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [tab, setTab] = useState('feedback');
  const [reloadKey, setReloadKey] = useState(0);

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

  const onStatus = useCallback((text, kind = '') => setStatus({ text, kind }), []);

  const bridgeApi = useCallback(async (msg) => {
    if (!PREVIEW_API.has(msg.route) || msg.method !== 'POST' || !msg.body || typeof msg.body !== 'object') throw new Error('Unsupported preview request');
    const body = { ...msg.body };
    if (msg.route === '/comment') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new Error('Comment text must be 1–4000 characters');
      body.text = body.text.trim();
      body.elementId = typeof body.elementId === 'string' ? body.elementId.slice(0, 200) : null;
      body.page = typeof body.page === 'string' ? body.page.slice(0, 2000) : null;
      return actions.comment(body);
    }
    if (msg.route === '/element') {
      for (const key of ['selector', 'tag', 'page', 'text']) if (typeof body[key] === 'string') body[key] = body[key].slice(0, key === 'text' ? 300 : 2000);
      if (typeof body.selector !== 'string' || !body.selector) throw new Error('Element selector is required');
      return actions.element(body);
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
        toOverlay({ type: 'state', openComments: session.comments.filter((c) => !c.resolved).length, pendingEdits: session.edits.filter((e) => !e.applied).length, dev, mcpClients: mcp.clientCount, position: config?.ui?.position });
      }
      if (msg.type === 'selected') setSelected(msg.element ?? null);
      if (msg.type === 'error') onStatus(msg.message, 'error');
      if (msg.type === 'control') {
        if (msg.action === 'inspect' && typeof msg.enabled === 'boolean') { setMode(msg.enabled ? 'inspect' : 'off'); toOverlay({ type: 'mode', mode: msg.enabled ? 'inspect' : 'off' }); }
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
  }, [actions, bridgeApi, config?.ui?.position, dev, mcp.clientCount, onStatus, previewOrigin, session, showWorkspace, targetUrl, toOverlay]);

  useEffect(() => {
    toOverlay({ type: 'mode', mode });
    toOverlay({ type: 'state', openComments: session.comments.filter((c) => !c.resolved).length, pendingEdits: session.edits.filter((e) => !e.applied).length, dev, mcpClients: mcp.clientCount, position: config?.ui?.position });
  }, [mode, session, dev, mcp.clientCount, config?.ui?.position, toOverlay]);

  useEffect(() => {
    if (selection?.selector) toOverlay({ type: 'flashSelector', selector: selection.selector });
  }, [selection?.id, selection?.selectedAt, selection?.selector, toOverlay]);

  useEffect(() => {
    const onKey = (event) => {
      if (/INPUT|TEXTAREA|SELECT/.test(event.target?.tagName ?? '') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') { toOverlay({ type: 'escape' }); if (workspaceOpen) setWorkspaceOpen(false); else setMode('off'); }
      if (event.key.toLowerCase() === 'g') showWorkspace('feedback');
      if (event.key.toLowerCase() === 'i') { const next = mode === 'inspect' ? 'off' : 'inspect'; setMode(next); toOverlay({ type: 'mode', mode: next }); }
      if (event.key.toLowerCase() === 'c') showWorkspace('feedback');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, showWorkspace, toOverlay, workspaceOpen]);

  const connect = async (url) => {
    try { await actions.setTargetUrl(url); setSelected(null); onStatus(`Connected to ${url}`, 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
  };
  const discover = async () => {
    try { const found = await actions.discover(); onStatus(found.length ? `${found.length} local server${found.length === 1 ? '' : 's'} found` : 'No local dev server found', found.length ? 'ok' : 'error'); return found; }
    catch (error) { onStatus(error.message, 'error'); return []; }
  };
  const select = (id) => { const item = session.elements.find((element) => element.id === id); if (!item) return; setSelected(item); toOverlay({ type: 'flashSelector', selector: item.selector }); };
  const hideControls = () => { toOverlay({ type: 'hideControls' }); setWorkspaceOpen(false); };

  return <main className="immersive">
    {targetUrl ? <iframe key={reloadKey} ref={frameRef} className="immersive-preview" title="Live application preview" src={`${config?.previewUrl}/proxy/?r=${reloadKey}`} onLoad={() => toOverlay({ type: 'mode', mode })} /> : <section className="immersive-empty"><h1>Start reviewing your app</h1><p>Run <code>uidit</code> from your project to launch its development server, or connect a local server below.</p><Toolbar config={config} onConnect={connect} onDiscover={discover} onReload={() => setReloadKey((key) => key + 1)} mode={mode} onMode={setMode} /></section>}
    {workspaceOpen && <section className="workspace-drawer" aria-label="UIDIT review workspace">
      <header className="workspace-head"><div><div className="workspace-brand">uidit <span>WORKSPACE</span></div><div className="workspace-caption">{(() => { try { return targetUrl ? new URL(targetUrl).host : 'Local development review'; } catch { return 'Local development review'; } })()}</div></div><button className="workspace-close" type="button" aria-label="Close workspace" onClick={() => setWorkspaceOpen(false)}>×</button></header>
      {targetUrl && <Toolbar config={config} onConnect={connect} onDiscover={discover} onReload={() => setReloadKey((key) => key + 1)} mode={mode} onMode={setMode} />}
      <div className="workspace-meta"><span className={`status-dot ${['ready', 'attached'].includes(dev?.state) ? 'online' : ''}`} /><span>Server {dev?.state ?? 'idle'}</span><code>{dev?.url ?? targetUrl ?? 'no target'}</code></div>
      <div className="workspace-tabs" role="tablist" aria-label="Review workspace sections">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'feedback' && session.comments.some((c) => !c.resolved) ? <span className="tab-count">{session.comments.filter((c) => !c.resolved).length}</span> : null}</button>)}</div>
      <div className="workspace-content">
        {['feedback', 'inspect', 'changes'].includes(tab) && <Sidebar session={session} selectedId={selected?.id} onSelect={select} actions={actions} onOverlay={toOverlay} onStatus={onStatus} tab={tab} showTabs={false} />}
        {tab === 'server' && <ServerPanel config={config} dev={dev} actions={actions} onStatus={onStatus} />}
        {tab === 'agents' && <AgentsPanel config={config} mcp={mcp} actions={actions} onStatus={onStatus} />}
        {tab === 'settings' && <SettingsPanel config={config} actions={actions} onStatus={onStatus} onHide={hideControls} />}
      </div>
      <footer className="workspace-foot"><span className="status-dot online" /> Local · {live}</footer>
    </section>}
    <div className={`toast ${workspaceOpen ? 'visible' : ''}`} role="status" aria-live="polite"><span className="dot"/><span>{status.text}</span></div>
  </main>;
}
