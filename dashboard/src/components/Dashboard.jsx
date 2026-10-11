import { useCallback, useEffect, useRef, useState } from 'react';
import Toolbar from './Toolbar.jsx';
import Sidebar from './Sidebar.jsx';
import { useSession } from '../state/useSession.js';

export default function Dashboard() {
  const { config, session, status: live, actions } = useSession();
  const frameRef = useRef(null);
  const [mode, setMode] = useState('inspect');
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState({ text: 'ready', kind: '' });
  const [frameReady, setFrameReady] = useState(false);

  const targetUrl = config?.targetUrl ?? null;

  const toOverlay = useCallback((message) => {
    frameRef.current?.contentWindow?.postMessage({ source: 'uidit-dashboard', ...message }, '*');
  }, []);

  // Selection can change inside the preview; mirror it into the panels.
  useEffect(() => {
    const onMessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.source !== 'uidit-overlay') return;
      if (msg.type === 'ready') setFrameReady(true);
      if (msg.type === 'selected') setSelectedId(msg.element?.id ?? null);
      if (msg.type === 'error') setStatus({ text: msg.message, kind: 'error' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Re-apply the active mode after every preview navigation.
  useEffect(() => {
    if (frameReady) toOverlay({ type: 'mode', mode });
  }, [mode, frameReady, toOverlay]);

  const connect = async (url) => {
    try {
      await actions.setTargetUrl(url);
      setStatus({ text: `connected to ${url}`, kind: 'ok' });
    } catch (err) {
      setStatus({ text: err.message, kind: 'error' });
    }
  };

  const discover = async () => {
    try {
      const found = await actions.discover();
      setStatus({ text: found.length ? `found ${found.length} local server(s)` : 'no dev server found on common ports', kind: found.length ? 'ok' : 'error' });
      return found;
    } catch (err) {
      setStatus({ text: err.message, kind: 'error' });
      return [];
    }
  };

  const onStatus = (text, kind = '') => setStatus({ text, kind });

  return (
    <>
      <Toolbar
        config={config}
        onConnect={connect}
        onDiscover={discover}
        mode={mode}
        onMode={setMode}
      />
      <main className="split">
        <section className="stage">
          {!targetUrl && (
            <div className="empty">
              <h1>No preview connected</h1>
              <p>Start your project's dev server, then paste its URL above or hit <strong>Discover</strong>.</p>
              <p className="hint">uidit proxies the page and injects the inspection overlay, so it works with any framework.</p>
            </div>
          )}
          <iframe
            ref={frameRef}
            id="preview"
            className={targetUrl ? 'live' : ''}
            title="preview"
            src={targetUrl ? '/proxy/' : 'about:blank'}
            onLoad={() => {
              setFrameReady(false);
              toOverlay({ type: 'mode', mode });
            }}
          />
        </section>
        <Sidebar
          session={session}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            const el = session.elements.find((e) => e.id === id);
            if (el) {
              setStatus({ text: `tagged ${el.tag} ${el.selector}`, kind: '' });
              toOverlay({ type: 'flashSelector', selector: el.selector });
            }
          }}
          actions={actions}
          onOverlay={toOverlay}
          onStatus={onStatus}
        />
      </main>
      <div className={`foot ${status.kind}`} style={{ position: 'fixed', right: '16px', bottom: '44px', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>
        <span id="status" className={status.kind === 'error' ? 'error' : status.kind === 'ok' ? 'ok' : 'muted'}>{status.text}</span>
        <span className="muted"> · {live}</span>
      </div>
    </>
  );
}