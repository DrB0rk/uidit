import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uiditDir, readSession, writeSession } from './store.js';

const HEARTBEAT_MS = 5_000;
const LEASE_MS = 15_000;
const READY_WAIT_MS = 5_000;
const QUEUED_WAIT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const RECENT_LIMIT = 25;
const ACTION_TYPES = new Set(['click', 'fill', 'focus', 'hover', 'scroll', 'keypress', 'navigate', 'screenshot', 'share-page-view']);
const CONTROL_TYPES = new Set(['click', 'fill', 'focus', 'hover', 'scroll', 'keypress', 'navigate']);
const ERROR_MESSAGES = { inspection_disabled: 'Live browser inspection is disabled.', control_disabled: 'Browser control is disabled.', executor_unavailable: 'No ready browser executor is available.', executor_disconnected: 'The browser executor disconnected.', sensitive_target: 'The requested element cannot be controlled.', invalid_navigation: 'The requested navigation is invalid.', target_missing: 'The requested element is no longer available.', action_timeout: 'The browser action timed out.', screenshot_timeout: 'The screenshot timed out.', navigation_timeout: 'The navigation did not complete in time.', action_failed: 'The browser action failed.', server_stopped: 'The UIDIT server stopped.' };

function token() { return crypto.randomBytes(32).toString('hex'); }
function fixedError(code) { return { code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.action_failed }; }
function now() { return new Date().toISOString(); }
function targetFor(context, selector) {
  const node = selector && context?.nodes?.find((item) => item.selector === selector);
  if (!node) return null;
  const tag = String(node.tag || 'element').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'element';
  const role = typeof node.role === 'string' && /^[a-z0-9 -]{1,80}$/i.test(node.role) ? node.role.toLowerCase() : null;
  return { tag, role };
}
function normalizedPath(value, base) {
  try { const url = new URL(value, base); return `${url.pathname}${url.search}`; } catch { return null; }
}
function isLocalNavigation(value, base) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  try { return new URL(value, base).origin === new URL(base).origin; } catch { return false; }
}

