import { useEffect, useState } from 'react';

export function ServerPanel({ config, dev, actions, onStatus }) {
  const [command, setCommand] = useState(JSON.stringify(config?.dev?.command ?? [], null, 2));
  const [cwd, setCwd] = useState(config?.dev?.cwd ?? '.');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCommand(JSON.stringify(config?.dev?.command ?? [], null, 2)); setCwd(config?.dev?.cwd ?? '.'); }, [config?.dev?.command, config?.dev?.cwd]);
  const run = async (action) => {
    setBusy(true);
    try { const next = await actions.devAction(action); onStatus(`Development server ${next.state}`, 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    try {
      const argv = JSON.parse(command);
      if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string' || !part.trim())) throw new Error('Use a non-empty JSON argv array, for example ["pnpm", "dev"]');
      await actions.setConfig({ dev: { command: argv, cwd: cwd || '.' } });
      onStatus('Development command saved', 'ok');
    } catch (error) { onStatus(error.message, 'error'); }
  };
  const running = ['ready', 'starting', 'attached'].includes(dev?.state);
  return <section className="runtime-panel" aria-label="Development server">
    <h2>Development server</h2>
    <p>UIDIT supervises only commands it starts. Attached servers are never stopped or restarted.</p>
    <div className="runtime-card">
      <div className="runtime-status"><span className={`status-dot ${dev?.state === 'ready' || dev?.state === 'attached' ? 'online' : ''}`} /><strong>{dev?.state ?? 'idle'}</strong><span className="spacer" /><span className="tag">{dev?.owned ? 'Managed process' : dev?.state === 'attached' ? 'Attached' : 'Local'}</span></div>
      {dev?.url && <div className="runtime-url">{dev.url}</div>}
      {dev?.command && <div className="runtime-command">{dev.command}</div>}
      {dev?.error && <div className="runtime-error">{dev.error}</div>}
      <div className="runtime-actions">
        {dev?.owned && running ? <button className="btn danger" disabled={busy} onClick={() => run('stop')}>Stop</button> : <button className="btn primary" disabled={busy || !config?.dev?.command?.length} onClick={() => run('start')}>Start</button>}
        {dev?.owned && <button className="btn" disabled={busy} onClick={() => run('restart')}>Restart</button>}
      </div>
    </div>
    <label className="runtime-label" htmlFor="uidit-dev-command">Command arguments (JSON)</label>
    <textarea id="uidit-dev-command" className="runtime-input command-input" value={command} onChange={(e) => setCommand(e.target.value)} spellCheck="false" />
    <label className="runtime-label" htmlFor="uidit-dev-cwd">Working directory, relative to project</label>
    <input id="uidit-dev-cwd" className="runtime-input" value={cwd} onChange={(e) => setCwd(e.target.value)} />
    <button className="btn" onClick={save}>Save command</button>
    <h3>Recent output</h3>
    <pre className="runtime-logs">{(dev?.logs ?? []).slice(-60).map((line) => `[${line.stream}] ${line.text}`).join('\n') || 'No process output yet.'}</pre>
  </section>;
}

export function AgentsPanel({ config, mcp, actions, onStatus }) {
  const setPermission = async (patch) => {
    try { await actions.setConfig({ mcp: patch }); onStatus('Agent permissions updated', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
  };
  const copy = async () => {
    const text = JSON.stringify({ mcpServers: { uidit: { command: 'uidit', args: ['mcp', 'stdio'] } } }, null, 2);
    try { await navigator.clipboard.writeText(text); onStatus('stdio MCP setup copied', 'ok'); }
    catch { onStatus(text, ''); }
  };
  const permissions = config?.mcp ?? {};
  return <section className="runtime-panel" aria-label="Agent connections">
    <h2>Local MCP server</h2>
    <p>Agents share the same review session and receive resource updates when it changes.</p>
    <div className="runtime-card"><div className="runtime-status"><span className={`status-dot ${mcp?.clientCount ? 'online' : ''}`} /><strong>{mcp?.clientCount ? `${mcp.clientCount} connected` : 'Ready for connections'}</strong></div><div className="runtime-url">{mcp?.url}</div><div className="runtime-muted">Streamable HTTP · authenticated with a project-local token</div><button className="btn" onClick={copy}>Copy stdio client config</button></div>
    <h3>Permissions</h3>
    <label className="permission-row"><span><strong>Enable MCP connections</strong><small>Expose this project's authenticated local MCP endpoint.</small></span><input type="checkbox" checked={permissions.enabled !== false} onChange={(e) => setPermission({ enabled: e.target.checked })} /></label>
    <label className="permission-row"><span><strong>Agent feedback writes</strong><small>Agents may add and update comments and preview-edit records.</small></span><input type="checkbox" checked={permissions.allowAgentWrites === true} onChange={(e) => setPermission({ allowAgentWrites: e.target.checked })} /></label>
    <label className="permission-row"><span><strong>Development process control</strong><small>Allow MCP clients to restart UIDIT-owned processes. Off by default.</small></span><input type="checkbox" checked={permissions.allowAgentServerControl === true} onChange={(e) => setPermission({ allowAgentServerControl: e.target.checked })} /></label>
    <h3>Connection instructions</h3><p>For clients with stdio support, run <code>uidit mcp stdio</code> from this project while UIDIT is running. HTTP clients use the endpoint above and the token printed by <code>uidit mcp info</code>.</p>
  </section>;
}

export function SettingsPanel({ config, actions, onStatus, onHide }) {
  const ui = config?.ui ?? {};
  const update = (patch) => actions.setConfig({ ui: patch }).then(() => onStatus('Settings saved', 'ok')).catch((error) => onStatus(error.message, 'error'));
  return <section className="runtime-panel" aria-label="UIDIT settings">
    <h2>Preferences</h2><p>Keep controls minimal while the application remains the main review surface.</p>
    <label className="runtime-label" htmlFor="uidit-position">Floating control position</label><select id="uidit-position" className="runtime-input" value={ui.position ?? 'bottom-right'} onChange={(e) => update({ position: e.target.value })}><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></select>
    <label className="permission-row"><span><strong>Inspection starts off</strong><small>Click capture activates only when you choose Inspect.</small></span><span className="tag">Always on</span></label>
    <button className="btn" onClick={onHide}>Hide UIDIT controls <span className="muted hint">(press U to restore)</span></button>
    <div className="runtime-card"><strong>Keyboard shortcuts</strong><p><kbd>I</kbd> inspect · <kbd>C</kbd> comment · <kbd>G</kbd> workspace · <kbd>Esc</kbd> close</p></div>
  </section>;
}
