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
  const sourceRef = useRef(null);

  const refresh = useCallback(async () => {
    const data = await req('/api/state');
    setConfig(data.config);
    setSession(data.session);
    return data;
  }, []);

  useEffect(() => {
    let closed = false;
    refresh().catch((err) => setStatus(err.message));

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
      setConfig(payload.config ?? payload);
    });
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

  const actions = {
    setTargetUrl: (targetUrl) => req('/api/config', 'POST', { targetUrl }).then((d) => setConfig(d.config)),
    comment: (body) => req('/api/comment', 'POST', body),
    patch: (collection, id, patchBody) => req(`/api/${collection}/${encodeURIComponent(id)}`, 'PATCH', patchBody),
    remove: (collection, id) => req(`/api/${collection}/${encodeURIComponent(id)}`, 'DELETE'),
    discover: () => req('/api/discover').then((d) => d.targets),
  };

  return { config, session, status, live, refresh, actions };
}