import { useEffect, useState } from 'react';

export default function Toolbar({ config, onConnect, onDiscover, mode, onMode }) {
  const [url, setUrl] = useState(config?.targetUrl ?? '');
  const [targets, setTargets] = useState(null);

  useEffect(() => {
    if (config?.targetUrl) setUrl(config.targetUrl);
  }, [config?.targetUrl]);

  const submit = () => {
    const value = url.trim();
    if (value) onConnect(value.replace(/\/$/, ''));
  };

  const discover = async () => {
    const found = await onDiscover();
    setTargets(found);
    if (!found.length) setTargets([]);
  };

  return (
    <header className="bar">
      <span className="brand">uidit</span>
      <input
        className="target"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="http://localhost:3000"
        spellCheck="false"
      />
      <button className="btn primary" onClick={submit}>Connect</button>
      <button className="btn" onClick={discover}>Discover</button>
      {targets && targets.length > 0 && (
        <select
          className="targets"
          value=""
          onChange={(e) => e.target.value && (setUrl(e.target.value), submit())}
        >
          <option value="">found {targets.length}</option>
          {targets.map((t) => (
            <option key={t.url} value={t.url}>{t.url}{t.title ? ` — ${t.title}` : ''}</option>
          ))}
        </select>
      )}
      <span className="spacer" />
      <div className="modes" role="group" aria-label="Tool mode">
        <button className={`btn mode${mode === 'inspect' ? ' active' : ''}`} onClick={() => onMode('inspect')}>
          Inspect
        </button>
        <button className={`btn mode${mode === 'text' ? ' active' : ''}`} onClick={() => onMode('text')}>
          Text
        </button>
      </div>
      <a className="btn ghost" href="/api/session.json" target="_blank" rel="noreferrer" title="Raw .uidit/session.json">
        JSON
      </a>
    </header>
  );
}