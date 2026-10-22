import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './Toolbar.jsx';
import { useSession } from '../state/useSession.js';
import { MessageSquareText, Settings2, Sun, Moon, Workflow, Laptop, Tablet, Smartphone, WandSparkles } from 'lucide-react';

const Sidebar = lazy(() => import('./Sidebar.jsx'));
const DesignPanel = lazy(() => import('./DesignPanel.jsx').then((module) => ({ default: module.DesignPanel })));
const FlowsPanel = lazy(() => import('./RuntimePanels.jsx').then((module) => ({ default: module.FlowsPanel })));
const ServerPanel = lazy(() => import('./RuntimePanels.jsx').then((module) => ({ default: module.ServerPanel })));
const AgentsPanel = lazy(() => import('./RuntimePanels.jsx').then((module) => ({ default: module.AgentsPanel })));
const SettingsPanel = lazy(() => import('./RuntimePanels.jsx').then((module) => ({ default: module.SettingsPanel })));

const TABS = [['review', 'Review', MessageSquareText], ['design', 'Design', WandSparkles], ['runtime', 'Runtime', Workflow], ['project', 'Project', Settings2]];
const REVIEW_TABS = ['feedback', 'inspect', 'changes', 'share'];
const RUNTIME_TABS = [['flows', 'Flows'], ['server', 'Server']];
const PROJECT_TABS = [['agents', 'Agents'], ['settings', 'Settings']];
const TAB_GROUP = { review: 'review', feedback: 'review', inspect: 'review', changes: 'review', share: 'review', design: 'design', runtime: 'runtime', flows: 'runtime', server: 'runtime', project: 'project', agents: 'project', settings: 'project' };
const PREVIEW_API = new Set(['/element', '/comment', '/comment-reply', '/comment-update', '/comment-delete', '/edit']);
// The review panel resizes by dragging its edge; the preview keeps the rest of the width.
const DRAWER_KEY = 'uidit-drawer-width';
const DRAWER_MIN = 320;
const DRAWER_MAX = 760;
const DRAWER_DEFAULT = 420;
const DRAWER_PREVIEW_MIN = 360;

