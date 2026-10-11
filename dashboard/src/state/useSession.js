import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_SESSION = { elements: [], comments: [], edits: [], updatedAt: null };

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
  const [live, setLive] = useState(false);
  const [dev, setDev] = useState({ state: 'idle', logs: [] });
  const [mcp, setMcp] = useState({ clientCount: 0 });
  const [selection, setSelection] = useState(null);
  const [collaboration, setCollaboration] = useState({ enabled: false, connected: false, participants: [] });
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
      if (closed) return; setDev(nextDev); setMcp(nextMcp);
    }).catch((err) => setStatus(err.message));

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
    source.addEventListener('dev', (ev) => { if (!closed) setDev(JSON.parse(ev.data)); });
    source.addEventListener('mcp', (ev) => { if (!closed) setMcp(JSON.parse(ev.data)); });
    source.addEventListener('selection', (ev) => { if (!closed) setSelection(JSON.parse(ev.data)); });
    source.addEventListener('collaboration', (ev) => { if (!closed) setCollaboration(JSON.parse(ev.data)); });
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
    remove: (collection, id) => req(`/api/${collection}/${encodeURIComponent(id)}`, 'DELETE'),
    discover: () => req('/api/discover').then((d) => d.targets),
    dev: () => req('/api/dev'),
    devAction: (action) => {
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error('unsupported server action');
      return req(`/api/dev/${action}`, 'POST', {});
    },
    mcp: () => req('/api/mcp'),
    selectElement: (selection) => req('/api/selection', 'POST', selection),
    createCollaborationRoom: (body) => req('/api/collaboration/room', 'POST', body),
    createFlow: (name) => withSession(req('/api/flows', 'POST', { name })),
    addFlowStep: (flowId, step) => withSession(req(`/api/flows/${encodeURIComponent(flowId)}/steps`, 'POST', step)),
    addFlowLog: (flowId, log) => withSession(req(`/api/flows/${encodeURIComponent(flowId)}/logs`, 'POST', log)),
    updateFlow: (flowId, patch) => withSession(req(`/api/flows/${encodeURIComponent(flowId)}`, 'PATCH', patch)),
  };

  return { config, session, status, live, dev, mcp, collaboration, selection, refresh, actions };
}
