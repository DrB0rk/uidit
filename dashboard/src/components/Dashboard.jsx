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
  const [reloadKey, setReloadKey] = useState(0);

  const targetUrl = config?.targetUrl ?? null;

  const toOverlay = useCallback((message) => {
    frameRef.current?.contentWindow?.postMessage({ source: 'uidit-dashboard', ...message }, '*');
  }, []);

  // Selection changes inside the preview; mirror them into the panels.
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

  // Number keys switch mode; they must not fire while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1') setMode('inspect');
      if (e.key === '2') setMode('text');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const connect = async (url) => {
    try {
      await actions.setTargetUrl(url);
      setSelectedId(null);
      setStatus({ text: `Connected to ${url}`, kind: 'ok' });
    } catch (err) {
      setStatus({ text: err.message, kind: 'error' });
    }
  };

  const discover = async () => {
    try {
      const found = await actions.discover();
      setStatus(
        found.length
          ? { text: `${found.length} local server${found.length === 1 ? '' : 's'} found`, kind: 'ok' }
          : { text: 'No dev server running. Start one, then paste its URL.', kind: 'error' },
      );
      return found;
    } catch (err) {
      setStatus({ text: err.message, kind: 'error' });
      return [];
    }
  };

  const onStatus = (text, kind = '') => setStatus({ text, kind });

  const select = (id) => {
    setSelectedId(id);
    const el = session.elements.find((e) => e.id === id);
    if (el) {
      setStatus({ text: `Tagged ${el.tag} ${el.selector}`, kind: '' });
      toOverlay({ type: 'flashSelector', selector: el.selector });
    }
  };

  return (
    <>
      <Toolbar
        config={config}
        onConnect={connect}
        onDiscover={discover}
        onReload={() => setReloadKey((k) => k + 1)}
        mode={mode}
        onMode={setMode}
      />

      <main className="split">
        <section className="stage" aria-label="Preview">
          {!targetUrl && (
            <div className="empty">
              <h1>Point uidit at your dev server</h1>
              <p>Any port works — uidit proxies the page and injects the inspection overlay, so no changes to your app.</p>
              <ol className="empty-steps">
                <li><b>1</b><span>Start your project's dev server in a terminal.</span></li>
                <li><b>2</b><span>Paste its URL above, or hit <strong>Discover</strong> to pick from local servers.</span></li>
                <li><b>3</b><span>Click any element to tag it, then comment or try a quick edit.</span></li>
              </ol>
            </div>
          )}

          <iframe
            key={reloadKey}
            ref={frameRef}
            id="preview"
            className={targetUrl ? 'live' : ''}
            title="Preview of the connected dev server"
            src={targetUrl ? `/proxy/?r=${reloadKey}` : 'about:blank'}
            onLoad={() => {
              setFrameReady(false);
              toOverlay({ type: 'mode', mode });
            }}
          />
        </section>

        <Sidebar
          session={session}
          selectedId={selectedId}
          onSelect={select}
          actions={actions}
          onOverlay={toOverlay}
          onStatus={onStatus}
        />
      </main>

      {/* aria-live so status changes are announced, not just seen. */}
      <div className="toast" role="status" aria-live="polite">
        <span className="dot" style={{ background: status.kind === 'error' ? 'var(--danger-text)' : status.kind === 'ok' ? 'var(--ok-text)' : 'var(--fg-subtle)' }} />
        <span className="toast-text">{status.text}</span>
        <span className="muted hint">· {live}</span>
      </div>
    </>
  );
}