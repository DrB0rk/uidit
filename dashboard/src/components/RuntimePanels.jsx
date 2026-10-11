import { useEffect, useState } from 'react';
import { CircleDot, Square, Play, Image as ImageIcon } from 'lucide-react';

export function FlowsPanel({ session, actions, onStatus, onRecording, onReplay, replayState }) {
  const [name, setName] = useState('');
  const [assertionSelector, setAssertionSelector] = useState('');
  const [assertionType, setAssertionType] = useState('assertVisible');
  const [assertionValue, setAssertionValue] = useState('');
  const [busy, setBusy] = useState(false);
  const active = session.flows?.find((flow) => flow.status === 'recording');
  const start = async (event) => {
    event.preventDefault(); setBusy(true);
    try { const result = await actions.createFlow(name.trim() || `Review flow ${new Date().toLocaleString()}`); setName(''); onRecording(result.flow.id); onStatus('Recording interaction flow', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!active) return;
    try { await actions.updateFlow(active.id, { status: 'recorded' }); onRecording(null); onStatus('Flow saved', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
  };
  const addAssertion = async (event) => {
    event.preventDefault();
    try {
      await actions.addFlowStep(active.id, { type: 'assertion', action: assertionType, selector: assertionSelector.trim(), value: assertionValue, label: `Assert ${assertionType.replace(/^assert/, '').toLowerCase()}` });
      setAssertionValue(''); onStatus('Assertion added to the flow', 'ok');
    } catch (error) { onStatus(error.message, 'error'); }
  };
  const exportFlow = async (flow) => {
    try {
      const response = await fetch('/api/state'); if (!response.ok) throw new Error('Could not read the saved flow');
      const state = await response.json(); const current = state.session.flows.find((item) => item.id === flow.id);
      if (!current) throw new Error('Flow no longer exists');
      const { exportFlowAsPlaywright } = await import('../../../src/server/flow-export.js');
      const code = exportFlowAsPlaywright(current); const blob = new Blob([code], { type: 'text/javascript' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${flow.name.replace(/[^a-z0-9-_]+/gi, '-').slice(0,80) || 'uidit-flow'}.spec.js`; link.click(); URL.revokeObjectURL(url); onStatus('Playwright test exported; recorded form values were omitted', 'ok');
    } catch (error) { onStatus(error.message, 'error'); }
  };
  return <section className="runtime-panel" aria-label="Interaction flows">
    <h2>Interaction flows</h2>
    <p>Record repeatable browser steps with page snapshots and console or network errors. Flow screenshots mask form fields; passwords, email, and phone values are never recorded.</p>
    {active ? <div className="runtime-card flow-recording"><div className="runtime-status"><CircleDot size={15} className="flow-record-dot"/><strong>Recording · {active.name}</strong><span className="spacer"/><span>{active.steps.length} steps</span></div><p>Interact with the page. Clicks, text entry, and form submissions are captured.</p><form className="flow-assertion-form" onSubmit={addAssertion}><strong>Add an assertion</strong><label className="runtime-label" htmlFor="uidit-assertion-type">Check</label><select id="uidit-assertion-type" className="runtime-input" value={assertionType} onChange={(event) => setAssertionType(event.target.value)}><option value="assertVisible">Element is visible</option><option value="assertEnabled">Element is enabled</option><option value="assertText">Element contains text</option><option value="assertUrl">Page is on route</option></select>{assertionType !== 'assertUrl' && <label className="runtime-label" htmlFor="uidit-assertion-selector">CSS selector<input id="uidit-assertion-selector" className="runtime-input" required value={assertionSelector} onChange={(event) => setAssertionSelector(event.target.value)} placeholder="#continue-button" /></label>}{['assertText','assertUrl'].includes(assertionType) && <label className="runtime-label" htmlFor="uidit-assertion-value">Expected {assertionType === 'assertUrl' ? 'path' : 'text'}<input id="uidit-assertion-value" className="runtime-input" required value={assertionValue} onChange={(event) => setAssertionValue(event.target.value)} placeholder={assertionType === 'assertUrl' ? '/checkout/complete' : 'Order confirmed'} /></label>}<button className="btn" type="submit">Add assertion</button></form><button className="btn danger" onClick={stop}><Square size={13}/> Stop and save</button></div> : <form className="runtime-card flow-create" onSubmit={start}><label className="runtime-label" htmlFor="uidit-flow-name">Flow name</label><div className="flow-name-row"><input id="uidit-flow-name" className="runtime-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Checkout on mobile"/><button className="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start recording'}</button></div><small>Starting a recording turns on page instrumentation until you stop it.</small></form>}
    <h3>Saved flows · {session.flows?.length ?? 0}</h3>
    <div className="flow-list">{[...(session.flows ?? [])].slice().reverse().map((flow) => <article className="runtime-card flow-card" key={flow.id}><div className="runtime-status"><strong>{flow.name}</strong><span className="spacer"/><span className={`tag ${flow.status === 'recorded' ? 'done' : ''}`}>{flow.status}</span></div><div className="runtime-muted">{flow.steps.length} steps · {flow.logs?.length ?? 0} browser errors · {new Date(flow.createdAt).toLocaleString()}</div>{flow.steps.map((step, index) => <div className="flow-step" key={step.id}><span>{index + 1}. {step.action}</span><code>{step.label || step.selector || step.page || step.type}</code>{step.sensitive && <small>Sensitive value omitted</small>}{step.screenshotUrl ? <a href={step.screenshotUrl} target="_blank" rel="noreferrer"><img loading="lazy" src={step.screenshotUrl} alt={`Screenshot after step ${index + 1}: ${step.label || step.action}`}/></a> : <span className="flow-no-screenshot"><ImageIcon size={13}/> Snapshot unavailable</span>}</div>)}{flow.logs?.length > 0 && <details className="flow-errors"><summary>{flow.logs.length} console/network errors</summary>{flow.logs.map((log) => <div key={log.id}><strong>{log.kind}</strong> {log.message}<small>{log.url}</small></div>)}</details>}<div className="flow-actions"><button className="btn" disabled={flow.status !== 'recorded' || Boolean(active) || replayState?.flowId === flow.id && replayState.running} onClick={() => onReplay(flow)}><Play size={13}/>{replayState?.flowId === flow.id && replayState.running ? 'Replaying…' : 'Replay flow'}</button><button className="btn" disabled={flow.status !== 'recorded'} onClick={() => exportFlow(flow)}>Export Playwright test</button></div>{replayState?.flowId === flow.id && !replayState.running && <div className={`flow-result ${replayState.failed ? 'error' : 'ok'}`}>{replayState.failed ? `${replayState.failed} step(s) failed` : `Passed ${replayState.passed} step(s)`}{replayState.messages?.length > 0 && <ul>{replayState.messages.map((message, index) => <li key={index}>{message}</li>)}</ul>}</div>}</article>)}</div>
    {(!session.flows || session.flows.length === 0) && <div className="empty-state">No saved flows. Record a path through your app to replay it after changes.</div>}
  </section>;
}

export function ServerPanel({ config, dev, actions, onStatus, onPreviewService, browserContext, browserDiagnostics = [] }) {
  const [command, setCommand] = useState(JSON.stringify(config?.dev?.command ?? [], null, 2));
  const [cwd, setCwd] = useState(config?.dev?.cwd ?? '.');
  const [busy, setBusy] = useState(false);
  const [servicesDraft, setServicesDraft] = useState('[]');
  const [servicesBusy, setServicesBusy] = useState(false);
  useEffect(() => { setCommand(JSON.stringify(config?.dev?.command ?? [], null, 2)); setCwd(config?.dev?.cwd ?? '.'); }, [config?.dev?.command, config?.dev?.cwd]);
  useEffect(() => { setServicesDraft(JSON.stringify(config?.services ?? [], null, 2)); }, [config?.services]);
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
  const saveServices = async () => {
    setServicesBusy(true);
    try { const value = JSON.parse(servicesDraft); if (!Array.isArray(value)) throw new Error('Workspace services must be a JSON array'); await actions.setConfig({ services: value }); onStatus('Workspace services saved', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setServicesBusy(false); }
  };
  const serviceAction = async (id, action) => {
    setServicesBusy(true);
    try { await actions.serviceAction(id, action); onStatus(`Service ${id} ${action === 'start' ? 'started' : 'stopped'}`, 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setServicesBusy(false); }
  };
  const serviceGroupAction = async (action) => {
    setServicesBusy(true);
    try { await actions.serviceGroupAction(action); onStatus(action === 'start-all' ? 'Workspace services started' : 'Workspace services stopped', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setServicesBusy(false); }
  };
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
    <h3>Workspace services</h3>
    <p>Run related services as separate processes. Dependencies start first. UIDIT only stops services it owns.</p>
    <div className="runtime-card workspace-services">
      <div className="runtime-actions"><button className="btn primary" disabled={servicesBusy || !dev?.services?.length} onClick={() => serviceGroupAction('start-all')}>Start all</button><button className="btn danger" disabled={servicesBusy || !dev?.services?.some((service) => service.owned)} onClick={() => serviceGroupAction('stop-all')}>Stop owned services</button></div>
      {(dev?.services ?? []).length ? <ul className="service-list">{dev.services.map((service) => <li key={service.id}><div><strong>{service.name}</strong><small>{service.command}</small>{service.url && <code>{service.url}</code>}{service.error && <span className="runtime-error">{service.error}</span>}</div><span className={`tag ${['ready','attached'].includes(service.state) ? 'done' : ''}`}>{service.state ?? 'idle'}{service.owned ? ' · owned' : ''}</span>{service.url && <button className="btn sm" disabled={!['ready','attached'].includes(service.state)} onClick={() => onPreviewService(service)} aria-label={`Preview ${service.name}`}>Preview</button>}<button className={`btn sm ${service.owned && service.state === 'ready' ? 'danger' : ''}`} disabled={servicesBusy || !service.command} onClick={() => serviceAction(service.id, service.owned && service.state === 'ready' ? 'stop' : 'start')}>{service.owned && service.state === 'ready' ? 'Stop' : 'Start'}</button><details><summary>Logs · {(service.logs ?? []).length}</summary><pre className="runtime-logs">{(service.logs ?? []).slice(-30).map((line) => `[${line.stream}] ${line.text}`).join('\n') || 'No service output yet.'}</pre></details></li>)}</ul> : <div className="empty-state">No workspace services configured.</div>}
      <details className="service-config"><summary>Configure services</summary><p className="runtime-muted">Use project-relative working directories and argv arrays (no shell). Example: <code>{'{"id":"api","command":["npm","run","dev"],"cwd":"apps/api","dependencies":[]}'}</code></p><label className="runtime-label" htmlFor="uidit-services-config">Services JSON</label><textarea id="uidit-services-config" className="runtime-input command-input" value={servicesDraft} onChange={(event) => setServicesDraft(event.target.value)} spellCheck="false" /><button className="btn" disabled={servicesBusy} onClick={saveServices}>{servicesBusy ? 'Saving…' : 'Save services'}</button></details>
    </div>
    <h3>Recent output</h3>
    <pre className="runtime-logs">{(dev?.logs ?? []).slice(-60).map((line) => `[${line.stream}] ${line.text}`).join('\n') || 'No process output yet.'}</pre>
    <h3>HMR checks</h3><div className="runtime-card hmr-results">{dev?.hmrVerification ? <><strong>{dev.hmrVerification.state ?? `${dev.hmrVerification.impactedTasks} task${dev.hmrVerification.impactedTasks === 1 ? '' : 's'} checked after file update`}</strong>{dev.hmrVerification.reason && <span>{dev.hmrVerification.reason}</span>}{dev.hmrVerification.changedFiles?.map((file) => <code key={file}>{file}</code>)}{dev.hmrVerification.results?.map((item) => <div key={item.taskId} className={`hmr-result ${item.status}`}><strong>{item.status.replaceAll('_', ' ')}</strong><span>{item.summary}</span></div>)}<small>Anchor checks confirm presence only; visual and interaction correctness still need review.</small></> : <span>Waiting for a source file change. Checks are limited to tasks with linked source paths and the currently observed route.</span>}</div>
    <h3>Browser diagnostics</h3><p>{browserContext ? `${browserContext.title || browserContext.url} · ${browserContext.viewport.width}×${browserContext.viewport.height}` : 'Enable live page inspection in Agents settings to collect browser diagnostics.'}</p>
    <div className="runtime-card browser-problems" aria-label="Browser problems">{browserDiagnostics.length ? browserDiagnostics.slice(-30).reverse().map((entry, index) => <div key={`${entry.at}:${index}`}><strong>{entry.kind}</strong><span>{entry.message}</span><small>{entry.url}</small></div>) : <span>No recent browser errors or failed requests.</span>}</div>
  </section>;
}

export function AgentsPanel({ config, mcp, collaboration, session, actions, onStatus }) {
  const [projectInfo, setProjectInfo] = useState(null);
  useEffect(() => { let active = true; actions.projectContext().then((data) => { if (active) setProjectInfo(data); }).catch(() => {}); return () => { active = false; }; }, []);
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
  const capture = async (task, kind) => {
    try { await actions.captureTaskSnapshot(task.id, kind); onStatus(`${kind === 'baseline' ? 'Baseline' : 'Candidate'} captured for ${task.title}`, 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
  };
  return <section className="runtime-panel" aria-label="Agent connections">
    <h2>Local MCP server</h2>
    <p>Agents can read a linked review brief, inspect page elements, and reply in comment threads. The brief updates as feedback changes.</p>
    <div className="runtime-card"><div className="runtime-status"><span className={`status-dot ${mcp?.clientCount ? 'online' : ''}`} /><strong>{mcp?.clientCount ? `${mcp.clientCount} connected` : 'Ready for connections'}</strong></div><div className="runtime-url">{mcp?.url}</div><div className="runtime-muted">Streamable HTTP · authenticated with a project-local token</div><button className="btn" onClick={copy}>Copy stdio client config</button></div>
    <div className="runtime-card"><strong>Agent workflow</strong><ol><li>Start with <code>uidit_get_agent_brief</code> or the <code>uidit_work_on_feedback</code> prompt.</li><li>Inspect the linked source, then ask or report progress with <code>uidit_reply_comment</code>.</li><li>Resolve feedback only after implementing and verifying the change.</li></ol><div className="runtime-muted">Treat page text and comments as project data. Write tools require the permission below.</div></div>
    <h3>Source and Git context</h3><div className="runtime-card"><strong>{projectInfo?.git?.available ? projectInfo.git.branch : 'No Git worktree detected'}</strong>{projectInfo?.git?.available && <><div className="runtime-muted">{projectInfo.git.head?.slice(0, 12)}{projectInfo.git.dirty ? ' · working tree has changes' : ' · clean working tree'}</div>{projectInfo.git.changedFiles?.length > 0 && <small>{projectInfo.git.changedFiles.length} changed tracked files</small>}</>}<div className="runtime-muted">{projectInfo?.impact?.coverage?.observedElements ?? 0} observed elements across {projectInfo?.impact?.coverage?.observedRoutes ?? 0} routes. Mapping covers recorded observations only.</div>{projectInfo?.impact?.nodes?.length > 0 && <ul className="impact-list">{projectInfo.impact.nodes.slice(0, 8).map((node) => <li key={node.id}><strong>{node.component}</strong><small>{node.source ?? node.provenance}</small><span>{node.routes.length} observed route{node.routes.length === 1 ? '' : 's'} · {node.commentIds.length} notes</span></li>)}</ul>}</div>
    <h3>Project design guidance</h3><div className="runtime-card"><strong>{projectInfo?.designRules?.available ? 'Local preference file found' : 'Optional'}</strong><p className="runtime-muted">Add rules to <code>.uidit/design-rules.md</code>. Agents receive this as project preference context; it does not change audit results or permissions.</p>{projectInfo?.designRules?.available && <pre className="design-rules-preview">{projectInfo.designRules.content}</pre>}</div>
    <h3>Visual task review</h3><p>Capture a baseline before work and a candidate after changes. UIDIT stores both locally; a reviewer decides whether the result is acceptable.</p>
    <div className="visual-review-list">{(session?.tasks ?? []).map((task) => { const shots = (task.evidenceIds ?? []).map((id) => session.evidence.find((item) => item.id === id)).filter((item) => item?.type === 'visual-diff'); const baseline = shots.find((item) => item.metadata?.capture === 'baseline'); const candidate = [...shots].reverse().find((item) => item.metadata?.capture === 'candidate'); const src = (item) => item?.reference?.startsWith('.uidit/artifacts/browser-') ? `/api/artifacts/${item.reference.split('/').at(-1)}` : null; const contextChanged = baseline && candidate && (JSON.stringify(baseline.metadata?.viewport) !== JSON.stringify(candidate.metadata?.viewport) || baseline.metadata?.url !== candidate.metadata?.url || baseline.metadata?.git?.head !== candidate.metadata?.git?.head); return <article className="runtime-card visual-review-card" key={task.id}><div className="runtime-status"><strong>{task.title}</strong><span className="spacer"/><span className="tag">{task.status.replaceAll('_', ' ')}</span></div><div className="visual-capture-actions"><button className="btn sm" disabled={!config?.ui?.allowBrowserInspection} onClick={() => capture(task, 'baseline')}>Capture baseline</button><button className="btn sm" disabled={!config?.ui?.allowBrowserInspection || !baseline} onClick={() => capture(task, 'candidate')}>Capture candidate</button></div>{contextChanged && <div className="runtime-muted">Capture context differs. Compare route, viewport, and Git revision before reviewing visual changes.</div>}{(baseline || candidate) && <div className="visual-captures">{[[baseline, 'Baseline'], [candidate, 'Candidate']].map(([item, label]) => <figure key={label}><figcaption>{label}{item ? ` · ${item.metadata?.viewport?.width ?? '?'}×${item.metadata?.viewport?.height ?? '?'} · ${item.metadata?.git?.head?.slice(0, 8) ?? 'no Git ref'}` : ' · not captured'}</figcaption>{src(item) ? <img src={src(item)} alt={`${label} preview for ${task.title}`} loading="lazy"/> : <div className="empty-state">{item ? 'Artifact unavailable' : 'Capture this view when ready'}</div>}</figure>)}</div>}</article>; })}{!session?.tasks?.length && <div className="empty-state">Create a task from a feedback note to start a visual review.</div>}</div>
    <h3>Team review</h3>
    {collaboration?.enabled ? <div className="runtime-card"><div className="runtime-status"><span className={`status-dot ${collaboration.connected ? 'online' : ''}`} /><strong>{collaboration.connected ? 'Relay connected' : 'Connecting to relay'}</strong></div><div className="runtime-muted">{collaboration.project} · {collaboration.participants?.length ?? 0} participant{collaboration.participants?.length === 1 ? '' : 's'} online</div>{collaboration.error && <div className="runtime-error">{collaboration.error}</div>}<label className="runtime-label" htmlFor="uidit-share-url">Invite link</label><input id="uidit-share-url" className="runtime-input" readOnly value={collaboration.inviteUrl ?? ''} /><button className="btn" disabled={!collaboration.inviteUrl} onClick={async () => { await navigator.clipboard.writeText(collaboration.inviteUrl); onStatus('Invite link copied', 'ok'); }}>Copy invite link</button><div className="runtime-members">{(collaboration.participants ?? []).map((person) => <span className="tag" key={person.memberId}>{person.name}{person.role === 'owner' ? ' · owner' : ''}</span>)}</div></div> : <div className="runtime-card collaboration-form"><p>Cloudflare Durable Objects keep the review room and its hibernatable WebSocket connection live. Create its invite from the <strong>Feedback</strong> sidebar whenever you are ready to share.</p><details><summary>Relay deployment</summary><ol><li>From the repo, run <code>cd cloudflare/relay && npx wrangler deploy</code>.</li><li>Set the Worker secret with <code>npx wrangler secret put ADMIN_SECRET</code>.</li></ol></details></div>}
    <h3>Permissions</h3>
    <label className="permission-row"><span><strong>Enable MCP connections</strong><small>Expose this project's authenticated local MCP endpoint.</small></span><input type="checkbox" checked={permissions.enabled !== false} onChange={(e) => setPermission({ enabled: e.target.checked })} /></label>
    <label className="permission-row"><span><strong>Agent feedback writes</strong><small>Agents may add and update comments and preview-edit records.</small></span><input type="checkbox" checked={permissions.allowAgentWrites === true} onChange={(e) => setPermission({ allowAgentWrites: e.target.checked })} /></label>
    <label className="permission-row"><span><strong>Development process control</strong><small>Allow MCP clients to restart UIDIT-owned processes. Off by default.</small></span><input type="checkbox" checked={permissions.allowAgentServerControl === true} onChange={(e) => setPermission({ allowAgentServerControl: e.target.checked })} /></label>
    <label className="permission-row"><span><strong>Live browser inspection</strong><small>Share a sanitized DOM snapshot and page errors with local agents. Off by default.</small></span><input type="checkbox" checked={config?.ui?.allowBrowserInspection === true} onChange={(e) => actions.setConfig({ ui: { allowBrowserInspection: e.target.checked } }).then(() => onStatus('Browser inspection permission updated', 'ok')).catch((error) => onStatus(error.message, 'error'))} /></label>
    <label className="permission-row"><span><strong>Agent browser control</strong><small>Let agents use a small set of actions in the shared preview. Requires live inspection.</small></span><input type="checkbox" checked={permissions.allowBrowserControl === true} disabled={config?.ui?.allowBrowserInspection !== true} onChange={(e) => setPermission({ allowBrowserControl: e.target.checked })} /></label>
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