function WorkspaceSubnav({ label, items, selected, onSelect }) {
  return <nav className="workspace-subnav" aria-label={`${label} sections`}>
    {items.map(([id, title]) => <button key={id} type="button" aria-current={selected === id ? 'page' : undefined} className={selected === id ? 'active' : ''} onClick={() => onSelect(id)}>{title}</button>)}
  </nav>;
}

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
  const { config, session, status: live, loading, dev, mcp, collaboration, selection, browserContext, browserDiagnostics, browserAction, browserActivity, executorClient, setBrowserExecutorHandler, actions } = useSession();
  const frameRef = useRef(null);
  const executorRef = useRef({ bridgeNonce: null, leaseToken: null, generation: null, actionId: null, heartbeat: null, standbyTimer: null });
  const replayWaiters = useRef(new Map());
  const undoStack = useRef([]);
  const undoPending = useRef(false);
  const [mode, setMode] = useState('off');
  const [selected, setSelected] = useState(null);
  const [anchorStatuses, setAnchorStatuses] = useState({});
  const [status, setStatus] = useState({ text: 'ready', kind: '' });
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [tab, setTab] = useState('review');
  const [reviewTab, setReviewTab] = useState('feedback');
  const [runtimeTab, setRuntimeTab] = useState('flows');
  const [projectTab, setProjectTab] = useState('agents');
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
    if (params.get('workspace') === '0') setWorkspaceOpen(false);
    const initialTab = params.get('tab');
    if (TAB_GROUP[initialTab]) {
      setTab(TAB_GROUP[initialTab]);
      if (REVIEW_TABS.includes(initialTab)) setReviewTab(initialTab);
      if (RUNTIME_TABS.some(([id]) => id === initialTab)) setRuntimeTab(initialTab);
      if (PROJECT_TABS.some(([id]) => id === initialTab)) setProjectTab(initialTab);
    }
  }, []);

  const targetUrl = config?.targetUrl ?? null;
  const previewOrigin = useMemo(() => { try { return new URL(config?.previewUrl).origin; } catch { return ''; } }, [config?.previewUrl]);

  const executorRequest = useCallback(async (route, body) => {
    const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || 'The browser executor request was rejected.');
    return payload;
  }, []);

  const releaseExecutor = useCallback(() => {
    const executor = executorRef.current;
    if (executor.heartbeat) clearInterval(executor.heartbeat);
    if (executor.standbyTimer) clearTimeout(executor.standbyTimer);
    executor.heartbeat = null;
    executor.standbyTimer = null;
    if (executor.clientId && executor.leaseToken && executor.generation != null && executor.bridgeNonce) {
      executorRequest('/api/browser/executor/release', { clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce }).catch(() => {});
    }
    executorRef.current = { bridgeNonce: null, leaseToken: null, generation: null, actionId: null, heartbeat: null, standbyTimer: null };
  }, [executorRequest]);

  const toOverlay = useCallback((message) => {
    if (previewOrigin) frameRef.current?.contentWindow?.postMessage({ source: 'uidit-dashboard', ...message }, previewOrigin);
  }, [previewOrigin]);

  const claimExecutor = useCallback(async (navigation = null) => {
    if (!executorClient?.clientId || !previewOrigin || !frameRef.current?.contentWindow) return;
    const existing = executorRef.current;
    if (existing.clientId === executorClient.clientId && existing.leaseToken) {
      if (navigation?.actionId && navigation?.navigationToken && typeof navigation.currentPath === 'string') {
        const nextBridgeNonce = crypto.randomUUID();
        executorRequest(`/api/browser/actions/${encodeURIComponent(navigation.actionId)}/navigation-ready`, {
          clientId: existing.clientId, leaseToken: existing.leaseToken, generation: existing.generation,
          previousBridgeNonce: existing.bridgeNonce, newBridgeNonce: nextBridgeNonce,
          navigationToken: navigation.navigationToken, currentPath: navigation.currentPath,
        }).then(() => {
          if (executorRef.current === existing) existing.bridgeNonce = nextBridgeNonce;
          toOverlay({ type: 'browser-action-navigation-complete', actionId: navigation.actionId });
        }).catch(() => {});
      }
      return;
    }
    releaseExecutor();
    const bridgeNonce = crypto.randomUUID();
    try {
      const result = await executorRequest('/api/browser/executor/ready', { clientId: executorClient.clientId, bridgeNonce, previewOrigin });
      if (result.status === 'standby') {
        executorRef.current.standbyTimer = setTimeout(() => claimExecutor(), Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 5000);
        return;
      }
      if (result.status !== 'leased' || typeof result.leaseToken !== 'string' || !Number.isInteger(result.generation)) return;
      const executor = { clientId: executorClient.clientId, bridgeNonce, leaseToken: result.leaseToken, generation: result.generation, actionId: null, heartbeat: null, standbyTimer: null };
      const heartbeatMs = Number.isFinite(result.heartbeatMs) ? result.heartbeatMs : 5000;
      executor.heartbeat = setInterval(() => {
        executorRequest('/api/browser/executor/renew', { clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce }).catch(() => releaseExecutor());
      }, heartbeatMs);
      executorRef.current = executor;
      if (navigation?.actionId && navigation?.navigationToken && typeof navigation.currentPath === 'string') claimExecutor(navigation);
    } catch {
      // Standby and unavailable states are represented by the server activity feed.
    }
  }, [executorClient?.clientId, executorRequest, previewOrigin, releaseExecutor, toOverlay]);

  useEffect(() => () => releaseExecutor(), [releaseExecutor]);

  useEffect(() => {
    if (executorClient?.clientId && previewOrigin && frameRef.current?.contentWindow) claimExecutor();
  }, [claimExecutor, executorClient?.clientId, previewOrigin]);

  useEffect(() => setBrowserExecutorHandler(({ kind, payload }) => {
    if (kind === 'leased' && executorClient?.clientId && typeof payload?.leaseToken === 'string' && Number.isInteger(payload.generation) && typeof payload.bridgeNonce === 'string') {
      const previous = executorRef.current;
      if (previous.heartbeat) clearInterval(previous.heartbeat);
      if (previous.standbyTimer) clearTimeout(previous.standbyTimer);
      const executor = { clientId: executorClient.clientId, leaseToken: payload.leaseToken, generation: payload.generation, bridgeNonce: payload.bridgeNonce, actionId: null, heartbeat: null, standbyTimer: null };
      executor.heartbeat = setInterval(() => {
        executorRequest('/api/browser/executor/renew', { clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce }).catch(() => releaseExecutor());
      }, Number.isFinite(payload.heartbeatMs) ? payload.heartbeatMs : 5000);
      executorRef.current = executor;
      return;
    }
    const executor = executorRef.current;
    if (kind === 'finished' && payload?.actionId === executor.actionId && payload.generation === executor.generation && payload.bridgeNonce === executor.bridgeNonce) {
      toOverlay({ type: 'browser-action-complete', actionId: payload.actionId, generation: payload.generation, bridgeNonce: payload.bridgeNonce });
      executor.actionId = null;
      return;
    }
    if (!payload || !executor.leaseToken || payload.generation !== executor.generation || payload.bridgeNonce !== executor.bridgeNonce) return;
    if (kind === 'command' && typeof payload.actionId === 'string' && payload.command && typeof payload.command.type === 'string') {
      executor.actionId = payload.actionId;
      toOverlay({ type: 'browser-action-prepare', actionId: payload.actionId, generation: payload.generation, bridgeNonce: payload.bridgeNonce, command: payload.command });
    }
    if (kind === 'cancel' && payload.actionId === executor.actionId) {
      toOverlay({ type: 'browser-action-cancel', actionId: payload.actionId, generation: payload.generation, bridgeNonce: payload.bridgeNonce, code: payload.code });
      executor.actionId = null;
    }
  }), [executorClient?.clientId, executorRequest, releaseExecutor, setBrowserExecutorHandler, toOverlay]);

  const showWorkspace = useCallback((nextTab = 'feedback') => {
    setTab(TAB_GROUP[nextTab] ?? 'review');
    if (REVIEW_TABS.includes(nextTab)) setReviewTab(nextTab);
    if (RUNTIME_TABS.some(([id]) => id === nextTab)) setRuntimeTab(nextTab);
    if (PROJECT_TABS.some(([id]) => id === nextTab)) setProjectTab(nextTab);
    setWorkspaceOpen(true);
  }, []);

  const syncOverlay = useCallback(() => {
    toOverlay({ type: 'mode', mode });
    toOverlay({ type: 'state', mode, openComments: session.comments.filter((c) => !c.resolved).length, pendingEdits: session.edits.filter((e) => !e.applied).length, dev, mcpClients: mcp.clientCount, position: config?.ui?.position, browserInspection: config?.ui?.allowBrowserInspection === true, comments: session.comments, elements: session.elements, theme });
  }, [mode, session, dev, mcp.clientCount, config?.ui?.position, config?.ui?.allowBrowserInspection, theme, toOverlay]);

  const onStatus = useCallback((text, kind = '') => setStatus({ text, kind }), []);

  const undoAction = useCallback(async (action) => {
    if (action.pending) { action.undoRequested = true; return; }
    if (!action.id || undoPending.current) return;
    undoPending.current = true;
    try {
      await actions.remove('comments', action.id);
      const index = undoStack.current.indexOf(action);
      if (index >= 0) undoStack.current.splice(index, 1);
      onStatus('Last comment undone', 'ok');
    } catch (error) {
      onStatus(`Could not undo comment: ${error.message}`, 'error');
    } finally {
      undoPending.current = false;
    }
  }, [actions, onStatus]);

  const recordComment = useCallback(async (body) => {
    const action = { type: 'comment', id: null, pending: true, undoRequested: false };
    undoStack.current.push(action);
    try {
      const result = await actions.comment(body);
      action.id = result.comment?.id ?? null;
      action.pending = false;
      if (!action.id) undoStack.current.splice(undoStack.current.indexOf(action), 1);
      else if (action.undoRequested) undoAction(action);
      return result;
    } catch (error) {
      const index = undoStack.current.indexOf(action);
      if (index >= 0) undoStack.current.splice(index, 1);
      throw error;
    }
  }, [actions, undoAction]);

  const undoLast = useCallback(() => {
    const action = undoStack.current.at(-1);
    if (action) undoAction(action);
  }, [undoAction]);

  const reviewActions = useMemo(() => ({ ...actions, comment: recordComment }), [actions, recordComment]);

  const runShortcut = useCallback((key) => {
    if (key === 'undo') { undoLast(); return; }
    if (key === 'escape') {
      toOverlay({ type: 'escape' });
      return;
    }
    if (key === 'i') { const next = mode === 'inspect' ? 'off' : 'inspect'; setMode(next); toOverlay({ type: 'mode', mode: next }); return; }
    if (key === 'g' || key === 'c') { showWorkspace('feedback'); return; }
    if (key === 'u') toOverlay({ type: 'showControls' });
  }, [mode, showWorkspace, toOverlay, undoLast]);

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
      return recordComment(body);
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
    if (msg.route === '/comment-update') {
      if (typeof body.commentId !== 'string' || !body.commentId || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new Error('Comment text must be 1–4000 characters');
      return actions.patch('comments', body.commentId.slice(0, 200), { text: body.text.trim() });
    }
    if (msg.route === '/comment-delete') {
      if (typeof body.commentId !== 'string' || !body.commentId) throw new Error('Comment ID is required');
      return actions.remove('comments', body.commentId.slice(0, 200));
    }
    if (!['text', 'style', 'attribute', 'class', 'remove'].includes(body.kind)) throw new Error('Unsupported preview edit');
    body.before = body.before == null ? null : String(body.before).slice(0, 2000);
    body.after = body.after == null ? null : String(body.after).slice(0, 2000);
    if (typeof body.property === 'string') body.property = body.property.slice(0, 100);
    body.page = typeof body.page === 'string' ? body.page.slice(0, 2000) : null;
    return actions.edit(body);
  }, [actions, recordComment]);

  useEffect(() => {
    if (!targetUrl || !previewOrigin) return;
    const onMessage = async (ev) => {
      if (ev.source !== frameRef.current?.contentWindow || ev.origin !== previewOrigin) return;
      const msg = ev.data;
      if (!msg || msg.source !== 'uidit-overlay') return;
      if (msg.type === 'browser-executor-preview-ready') {
        claimExecutor(msg.navigation && typeof msg.navigation === 'object' ? msg.navigation : null);
        return;
      }
      const executor = executorRef.current;
      const matchesExecutorAction = typeof msg.actionId === 'string' && msg.actionId === executor.actionId && msg.generation === executor.generation && msg.bridgeNonce === executor.bridgeNonce;
      if (msg.type === 'browser-action-prepared' && matchesExecutorAction) {
        executorRequest(`/api/browser/actions/${encodeURIComponent(msg.actionId)}/prepared`, {
          clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce,
          bounds: msg.bounds && Number.isFinite(msg.bounds.x) && Number.isFinite(msg.bounds.y) && Number.isFinite(msg.bounds.width) && Number.isFinite(msg.bounds.height) ? msg.bounds : null,
          visibility: ['onscreen', 'partial', 'offscreen'].includes(msg.visibility) ? msg.visibility : 'offscreen',
        }).then((prepared) => executorRequest(`/api/browser/actions/${encodeURIComponent(msg.actionId)}/execute`, {
          clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce, prepareToken: prepared.prepareToken,
        })).then((authorized) => {
          if (executorRef.current.actionId !== msg.actionId) return;
          toOverlay({ type: 'browser-action-execute', actionId: msg.actionId, generation: executor.generation, bridgeNonce: executor.bridgeNonce, executeToken: authorized.executeToken, navigationToken: authorized.navigationToken });
        }).catch(() => {
          toOverlay({ type: 'browser-action-cancel', actionId: msg.actionId, generation: executor.generation, bridgeNonce: executor.bridgeNonce, code: 'action_failed' });
          if (executorRef.current.actionId === msg.actionId) executorRef.current.actionId = null;
        });
        return;
      }
      if (msg.type === 'browser-action-result' && matchesExecutorAction && (msg.outcome === 'ok' || msg.outcome === 'error') && typeof msg.executeToken === 'string') {
        const body = { clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce, executeToken: msg.executeToken, outcome: msg.outcome };
        if (msg.outcome === 'error' && typeof msg.errorCode === 'string') body.errorCode = msg.errorCode;
        if (msg.outcome === 'ok' && typeof msg.screenshot === 'string') body.screenshot = msg.screenshot;
        executorRequest(`/api/browser/actions/${encodeURIComponent(msg.actionId)}/result`, body).catch(() => {}).finally(() => {
          toOverlay({ type: 'browser-action-complete', actionId: msg.actionId, generation: executor.generation, bridgeNonce: executor.bridgeNonce });
          if (executorRef.current.actionId === msg.actionId) executorRef.current.actionId = null;
        });
        return;
      }
      if (msg.type === 'browser-action-navigation-started' && matchesExecutorAction && typeof msg.executeToken === 'string' && typeof msg.navigationToken === 'string') {
        executorRequest(`/api/browser/actions/${encodeURIComponent(msg.actionId)}/navigation-started`, { clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce, executeToken: msg.executeToken, navigationToken: msg.navigationToken }).catch(() => {});
        return;
      }
      if (msg.type === 'browser-action-cancel-ack' && matchesExecutorAction) {
        executorRequest(`/api/browser/actions/${encodeURIComponent(msg.actionId)}/cancel-ack`, { clientId: executor.clientId, leaseToken: executor.leaseToken, generation: executor.generation, bridgeNonce: executor.bridgeNonce, code: msg.code }).catch(() => {});
        if (executorRef.current.actionId === msg.actionId) executorRef.current.actionId = null;
        return;
      }
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
      if (msg.type === 'comment-move' && typeof msg.commentId === 'string' && msg.patch && typeof msg.patch === 'object') {
        const comment = session.comments.find((item) => item.id === msg.commentId);
        const patch = msg.patch;
        const finitePoint = (point, min, max) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= min && point.x <= max && point.y >= min && point.y <= max;
        let valid = false;
        if (comment?.drawing && Object.keys(patch).length === 1 && patch.drawing?.type === comment.drawing.type && Array.isArray(patch.drawing.points) && patch.drawing.points.length > 0 && patch.drawing.points.length <= 500) {
          valid = patch.drawing.points.every((point) => finitePoint(point, 0, 1));
        } else if (comment && !comment.drawing && Object.keys(patch).length === 1 && finitePoint(patch.markerOffset, -1, 1)) {
          valid = true;
        } else if (comment && !comment.drawing && Object.keys(patch).length === 1 && finitePoint(patch.anchor, 0, 1)) {
          valid = true;
        }
        if (!valid) return;
        actions.patch('comments', comment.id, patch).catch((error) => onStatus(`Could not move feedback: ${error.message}`, 'error'));
        return;
      }
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
          try { await recordComment({ text: msg.text.trim().slice(0, 4000), elementId: msg.elementId ?? null, page: typeof msg.page === 'string' ? msg.page.slice(0, 2000) : null }); onStatus('Comment saved to the shared review', 'ok'); }
          catch (error) { onStatus(error.message, 'error'); }
        }
        if (msg.action === 'workspace') {
          showWorkspace(msg.tab);
          if (msg.quickEdit === true) { setMode('inspect'); toOverlay({ type: 'mode', mode: 'inspect' }); }
        }
      }
      if (msg.type === 'mode' && typeof msg.mode === 'string') setMode(msg.mode);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [actions, bridgeApi, claimExecutor, executorRequest, onStatus, previewOrigin, recordComment, session, showWorkspace, syncOverlay, targetUrl, toOverlay]);

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
      const typing = /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName ?? '') || event.target?.isContentEditable === true;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        if (typing) return;
        event.preventDefault();
        undoLast();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && typing) { event.target.blur(); return; }
      if (typing) return;
      runShortcut(event.key.toLowerCase());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runShortcut, undoLast]);

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

  if (loading) return <main ref={mainRef} className="immersive workspace-open" aria-busy="true">
    <div className="dashboard-loader" role="status" aria-live="polite">
      <span className="uidit-loader-mark" aria-hidden="true">U</span>
      <p>Preparing your review workspace</p>
      <span className="uidit-loader-track" aria-hidden="true"><span /></span>
    </div>
  </main>;

  return <main ref={mainRef} className={`immersive${workspaceOpen ? ' workspace-open' : ''}${resizingDrawer ? ' resizing' : ''}`}>
    {workspaceOpen && <div className="workspace-wordmark" aria-label="UIDIT">
      <span className="workspace-wordmark-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round"><path d="M7 8v12a8 8 0 0 0 16 0V8"/><path d="M24.5 8v5"/></svg></span>
      <span>uidit</span>
    </div>}
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
      <nav className="workspace-tabs" aria-label="Review workspace sections">{TABS.map(([id, label, Icon]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} aria-label={label} title={label} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} strokeWidth={1.8} aria-hidden="true"/><span className="tab-label">{label}</span>{id === 'review' && session.comments.some((c) => !c.resolved) ? <span className="tab-count">{session.comments.filter((c) => !c.resolved).length}</span> : null}</button>)}</nav>
      <div className="workspace-content">
        <Suspense fallback={<div className="workspace-panel-loading" role="status">Loading workspace…</div>}>
          {tab === 'review' && <Sidebar session={session} selectedId={selected?.id} anchorStatuses={anchorStatuses} onSelect={select} actions={reviewActions} onOverlay={toOverlay} onStatus={onStatus} page={targetUrl} collaboration={collaboration} tab={reviewTab} onTab={setReviewTab} />}
          {tab === 'design' && <DesignPanel selected={selected} onOverlay={toOverlay} onStatus={onStatus} onClearSelection={() => setSelected(null)} reference={reference} onReferenceChange={setReference} compareMode={compareMode} onCompareMode={setCompareMode} opacity={referenceOpacity} onOpacity={setReferenceOpacity} />}
          {tab === 'runtime' && <><WorkspaceSubnav label="Runtime" items={RUNTIME_TABS} selected={runtimeTab} onSelect={setRuntimeTab} /><div className="workspace-panel-slot">{runtimeTab === 'flows' ? <FlowsPanel session={session} actions={actions} onStatus={onStatus} onRecording={(flowId) => toOverlay({ type: 'recordMode', enabled: Boolean(flowId), flowId })} onReplay={replayFlow} replayState={replayState} /> : <><Toolbar config={config} onConnect={connect} onDiscover={discover} onReload={() => setReloadKey((key) => key + 1)} mode={mode} onMode={setMode} /><ServerPanel config={config} dev={dev} actions={actions} onStatus={onStatus} onPreviewService={previewService} browserContext={browserContext} browserDiagnostics={browserDiagnostics} /></>}</div></>}
          {tab === 'project' && <><WorkspaceSubnav label="Project" items={PROJECT_TABS} selected={projectTab} onSelect={setProjectTab} /><div className="workspace-panel-slot">{projectTab === 'agents' ? <AgentsPanel config={config} mcp={mcp} collaboration={collaboration} session={session} browserActivity={browserActivity} actions={actions} onStatus={onStatus} /> : <SettingsPanel config={config} actions={actions} onStatus={onStatus} onHide={hideControls} />}</div></>}
        </Suspense>
      </div>
      <footer className="workspace-foot"><span className={`status-dot ${['ready', 'attached'].includes(dev?.state) ? 'online' : ''}`} /><span>Server {dev?.state ?? 'idle'}</span><span className="spacer" /><span>{live}</span></footer>
    </section>}
    <div className={`toast ${workspaceOpen ? 'visible' : ''}`} role="status" aria-live="polite"><span className="dot"/><span>{status.text}</span></div>
  </main>;
}