/** Authoritative in-memory browser action queue. Raw commands are only sent to a leased SSE response. */
export function createHub({ cwd = process.cwd(), clock = globalThis, config = null } = {}) {
  const clients = new Map(); const listeners = new Set(); const queue = []; const actions = new Map(); const internalWaiters = new Map(); const internalQueue = []; const recent = []; const ready = new Map();
  let lease = null; let active = null; let internalActive = null; let watcher = null; let timer = null; let selection = null; let browserContext = null; let browserDiagnostics = []; let lastRevision = readSession(cwd).revision ?? 0;
  const getConfig = () => config ? config() : readConfigSafe(cwd);
  const setTimer = clock.setTimeout.bind(clock); const clearTimer = clock.clearTimeout.bind(clock);
  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const push = (event, data) => { for (const client of clients.values()) write(client.res, event, data); };
  const emit = (type, data) => { for (const listener of listeners) listener(type, data); };
  const activity = (record) => ({ type: record.type, target: record.target, state: record.state, queuedAt: record.queuedAt, ...(record.runningAt ? { runningAt: record.runningAt } : {}), ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}), ...(record.error ? { error: record.error } : {}) });
  // The queue head is the visible active activity while it waits for a ready executor.
  // This makes accepted work observable from its required queued transition onward.
  const snapshot = () => ({ active: active ? activity(active) : queue[0] ? activity(queue[0]) : null, recent: recent.map(activity) });
  const broadcastActivity = () => { const data = snapshot(); push('agent-browser-activity', data); emit('agent-browser-activity', data); };
  const broadcastSession = () => { const data = readSession(cwd); push('session', data); emit('session', data); };
  const broadcastConfig = () => { const data = { config: getConfig() }; push('config', data); emit('config', data); };

  function readConfigSafe(dir) { try { const file = path.join(uiditDir(dir), 'config.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; } }
  function isInspectionAllowed() { return Boolean(getConfig()?.ui?.allowBrowserInspection); }
  function isControlAllowed() { return Boolean(getConfig()?.mcp?.allowBrowserControl); }
  function privateSend(clientId, event, data) { const client = clients.get(clientId); if (client) write(client.res, event, data); }
  function clearLeaseTimer() { if (lease?.timer) clearTimer(lease.timer); }
  function scheduleLeaseExpiry() { clearLeaseTimer(); if (lease) lease.timer = setTimer(() => loseLease('executor_disconnected'), Math.max(1, lease.expiresAt - Date.now())); }
  function terminal(record, state, code = null, result = null) {
    if (!record || ['completed', 'failed', 'timed_out'].includes(record.state)) return false;
    if (record.timer) clearTimer(record.timer); if (record.readinessTimer) clearTimer(record.readinessTimer); record.state = state; record.finishedAt = now(); record.error = code ? fixedError(code) : null;
    if (active?.id === record.id) active = null;
    const queued = queue.indexOf(record); if (queued >= 0) queue.splice(queued, 1);
    actions.delete(record.id); recent.unshift(record); recent.splice(RECENT_LIMIT);
    if (code) privateSend(record.clientId, 'browser-executor-cancel', { actionId: record.id, generation: record.generation, code });
    privateSend(record.clientId, 'browser-executor-finished', { actionId: record.id, generation: record.generation, bridgeNonce: record.bridgeNonce, state, ...(code ? { code } : {}) });
    if (state === 'completed') record.resolve(result ?? { result: {} }); else record.reject(Object.assign(new Error(record.error.message), { code: record.error.code }));
    broadcastActivity(); dispatch(); return true;
  }
  function failAll(predicate, code) { for (const record of [...queue, active].filter(Boolean)) if (predicate(record)) terminal(record, 'failed', code); }
  function permissionsFor(record) { return isInspectionAllowed() && (!CONTROL_TYPES.has(record.type) || isControlAllowed()); }
  // The overlay may report either the proxy document origin or the configured local
  // target origin while a navigation swaps documents. Both are configured loopback
  // origins; no arbitrary origin can acquire an executor lease.
  function expectedPreviewOrigins() {
    const origins = new Set([`http://127.0.0.1:${Number(getConfig()?.previewPort) || 7717}`]);
    try { origins.add(new URL(getConfig()?.targetUrl).origin); } catch {}
    return origins;
  }
  function promote() {
    if (lease || !ready.size) return false;
    const next = [...ready.values()].sort((a, b) => a.at - b.at)[0]; if (!next || !clients.has(next.clientId)) return false;
    const generation = (next.generation ?? 0) + 1;
    lease = { clientId: next.clientId, bridgeNonce: next.bridgeNonce, token: token(), generation, expiresAt: Date.now() + LEASE_MS, timer: null };
    next.generation = generation; ready.delete(next.clientId); scheduleLeaseExpiry();
    // A standby has no HTTP request in flight when it is promoted. Give it the
    // same lease credentials through its private SSE stream so it can take over
    // subsequent work without polling or re-registering.
    privateSend(next.clientId, 'browser-executor-leased', { leaseToken: lease.token, generation: lease.generation, expiresAt: new Date(lease.expiresAt).toISOString(), heartbeatMs: HEARTBEAT_MS, bridgeNonce: lease.bridgeNonce });
    return true;
  }
  function clearInternalForLease(code) { if (!internalActive) return; const entry = internalWaiters.get(internalActive); internalWaiters.delete(internalActive); internalActive = null; if (entry) { clearTimer(entry.timer); entry.reject(Object.assign(new Error(ERROR_MESSAGES[code]), { code })); } }
  function loseLease(code) { if (!lease) return; const previous = lease; clearTimer(previous.timer); lease = null; clearInternalForLease(code); if (active) terminal(active, 'failed', code); promote(); dispatch(); }
  function reconcilePermissions() { failAll(() => !isInspectionAllowed(), 'inspection_disabled'); failAll((record) => CONTROL_TYPES.has(record.type) && !isControlAllowed(), 'control_disabled'); }
  function dispatch() {
    reconcilePermissions(); if (internalActive) return; if (internalQueue.length && !queue.length) return dispatchInternal(); if (active || !queue.length) return; if (!lease && !promote()) return;
    const record = queue[0]; if (!permissionsFor(record)) return terminal(record, 'failed', CONTROL_TYPES.has(record.type) ? 'control_disabled' : 'inspection_disabled');
    active = record; if (record.readinessTimer) { clearTimer(record.readinessTimer); record.readinessTimer = null; } record.clientId = lease.clientId; record.generation = lease.generation; record.bridgeNonce = lease.bridgeNonce;
    privateSend(lease.clientId, 'browser-executor-command', { actionId: record.id, generation: record.generation, bridgeNonce: record.bridgeNonce, command: record.command });
  }
  function dispatchInternal() {
    if (active || internalActive || queue.length || !internalQueue.length) return;
    if (!lease || !clients.has(lease.clientId)) return;
    const entry = internalQueue.shift();
    internalActive = entry.id;
    internalWaiters.set(entry.id, entry);
    // Legacy capture is intentionally outside agent activity. It carries only a
    // type and remains available for collaboration/reviewer evidence workflows.
    privateSend(lease.clientId, 'browser-action', { id: entry.id, action: { type: entry.type } });
  }
  function assertLease(proof, { actionId = null } = {}) {
    if (!lease) return { status: 404, code: 'executor_not_found', message: 'No browser executor is available.' };
    if (proof.clientId !== lease.clientId || proof.leaseToken !== lease.token || proof.bridgeNonce !== lease.bridgeNonce) return { status: 403, code: 'executor_mismatch', message: 'This dashboard does not own the browser executor lease.' };
    if (Date.now() >= lease.expiresAt) return { status: 410, code: 'executor_lease_expired', message: 'The browser executor lease expired.' };
    if (Number(proof.generation) !== lease.generation) return { status: 409, code: 'executor_generation_stale', message: 'The browser executor generation is stale.' };
    const record = actionId && actions.get(actionId); if (actionId && !record) return { status: 404, code: 'action_not_found', message: 'The browser action was not found.' };
    if (record && (record.clientId !== lease.clientId || record.generation !== lease.generation)) return { status: 409, code: 'action_state_conflict', message: 'The browser action is no longer active.' };
    return { record };
  }
  function finishResult(record, body) {
    const code = body.outcome === 'ok' ? null : (['target_missing', 'sensitive_target', 'action_failed'].includes(body.errorCode) ? body.errorCode : 'action_failed');
    if (code) return terminal(record, 'failed', code);
    let result = { result: {} };
    if (record.type === 'screenshot') {
      const match = String(body.screenshot || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/); if (!match || match[1].length > 3_400_000) return terminal(record, 'failed', 'action_failed');
      const bytes = Buffer.from(match[1], 'base64'); if (bytes.length > 2_500_000) return terminal(record, 'failed', 'action_failed');
      const directory = path.join(uiditDir(cwd), 'artifacts'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const filename = `browser-${crypto.randomUUID()}.jpg`; fs.writeFileSync(path.join(directory, filename), bytes, { mode: 0o600 }); result = { result: { path: `.uidit/artifacts/${filename}`, mimeType: 'image/jpeg', bytes: bytes.length } };
    }
    return terminal(record, 'completed', null, result);
  }
  function proofResponse(proof) { return { status: proof.status, body: { error: { code: proof.code, message: proof.message } } }; }

  return {
    add(res) { const clientId = token(); clients.set(clientId, { res, clientId }); res.write('retry: 1000\n\n'); write(res, 'executor-client', { protocol: 1, clientId }); write(res, 'session', readSession(cwd)); write(res, 'agent-browser-activity', snapshot()); return () => { const ownedLease = lease?.clientId === clientId; const ownedAction = active?.clientId === clientId; clients.delete(clientId); ready.delete(clientId); if (ownedLease) loseLease('executor_disconnected'); else if (ownedAction) terminal(active, 'failed', 'executor_disconnected'); }; },
    executorReady(body) { if (!body || typeof body.clientId !== 'string' || typeof body.bridgeNonce !== 'string' || body.bridgeNonce.length < 32 || !clients.has(body.clientId)) return { status: 404, body: { error: { code: 'executor_not_found', message: 'The browser executor was not found.' } } }; if (!expectedPreviewOrigins().has(body.previewOrigin)) return { status: 403, body: { error: { code: 'executor_mismatch', message: 'This dashboard does not own the browser executor lease.' } } }; if (lease?.clientId === body.clientId) return { status: 200, body: { status: 'leased', leaseToken: lease.token, generation: lease.generation, expiresAt: new Date(lease.expiresAt).toISOString(), heartbeatMs: HEARTBEAT_MS } }; ready.set(body.clientId, { clientId: body.clientId, bridgeNonce: body.bridgeNonce, at: Date.now(), generation: 0 }); promote(); dispatch(); return lease?.clientId === body.clientId ? { status: 200, body: { status: 'leased', leaseToken: lease.token, generation: lease.generation, expiresAt: new Date(lease.expiresAt).toISOString(), heartbeatMs: HEARTBEAT_MS } } : { status: 202, body: { status: 'standby', retryAfterMs: HEARTBEAT_MS } }; },
    executorRenew(body) { const proof = assertLease(body); if (proof.status) return proofResponse(proof); lease.expiresAt = Date.now() + LEASE_MS; scheduleLeaseExpiry(); return { status: 200, body: { status: 'leased', expiresAt: new Date(lease.expiresAt).toISOString() } }; },
    executorRelease(body) { const proof = assertLease(body); if (proof.status) return proofResponse(proof); const old = lease; clearTimer(old.timer); lease = null; clearInternalForLease('executor_disconnected'); if (active) terminal(active, 'failed', 'executor_disconnected'); ready.delete(old.clientId); promote(); dispatch(); return { status: 200, body: { status: 'released' } }; },
    prepared(actionId, body) { const proof = assertLease(body, { actionId }); if (proof.status) return proofResponse(proof); const record = proof.record; if (record !== active || record.state !== 'queued') return { status: 409, body: { error: { code: 'action_state_conflict', message: 'The browser action is no longer active.' } } }; record.prepareToken = token(); return { status: 200, body: { status: 'prepared', prepareToken: record.prepareToken, expiresAt: new Date(Date.now() + CONTROL_TIMEOUT_MS).toISOString() } }; },
    execute(actionId, body) { const proof = assertLease(body, { actionId }); if (proof.status) return proofResponse(proof); const record = proof.record; if (record !== active || record.state !== 'queued' || body.prepareToken !== record.prepareToken || !permissionsFor(record)) return { status: 409, body: { error: { code: 'action_state_conflict', message: 'The browser action is no longer active.' } } }; if (record.timer) clearTimer(record.timer); record.state = 'running'; record.runningAt = now(); record.executeToken = token(); if (record.type === 'navigate') record.navigationToken = token(); record.timer = setTimer(() => terminal(record, 'timed_out', record.type === 'screenshot' ? 'screenshot_timeout' : record.type === 'navigate' ? 'navigation_timeout' : 'action_timeout'), record.type === 'screenshot' ? SCREENSHOT_TIMEOUT_MS : record.type === 'navigate' ? 20_000 : CONTROL_TIMEOUT_MS); broadcastActivity(); return { status: 200, body: { status: 'authorized', executeToken: record.executeToken, ...(record.navigationToken ? { navigationToken: record.navigationToken } : {}) } }; },
    result(actionId, body) { const proof = assertLease(body, { actionId }); if (proof.status) return proofResponse(proof); const record = proof.record; if (record !== active || record.state !== 'running' || body.executeToken !== record.executeToken) return { status: 409, body: { error: { code: 'action_state_conflict', message: 'The browser action is no longer active.' } } }; finishResult(record, body); return { status: 200, body: { status: 'accepted' } }; },
    cancelAck(_actionId, body) { const proof = assertLease(body); if (proof.status) return proofResponse(proof); return { status: 200, body: { status: 'cleared' } }; },
    navigationStarted(actionId, body) { const proof = assertLease(body, { actionId }); if (proof.status) return proofResponse(proof); const record = proof.record; if (record !== active || record.type !== 'navigate' || record.state !== 'running' || body.executeToken !== record.executeToken || body.navigationToken !== record.navigationToken) return { status: 409, body: { error: { code: 'action_state_conflict', message: 'The browser action is no longer active.' } } }; record.navigationStarted = true; return { status: 202, body: { status: 'awaiting-preview', deadline: new Date(Date.now() + 20_000).toISOString() } }; },
    navigationReady(actionId, body) { const record = actions.get(actionId); if (!record) return { status: 404, body: { error: { code: 'action_not_found', message: 'The browser action was not found.' } } }; if (!lease || body.clientId !== lease.clientId || body.leaseToken !== lease.token || Number(body.generation) !== lease.generation || body.previousBridgeNonce !== lease.bridgeNonce) return { status: 403, body: { error: { code: 'executor_mismatch', message: 'This dashboard does not own the browser executor lease.' } } }; if (record !== active || record.type !== 'navigate' || !record.navigationStarted || body.navigationToken !== record.navigationToken || normalizedPath(body.currentPath, getConfig()?.targetUrl) !== record.expectedPath || typeof body.newBridgeNonce !== 'string' || body.newBridgeNonce.length < 32) return { status: 409, body: { error: { code: 'action_state_conflict', message: 'The browser action is no longer active.' } } }; lease.bridgeNonce = body.newBridgeNonce; record.bridgeNonce = body.newBridgeNonce; terminal(record, 'completed', null, { result: {} }); return { status: 200, body: { status: 'accepted' } }; },
    reconcilePermissions,
    requestBrowserAction(action, timeout = CONTROL_TIMEOUT_MS) { if (!ACTION_TYPES.has(action?.type)) return Promise.reject(new Error(ERROR_MESSAGES.action_failed)); if (action.internal || action.type === 'share-page-view') return new Promise((resolve, reject) => { const id = crypto.randomUUID(); const entry = { id, resolve, reject, type: action.type, timer: setTimer(() => { internalWaiters.delete(id); const queued = internalQueue.findIndex((item) => item.id === id); if (queued >= 0) internalQueue.splice(queued, 1); if (internalActive === id) internalActive = null; reject(new Error(ERROR_MESSAGES.action_timeout)); dispatch(); }, Math.max(1_000, Math.min(30_000, timeout))) }; internalQueue.push(entry); dispatchInternal(); }); if (!isInspectionAllowed()) return Promise.reject(Object.assign(new Error(ERROR_MESSAGES.inspection_disabled), { code: 'inspection_disabled' })); if (CONTROL_TYPES.has(action.type) && !isControlAllowed()) return Promise.reject(Object.assign(new Error(ERROR_MESSAGES.control_disabled), { code: 'control_disabled' })); if (action.selector && !targetFor(browserContext, action.selector)) return Promise.reject(Object.assign(new Error('The requested element is not in the observed preview.'), { code: 'target_unobserved' })); if (action.type === 'navigate' && (!normalizedPath(action.path, getConfig()?.targetUrl) || !isLocalNavigation(action.path, getConfig()?.targetUrl))) return Promise.reject(Object.assign(new Error(ERROR_MESSAGES.invalid_navigation), { code: 'invalid_navigation' })); return new Promise((resolve, reject) => { const record = { id: crypto.randomUUID(), type: action.type, command: { type: action.type, ...(action.selector ? { selector: action.selector } : {}), ...(action.value !== undefined ? { value: action.value } : {}), ...(action.key ? { key: action.key } : {}), ...(action.path ? { path: action.path } : {}) }, target: targetFor(browserContext, action.selector), expectedPath: action.type === 'navigate' ? normalizedPath(action.path, getConfig()?.targetUrl) : null, state: 'queued', queuedAt: now(), resolve, reject, timer: null, readinessTimer: null }; record.timer = setTimer(() => terminal(record, 'timed_out', record.type === 'screenshot' ? 'screenshot_timeout' : record.type === 'navigate' ? 'navigation_timeout' : 'action_timeout'), Math.max(READY_WAIT_MS, Math.min(QUEUED_WAIT_MS, timeout))); record.readinessTimer = setTimer(() => { if (!lease && !ready.size) terminal(record, 'failed', 'executor_unavailable'); }, READY_WAIT_MS); actions.set(record.id, record); queue.push(record); broadcastActivity(); dispatch(); }); },
    requestInternalBrowserAction(action, timeout = CONTROL_TIMEOUT_MS) { return this.requestBrowserAction({ ...action, internal: true }, timeout); },
    resolveBrowserAction(id, result) { const waiter = internalWaiters.get(id); if (!waiter) return false; clearTimer(waiter.timer); internalWaiters.delete(id); if (internalActive === id) internalActive = null; result?.ok ? waiter.resolve(result) : waiter.reject(new Error(ERROR_MESSAGES.action_failed)); dispatch(); return true; }, isBrowserActionPending(id, type) { return internalWaiters.get(id)?.type === type; },
    notify() { clearTimer(timer); timer = setTimer(() => { lastRevision = readSession(cwd).revision ?? lastRevision; broadcastSession(); }, 60); }, notifyConfig() { broadcastConfig(); reconcilePermissions(); }, notifyDev(data) { push('dev', data); emit('dev', data); }, notifySelection(data) { selection = data; push('selection', data); emit('selection', data); }, notifyMcp(data) { push('mcp', data); emit('mcp', data); }, notifyCollaboration(data) { push('collaboration', data); emit('collaboration', data); }, notifyBrowserContext(data) { browserContext = data; push('browser-context', data); emit('browser-context', data); }, notifyBrowserDiagnostics(entries) { browserDiagnostics = [...browserDiagnostics, ...entries].slice(-250); push('browser-diagnostics', entries); emit('browser-diagnostics', entries); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    watch() { if (watcher) return; const dir = uiditDir(cwd); fs.mkdirSync(dir, { recursive: true }); watcher = fs.watch(dir, (_event, filename) => { if (filename && filename !== 'session.json' && filename !== 'config.json') return; clearTimer(timer); timer = setTimer(() => { if (filename === 'config.json') { broadcastConfig(); reconcilePermissions(); } else { try { let session = readSession(cwd); if (session.revision <= lastRevision) session = writeSession(cwd, session); lastRevision = session.revision; } catch {} broadcastSession(); } }, 80); }); },
    close() { clearTimer(timer); watcher?.close(); watcher = null; for (const record of [...queue, active].filter(Boolean)) terminal(record, 'failed', 'server_stopped'); for (const waiter of [...internalWaiters.values(), ...internalQueue]) { clearTimer(waiter.timer); waiter.reject(new Error(ERROR_MESSAGES.server_stopped)); } internalWaiters.clear(); internalQueue.length = 0; internalActive = null; clearLeaseTimer(); lease = null; for (const client of clients.values()) client.res.end(); clients.clear(); listeners.clear(); },
    get clientCount() { return clients.size; }, get selection() { return selection; }, get browserContext() { return browserContext; }, get browserDiagnostics() { return browserDiagnostics.slice(-250); },
  };
}
