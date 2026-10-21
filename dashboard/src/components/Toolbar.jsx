import { useEffect, useId, useRef, useState } from 'react';
import { Compass, MousePointer2, FileJson, RefreshCw } from 'lucide-react';

export default function Toolbar({ config, onConnect, onDiscover, mode, onMode, onReload, compact = false }) {
  const [url, setUrl] = useState(config?.targetUrl ?? '');
  const [targets, setTargets] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const selectId = useId();
  const selectRef = useRef(null);

  useEffect(() => {
    if (config?.targetUrl) setUrl(config.targetUrl);
  }, [config?.targetUrl]);

  const submit = () => {
    const value = url.trim();
    if (value) onConnect(value.replace(/\/$/, ''));
  };

  const discover = async () => {
    setBusy(true);
    try {
      setTargets(await onDiscover());
    } finally {
      setBusy(false);
    }
  };

  // Escape closes the results rather than stranding the user in them.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') setTargets(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reloadButton = config?.targetUrl ? (
    <button className="btn ghost" onClick={onReload} title="Reload the preview">
      <RefreshCw size={15} aria-hidden="true" />
      Reload
    </button>
  ) : null;

  const modes = (
    <div className="modes" role="group" aria-label="Editing mode">
      <button
        className="btn"
        aria-pressed={mode === 'inspect'}
        onClick={() => onMode(mode === 'inspect' ? 'off' : 'inspect')}
        title="Select an element, then click it again to edit its text (I)"
      >
        <MousePointer2 size={15} aria-hidden="true" />
        Inspect
      </button>
    </div>
  );

  const sessionLink = (
    <a className="btn ghost" href="/api/session.json" target="_blank" rel="noreferrer" title="Open .uidit/session.json">
      <FileJson size={15} aria-hidden="true" />
      JSON
    </a>
  );

  // The drawer shows the strip: reload and the editing modes, which are what you
  // reach for mid-review. Connecting, discovering and switching targets live in
  // the Server section, where the full bar is rendered.
  if (compact) {
    return (
      <header className="bar compact">
        <span className="spacer" />
        {reloadButton}
        {modes}
        {sessionLink}
      </header>
    );
  }

  return (
    <header className="bar">
      <span className="brand">
        <b>uidit</b>
        <span>UI review</span>
      </span>

      <div className="field">
        <label htmlFor={inputId}>Target</label>
        <input
          id={inputId}
          className="target"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="http://localhost:3000"
          spellCheck="false"
          autoComplete="off"
          inputMode="url"
        />
      </div>

      <button className="btn primary" onClick={submit} disabled={!url.trim()}>
        Connect
      </button>

      <button className="btn" onClick={discover} disabled={busy} aria-expanded={Boolean(targets)}>
        <Compass size={15} aria-hidden="true" />
        {busy ? 'Scanning' : 'Discover'}
      </button>

      {targets && (
        <div className="field">
          <label htmlFor={selectId}>Found</label>
          <select
            id={selectId}
            ref={selectRef}
            className="select"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setUrl(e.target.value);
              setTargets(null);
              onConnect(e.target.value);
            }}
          >
            <option value="">
              {targets.length ? `${targets.length} local server${targets.length === 1 ? '' : 's'}` : 'nothing found'}
            </option>
            {targets.map((t) => (
              <option key={t.url} value={t.url}>
                {t.title ? `${t.url} — ${t.title}` : t.url}
              </option>
            ))}
          </select>
        </div>
      )}

      <span className="spacer" />

      {reloadButton}

      {modes}

      {sessionLink}
    </header>
  );
}
