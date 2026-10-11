import { randomUUID } from 'node:crypto';
import { readSession, writeSession } from './store.js';

const STATES = new Set(['open', 'acknowledged', 'in_progress', 'implemented', 'verified', 'accepted', 'blocked', 'rejected', 'reopened', 'cancelled']);
const VERIFIED_EVIDENCE = new Set(['test', 'screenshot', 'visual-diff', 'audit', 'diagnostic', 'manual']);
const TRANSITIONS = {
  open: new Set(['acknowledged', 'in_progress', 'blocked', 'cancelled']),
  acknowledged: new Set(['in_progress', 'blocked', 'cancelled', 'reopened']),
  in_progress: new Set(['implemented', 'blocked', 'cancelled', 'reopened']),
  implemented: new Set(['verified', 'in_progress', 'blocked', 'reopened']),
  verified: new Set(['accepted', 'rejected', 'reopened']),
  accepted: new Set(['reopened']),
  blocked: new Set(['in_progress', 'cancelled', 'reopened']),
  rejected: new Set(['reopened', 'cancelled']),
  reopened: new Set(['acknowledged', 'in_progress', 'blocked', 'cancelled']),
  cancelled: new Set(['reopened']),
};
const id = (prefix) => `${prefix}-${randomUUID()}`;

export function createTask(cwd, { title, commentIds = [], editIds = [], actor = 'reviewer' } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('task title must be 1–200 characters');
  if (!Array.isArray(commentIds) || commentIds.length > 100 || !Array.isArray(editIds) || editIds.length > 100) throw new Error('task links are invalid');
  const session = readSession(cwd);
  for (const commentId of commentIds) if (!session.comments.some((comment) => comment.id === commentId)) throw new Error(`unknown comment: ${commentId}`);
  for (const editId of editIds) if (!session.edits.some((edit) => edit.id === editId)) throw new Error(`unknown preview edit: ${editId}`);
  const now = new Date().toISOString();
  const task = { id: id('task'), title: title.trim(), commentIds: [...new Set(commentIds)], editIds: [...new Set(editIds)], status: 'open', owner: null, revision: 1, createdAt: now, updatedAt: now, actor: String(actor).slice(0, 80), events: [{ id: id('evt'), type: 'created', actor: String(actor).slice(0, 80), at: now, detail: 'Task created' }], evidenceIds: [], changedFiles: [], commit: null };
  session.tasks.push(task); writeSession(cwd, session); return task;
}

