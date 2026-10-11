import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uiditDir, readSession, writeSession } from './store.js';

const id = () => randomUUID();
const safeId = (value) => /^[a-f0-9-]{36}$/i.test(value);
const screenshotRoot = (cwd, flowId) => path.join(uiditDir(cwd), 'flows', flowId);

export function createFlow(cwd, { name } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('flow name must be 1–120 characters');
  const session = readSession(cwd); const now = new Date().toISOString();
  const flow = { id: id(), name: name.trim(), status: 'recording', createdAt: now, updatedAt: now, steps: [], logs: [] };
  session.flows.push(flow); writeSession(cwd, session); return flow;
}

export function addFlowStep(cwd, flowId, input = {}) {
  if (!safeId(flowId)) throw new Error('invalid flow id');
  if (!['click', 'input', 'submit', 'navigation', 'checkpoint', 'assertion'].includes(input.type)) throw new Error('unsupported flow step type');
  if (input.type === 'assertion') {
    if (!['assertVisible','assertText','assertEnabled','assertUrl'].includes(input.action)) throw new Error('unsupported flow assertion');
    if (input.action !== 'assertUrl' && (typeof input.selector !== 'string' || !input.selector.trim() || input.selector.length > 2000)) throw new Error('flow assertion requires a bounded selector');
    if (typeof input.value !== 'string' || input.value.length > 1000) throw new Error('flow assertion value must be a string under 1000 characters');
  }
  const session = readSession(cwd); const flow = session.flows.find((item) => item.id === flowId);
  if (!flow || flow.status !== 'recording') throw new Error('flow is not recording');
  if (flow.steps.length >= 300) throw new Error('flow step limit reached');
  const stepId = id(); const now = new Date().toISOString();
  const step = { id: stepId, type: input.type, selector: typeof input.selector === 'string' ? input.selector.slice(0, 2000) : null, label: typeof input.label === 'string' ? input.label.slice(0, 240) : '', action: typeof input.action === 'string' ? input.action.slice(0, 40) : input.type, ...(typeof input.value === 'string' && !input.sensitive ? { value: input.value.slice(0, 2000) } : {}), sensitive: input.sensitive === true, page: typeof input.page === 'string' ? input.page.slice(0, 2000) : null, createdAt: now, screenshotUrl: null, errors: [] };
  let screenshotPath = null;
  if (typeof input.screenshot === 'string') {
    const match = input.screenshot.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[2].length > 3_400_000) throw new Error('invalid or oversized flow screenshot');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 2_500_000) throw new Error('flow screenshot exceeds 2.5 MiB');
    const directory = screenshotRoot(cwd, flowId); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    screenshotPath = path.join(directory, `${stepId}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`);
    fs.writeFileSync(screenshotPath, bytes, { mode: 0o600 });
    step.screenshotUrl = `/api/flows/${flowId}/steps/${stepId}/screenshot`;
    step.screenshotMime = match[1] === 'png' ? 'image/png' : 'image/jpeg';
  }
  flow.steps.push(step); flow.updatedAt = now; writeSession(cwd, session);
  return { flow, step, screenshotPath };
}

export function addFlowLog(cwd, flowId, input = {}) {
  if (!safeId(flowId)) throw new Error('invalid flow id');
  const session = readSession(cwd); const flow = session.flows.find((item) => item.id === flowId);
  if (!flow || flow.status !== 'recording') throw new Error('flow is not recording');
  const kind = ['console', 'network', 'page'].includes(input.kind) ? input.kind : 'page';
  const entry = { id: id(), kind, message: String(input.message ?? '').slice(0, 1000), url: typeof input.url === 'string' ? input.url.slice(0, 2000) : null, at: new Date().toISOString() };
  flow.logs.push(entry); flow.logs = flow.logs.slice(-200); flow.updatedAt = entry.at; writeSession(cwd, session); return { flow, entry };
}

export function updateFlow(cwd, flowId, patch = {}) {
  if (!safeId(flowId)) throw new Error('invalid flow id');
  const session = readSession(cwd); const flow = session.flows.find((item) => item.id === flowId);
  if (!flow) return null;
  if (patch.status !== undefined && !['recording', 'recorded'].includes(patch.status)) throw new Error('flow status must be recording or recorded');
  if (patch.status) flow.status = patch.status;
  flow.updatedAt = new Date().toISOString(); writeSession(cwd, session); return flow;
}

export function readFlowScreenshot(cwd, flowId, stepId) {
  if (!safeId(flowId) || !safeId(stepId)) return null;
  const session = readSession(cwd); const flow = session.flows.find((item) => item.id === flowId);
  const step = flow?.steps.find((item) => item.id === stepId);
  if (!step?.screenshotUrl) return null;
  const file = path.resolve(screenshotRoot(cwd, flowId), `${stepId}.${step.screenshotMime === 'image/png' ? 'png' : 'jpg'}`);
  if (!file.startsWith(`${path.resolve(screenshotRoot(cwd, flowId))}${path.sep}`) || !fs.existsSync(file)) return null;
  return { file, mime: step.screenshotMime ?? 'image/jpeg' };
}
