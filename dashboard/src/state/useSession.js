import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_SESSION = { version: 2, elements: [], comments: [], edits: [], flows: [], tasks: [], evidence: [], proposals: [], updatedAt: null };

async function req(route, method = 'GET', body) {
  const res = await fetch(route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`);
  return res.json();
}

/**
 * Live session state. Initial payload comes from the REST API, then a
 * Server-Sent Events stream keeps it in sync: the server pushes on every
 * mutation, including edits written to .uidit/session.json by a coding agent.
 */
export function useSession() {
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(EMPTY_SESSION);
  const [status, setStatus] = useState('connecting…');
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [dev, setDev] = useState({ state: 'idle', logs: [] });
  const [mcp, setMcp] = useState({ clientCount: 0 });
  const [selection, setSelection] = useState(null);
  const [collaboration, setCollaboration] = useState({ enabled: false, connected: false, participants: [] });
  const [browserContext, setBrowserContext] = useState(null);
  const [browserDiagnostics, setBrowserDiagnostics] = useState([]);
  const [browserAction, setBrowserAction] = useState(null);
  const sourceRef = useRef(null);

  const refresh = useCallback(async () => {
    const data = await req('/api/state');
    setConfig(data.config);
    setSession(data.session);
    setCollaboration(data.collaboration ?? { enabled: false, connected: false, participants: [] });
    return data;
  }, []);

  useEffect(() => {
    let closed = false;
    Promise.all([refresh(), req('/api/dev'), req('/api/mcp')]).then(([, nextDev, nextMcp]) => {
      if (closed) return; setDev(nextDev); setMcp(nextMcp); setLoading(false);
    }).catch((err) => { if (!closed) { setStatus(err.message); setLoading(false); } });

    const source = new EventSource('/api/stream');
    sourceRef.current = source;
    source.addEventListener('session', (ev) => {
      if (closed) return;
      setSession(JSON.parse(ev.data));
      setLive(true);
      setStatus('live');
    });
    source.addEventListener('config', (ev) => {
      if (closed) return;
      const payload = JSON.parse(ev.data);
      const next = payload.config ?? payload;
      setConfig((current) => ({ ...next, previewUrl: next.previewUrl ?? current?.previewUrl ?? `http://127.0.0.1:${next.previewPort ?? 7717}` }));
    });
    source.addEventListener('dev', (ev) => { if (!closed) setDev((current) => ({ ...current, ...JSON.parse(ev.data) })); });
    source.addEventListener('mcp', (ev) => { if (!closed) setMcp(JSON.parse(ev.data)); });
    source.addEventListener('selection', (ev) => { if (!closed) setSelection(JSON.parse(ev.data)); });
    source.addEventListener('collaboration', (ev) => { if (!closed) setCollaboration(JSON.parse(ev.data)); });
    source.addEventListener('browser-context', (ev) => { if (!closed) setBrowserContext(JSON.parse(ev.data)); });
    source.addEventListener('browser-diagnostics', (ev) => { if (!closed) setBrowserDiagnostics((items) => [...items, ...JSON.parse(ev.data)].slice(-250)); });
    source.addEventListener('browser-action', (ev) => { if (!closed) setBrowserAction(JSON.parse(ev.data)); });
    source.onerror = () => {
      if (!closed) {
        setLive(false);
        setStatus('reconnecting…');
      }
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [refresh]);

  const withSession = (request) => request.then((data) => { if (data.session) setSession(data.session); return data; });
  const actions = {
    setTargetUrl: (targetUrl) => req('/api/config', 'POST', { targetUrl }).then((d) => setConfig(d.config)),
    setConfig: (patch) => req('/api/config', 'POST', patch).then((d) => setConfig(d.config)),
    comment: (body) => req('/api/comment', 'POST', body),
    reply: (commentId, body) => req(`/api/comments/${encodeURIComponent(commentId)}/replies`, 'POST', body),
    element: (body) => req('/api/element', 'POST', body),
    edit: (body) => req('/api/edit', 'POST', body),
    overlay: (route, method, body) => {
      if (!['/element', '/comment', '/comment-reply', '/edit'].includes(route) || method !== 'POST') throw new Error('unsupported preview bridge request');
      return req(`/api${route}`, method, body);
    },
    patch: (collection, id, patchBody) => req(`/api/${collection}/${encodeURIComponent(id)}`, 'PATCH', patchBody),
    remove: (collection, id) => withSession(req(`/api/${collection}/${encodeURIComponent(id)}`, 'DELETE')),
    discover: () => req('/api/discover').then((d) => d.targets),
    dev: () => req('/api/dev'),
    devAction: (action) => {
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error('unsupported server action');
      return req(`/api/dev/${action}`, 'POST', {});
    },
    serviceAction: (id, action) => {
      if (!['start', 'stop'].includes(action)) throw new Error('unsupported workspace service action');
      return req(`/api/services/${encodeURIComponent(id)}/${action}`, 'POST', {});
    },
    serviceGroupAction: (action) => {
      if (!['start-all', 'stop-all'].includes(action)) throw new Error('unsupported workspace services action');
      return req(`/api/services/${action}`, 'POST', {});
    },
    mcp: () => req('/api/mcp'),
    selectElement: (selection) => req('/api/selection', 'POST', selection),
    createCollaborationRoom: (body) => req('/api/collaboration/room', 'POST', body).then((data) => { setCollaboration(data.collaboration); return data.collaboration; }),
    createCollaborationPageView: () => req('/api/collaboration/page-view', 'POST', {}).then((data) => { setCollaboration((current) => ({ ...current, pageView: data.pageView })); return data.pageView; }),
    revokeCollaborationInvite: () => req('/api/collaboration/revoke-invite', 'POST', {}).then((data) => { setCollaboration(data.collaboration); return data.collaboration; }),
    stopCollaborationSharing: () => req('/api/collaboration/stop', 'POST', {}).then((data) => { setCollaboration(data.collaboration); return data.collaboration; }),
    createFlow: (name) => withSession(req('/api/flows', 'POST', { name })),
    addFlowStep: (flowId, step) => withSession(req(`/api/flows/${encodeURIComponent(flowId)}/steps`, 'POST', step)),
    addFlowLog: (flowId, log) => withSession(req(`/api/flows/${encodeURIComponent(flowId)}/logs`, 'POST', log)),
    updateFlow: (flowId, patch) => withSession(req(`/api/flows/${encodeURIComponent(flowId)}`, 'PATCH', patch)),
    createTask: (body) => withSession(req('/api/tasks', 'POST', body)),
    updateTask: (taskId, patch) => withSession(req(`/api/tasks/${encodeURIComponent(taskId)}`, 'PATCH', patch)),
    addEvidence: (taskId, body) => withSession(req(`/api/tasks/${encodeURIComponent(taskId)}/evidence`, 'POST', body)),
    reattachComment: (commentId, elementId) => withSession(req(`/api/comments/${encodeURIComponent(commentId)}/reattach`, 'POST', { elementId })),
    createProposal: (body) => withSession(req('/api/proposals', 'POST', body)),
    updateProposal: (proposalId, status) => withSession(req(`/api/proposals/${encodeURIComponent(proposalId)}`, 'PATCH', { status })),
    elementSource: (elementId) => req(`/api/elements/${encodeURIComponent(elementId)}/source`),
    browserContext: (body) => req('/api/browser/context', 'POST', body),
    browserDiagnostics: (entries) => req('/api/browser/diagnostics', 'POST', { entries }),
    browserActionResult: (id, result) => req('/api/browser/action-result', 'POST', { id, ...result }),
    projectContext: () => req('/api/project/context'),
    captureTaskSnapshot: (taskId, kind) => withSession(req(`/api/tasks/${encodeURIComponent(taskId)}/captures/${kind}`, 'POST', {})),
  };

  return { config, session, status, loading, live, dev, mcp, collaboration, selection, browserContext, browserDiagnostics, browserAction, refresh, actions };
}