export function updateTask(cwd, taskId, patch, { expectedRevision, actor = 'agent', reviewer = false } = {}) {
  const session = readSession(cwd); const task = session.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  if (expectedRevision != null && task.revision !== expectedRevision) throw new Error('task revision changed; refresh the task and retry');
  if (patch.status !== undefined && !STATES.has(patch.status)) throw new Error('unsupported task state');
  if (patch.status !== undefined && patch.status !== task.status && !TRANSITIONS[task.status]?.has(patch.status)) throw new Error(`invalid task transition: ${task.status} → ${patch.status}`);
  if (patch.status === 'accepted' && !reviewer) throw new Error('only a reviewer can accept a task');
  if (patch.status === 'rejected' && !reviewer) throw new Error('only a reviewer can reject a task');
  if (patch.status === 'accepted' && task.status !== 'verified') throw new Error('only a verified task can be accepted');
  if (patch.status === 'verified' && !task.evidenceIds.some((evidenceId) => session.evidence.some((item) => item.id === evidenceId && VERIFIED_EVIDENCE.has(item.type) && item.result === 'passed'))) throw new Error('attach passing verification evidence before marking a task verified');
  if (patch.owner !== undefined && task.owner && patch.owner && task.owner !== patch.owner) throw new Error(`task is already claimed by ${task.owner}`);
  if (patch.owner !== undefined && patch.owner !== null && (typeof patch.owner !== 'string' || patch.owner.length > 120)) throw new Error('task owner must be a short agent identity or null');
  if (patch.changedFiles !== undefined && (!Array.isArray(patch.changedFiles) || patch.changedFiles.length > 100 || patch.changedFiles.some((file) => typeof file !== 'string' || file.length > 500 || file.startsWith('/') || /^[a-z]:[\\/]/i.test(file) || file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')))) throw new Error('changedFiles must be normalized project-relative paths');
  if (patch.commit !== undefined && patch.commit !== null && (typeof patch.commit !== 'string' || !/^(?:[0-9a-f]{7,40}|https?:\/\/[^\s]{1,500})$/i.test(patch.commit))) throw new Error('commit must be a Git SHA or URL');
  const oldStatus = task.status; const now = new Date().toISOString();
  for (const key of ['status', 'owner', 'changedFiles', 'commit']) if (patch[key] !== undefined) task[key] = patch[key];
  task.revision += 1; task.updatedAt = now;
  const type = patch.status && patch.status !== oldStatus ? `status:${patch.status}` : patch.owner !== undefined ? patch.owner ? 'claimed' : 'released' : 'progress';
  task.events.push({ id: id('evt'), type, actor: String(actor).slice(0, 80), at: now, detail: typeof patch.detail === 'string' ? patch.detail.slice(0, 1000) : '' });
  task.events = task.events.slice(-500);
  writeSession(cwd, session); return task;
}

export function addEvidence(cwd, taskId, evidence, { actor = 'agent' } = {}) {
  const session = readSession(cwd); const task = session.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  const type = String(evidence?.type ?? '');
  if (!['test', 'screenshot', 'visual-diff', 'audit', 'diagnostic', 'manual', 'source'].includes(type)) throw new Error('unsupported evidence type');
  const result = String(evidence?.result ?? '');
  if (!['passed', 'failed', 'review_required', 'not_run', 'unsupported', 'timeout', 'note'].includes(result)) throw new Error('unsupported evidence result');
  let metadata = {};
  if (evidence.metadata && typeof evidence.metadata === 'object') {
    const serialized = JSON.stringify(evidence.metadata);
    if (!serialized || serialized.length > 5000) throw new Error('evidence metadata must be valid JSON under 5 KB');
    metadata = JSON.parse(serialized);
  }
  const record = { id: id('ev'), taskId, type, result, actor: String(actor).slice(0, 80), summary: String(evidence.summary ?? '').slice(0, 1000), reference: typeof evidence.reference === 'string' ? evidence.reference.slice(0, 1000) : null, metadata, at: new Date().toISOString() };
  session.evidence.push(record); task.evidenceIds.push(record.id); task.revision += 1; task.updatedAt = record.at;
  task.events.push({ id: id('evt'), type: 'evidence', actor: record.actor, at: record.at, detail: `${type}: ${result}` });
  writeSession(cwd, session); return record;
}

export function createProposal(cwd, proposal = {}, { actor = 'agent' } = {}) {
  const session = readSession(cwd);
  if (typeof proposal.elementId !== 'string' || !session.elements.some((element) => element.id === proposal.elementId)) throw new Error('proposal target must be a tagged element');
  const operation = proposal.operation;
  if (!['style', 'text', 'class', 'attribute'].includes(operation)) throw new Error('unsupported proposal operation');
  const allowed = new Set(['padding', 'margin', 'gap', 'display', 'align-items', 'justify-content', 'grid-template-columns', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'border', 'border-radius', 'box-shadow', 'opacity', 'width', 'max-width', 'min-height', 'text-align']);
  const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
  if (!changes.length || changes.length > 12) throw new Error('proposal must contain 1–12 changes');
  const normalized = changes.map((item) => {
    if (operation === 'style' && (!allowed.has(item.property) || typeof item.value !== 'string' || item.value.length > 160 || /[<>]|url\s*\(|expression\s*\(/i.test(item.value))) throw new Error('proposal style is not allowed');
    if (operation === 'text' && (typeof item.value !== 'string' || item.value.length > 500)) throw new Error('proposal text must be under 500 characters');
    if (operation === 'class' && (typeof item.value !== 'string' || !/^[\w-]{1,80}$/.test(item.value))) throw new Error('proposal class is invalid');
    if (operation === 'attribute' && (!['aria-label', 'title', 'alt', 'role'].includes(item.property) || typeof item.value !== 'string' || item.value.length > 200)) throw new Error('proposal attribute is not allowed');
    return { property: String(item.property ?? '').slice(0, 80), before: item.before == null ? null : String(item.before).slice(0, 500), value: String(item.value).slice(0, 500) };
  });
  const now = new Date().toISOString();
  const record = { id: id('proposal'), elementId: proposal.elementId, operation, title: String(proposal.title ?? 'Visual proposal').slice(0, 200), changes: normalized, status: 'proposed', sourceStatus: 'not_implemented', actor: String(actor).slice(0, 80), createdAt: now, updatedAt: now, events: [{ type: 'created', actor: String(actor).slice(0, 80), at: now }] };
  session.proposals.push(record); writeSession(cwd, session); return record;
}

export function updateProposal(cwd, proposalId, status, { actor = 'reviewer' } = {}) {
  if (!['proposed', 'previewed', 'accepted', 'rejected', 'implemented', 'reverted'].includes(status)) throw new Error('unsupported proposal state');
  const session = readSession(cwd); const proposal = session.proposals.find((item) => item.id === proposalId);
  if (!proposal) return null;
  const now = new Date().toISOString(); proposal.status = status; proposal.updatedAt = now;
  if (status === 'implemented') proposal.sourceStatus = 'implemented';
  proposal.events.push({ type: status, actor: String(actor).slice(0, 80), at: now }); writeSession(cwd, session); return proposal;
}
