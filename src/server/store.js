import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { anchorFor, routeIdentity } from './identity.js';

export const UIDIT_DIR = '.uidit';

export function projectRoot(cwd = process.cwd()) {
  return path.resolve(cwd);
}

export function uiditDir(cwd = process.cwd()) {
  return path.join(projectRoot(cwd), UIDIT_DIR);
}

export function isInitialized(cwd = process.cwd()) {
  return fs.existsSync(path.join(uiditDir(cwd), 'config.json'));
}

const EMPTY = () => ({ version: 2, revision: 0, updatedAt: null, elements: [], comments: [], edits: [], flows: [], tasks: [], proposals: [], evidence: [] });

function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

const LOCK_STALE_MS = 10_000;

// Every mutation is read-modify-write on one JSON file. The overlay and an
// agent are separate processes, so two writers can read the same snapshot and
// the second write discards the first -- losing a comment the user made.
// `withSession` serialises them with an O_EXCL lockfile. It stays synchronous
// because every caller (server handlers, the CLI, the MCP bridge) is sync.
export function withSession(cwd, update) {
  const file = path.join(uiditDir(cwd), 'session.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const held = `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`;
  let heldLock = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    // Publish owner metadata and the lock in one step. Creating the lockfile
    // empty and writing into it leaves a window where a contender reads no
    // owner and treats the live lock as stale.
    const staged = `${file}.${process.pid}.${attempt}.tmp`;
    try {
      fs.writeFileSync(staged, held, { mode: 0o600 });
      fs.linkSync(staged, file);
      heldLock = true;
      break;
    } catch (error) {
      try { fs.unlinkSync(staged); } catch {}
      if (error.code !== 'EEXIST') throw error;
    }
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    // An unreadable lock is held, not stale: stealing it would resurrect the
    // race this lock exists to close.
    if (owner && Number.isFinite(owner.at) && Date.now() - owner.at > LOCK_STALE_MS) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    // Block briefly rather than spin the CPU; the holder is doing file I/O.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  if (!heldLock) throw new Error('Could not acquire the session lock; another UIDIT writer is active');
  try {
    return update();
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

export function init(cwd = process.cwd(), { force = false } = {}) {
  const dir = uiditDir(cwd);
  const configFile = path.join(dir, 'config.json');
  if (fs.existsSync(configFile) && !force) return { created: false, dir, config: readConfig(cwd) };
  fs.mkdirSync(dir, { recursive: true });
  const config = { ...defaultConfig(), createdAt: new Date().toISOString() };
  writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`);
  writeAtomic(path.join(dir, 'session.json'), `${JSON.stringify(EMPTY(), null, 2)}\n`);
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme) || force) fs.writeFileSync(readme, AGENT_README);
  const gitignore = path.join(projectRoot(cwd), '.gitignore');
  const ignored = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!/(^|\n)\.uidit\/(?:\n|$)/.test(ignored)) fs.appendFileSync(gitignore, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}.uidit/\n`);
  return { created: true, dir, config };
}

export function readConfig(cwd = process.cwd()) {
  const file = path.join(uiditDir(cwd), 'config.json');
  if (!fs.existsSync(file)) return null;
  return migrateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function defaultConfig() {
  return { version: 2, dashboardPort: 7718, controlPort: 7718, previewPort: 7717, targetUrl: null,
    services: [],
    dev: { command: null, cwd: '.', url: null, autoStart: true, restartOnCrash: false },
    ui: { position: 'bottom-left', defaultOpen: false, inspectionDefault: false, allowBrowserInspection: false },
    mcp: { enabled: true, allowAgentWrites: false, allowAgentServerControl: false, allowBrowserControl: false } };
}

export function migrateConfig(value = {}) {
  const base = defaultConfig();
  const controlPort = value.controlPort ?? value.dashboardPort ?? base.controlPort;
  return { ...base, ...value, version: 2, dashboardPort: controlPort, controlPort,
    previewPort: value.previewPort ?? base.previewPort, services: Array.isArray(value.services) ? value.services : [], dev: { ...base.dev, ...(value.dev ?? {}) },
    ui: { ...base.ui, ...(value.ui ?? {}) }, mcp: { ...base.mcp, ...(value.mcp ?? {}) } };
}

export function writeConfig(cwd, patch) {
  const current = migrateConfig(readConfig(cwd) ?? {});
  const config = migrateConfig({ ...current, ...patch,
    dev: { ...current.dev, ...(patch.dev ?? {}) }, ui: { ...current.ui, ...(patch.ui ?? {}) },
    mcp: { ...current.mcp, ...(patch.mcp ?? {}) } });
  writeAtomic(path.join(uiditDir(cwd), 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function readSession(cwd = process.cwd()) {
  const file = path.join(uiditDir(cwd), 'session.json');
  if (!fs.existsSync(file)) return EMPTY();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isSafeInteger(parsed.version) && parsed.version > 2) throw new Error(`session schema v${parsed.version} is newer than this UIDIT release supports (v2)`);
    const session = { ...EMPTY(), ...parsed, revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 0 };
    if (!Number.isSafeInteger(parsed.version) || parsed.version < 2) {
      const backup = `${file}.v${Number.isSafeInteger(parsed.version) ? parsed.version : 1}-backup-${Date.now()}`;
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      const byId = new Map((Array.isArray(parsed.elements) ? parsed.elements : []).map((element) => [element.id, element]));
      session.elements = (Array.isArray(session.elements) ? session.elements : []).map((element) => ({ ...element, anchor: element.anchor ?? anchorFor(element), routeKey: element.routeKey ?? routeIdentity(element.page), anchorStatus: 'located' }));
      session.comments = (Array.isArray(session.comments) ? session.comments : []).map((comment) => ({ ...comment, originalAnchor: comment.originalAnchor ?? byId.get(comment.elementId)?.anchor ?? (byId.has(comment.elementId) ? anchorFor(byId.get(comment.elementId)) : null), anchorStatus: comment.elementId ? 'located' : 'missing' }));
      session.version = 2;
      writeAtomic(file, `${JSON.stringify(session, null, 2)}\n`);
    }
    session.comments = Array.isArray(session.comments) ? session.comments.map((comment) => ({ ...comment, status: ['open', 'acknowledged', 'in_progress', 'implemented', 'verified', 'accepted', 'blocked', 'rejected', 'reopened', 'cancelled', 'needs_info'].includes(comment.status) ? comment.status : 'open', codeRefs: Array.isArray(comment.codeRefs) ? comment.codeRefs : [], replies: Array.isArray(comment.replies) ? comment.replies : [], attachments: Array.isArray(comment.attachments) ? comment.attachments : [] })) : [];
    session.flows = Array.isArray(session.flows) ? session.flows : [];
    for (const collection of ['tasks', 'proposals', 'evidence']) session[collection] = Array.isArray(session[collection]) ? session[collection] : [];
    return session;
  } catch (error) {
    // Preserve corrupt user data. Returning an empty session here made the next
    // mutation silently overwrite the only copy of their review history.
    throw new Error(`Cannot read ${file}: ${error.message}. The file was left untouched.`);
  }
}

export function writeSession(cwd, session) {
  const next = { ...session, version: 2, revision: (Number(session.revision) || 0) + 1, updatedAt: new Date().toISOString() };
  fs.mkdirSync(uiditDir(cwd), { recursive: true });
  writeAtomic(path.join(uiditDir(cwd), 'session.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function stableId(prefix, selector) {
  const hash = crypto.createHash('sha1').update(selector).digest('hex').slice(0, 8);
  return `${prefix}-${hash}`;
}

export function upsertElement(cwd, element) {
  return withSession(cwd, () => {
  const session = readSession(cwd);
  const anchor = anchorFor(element);
  const routeKey = anchor.route;
  let idx = element.id ? session.elements.findIndex((e) => e.id === element.id) : -1;
  if (idx < 0) idx = session.elements.findIndex((e) => (e.routeKey ?? routeIdentity(e.page)) === routeKey && e.selector === element.selector);
  const id = idx >= 0 ? session.elements[idx].id : (element.id ?? `el-${crypto.randomUUID()}`);
  const record = { ...(idx >= 0 ? session.elements[idx] : {}), ...element, id, routeKey, anchor, anchorStatus: 'located' };
  if (idx >= 0) session.elements[idx] = record;
  else session.elements.push(record);
  writeSession(cwd, session);
  return record;
  });
}

export function addComment(cwd, comment) {
  return withSession(cwd, () => {
  const session = readSession(cwd);
  const linkedElement = session.elements.find((element) => element.id === comment.elementId);
  const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
  if (attachments.length > 2) throw new Error('a comment can include at most 2 images');
  let attachmentBytes = 0;
  for (const image of attachments) {
    if (!image || image.mimeType !== 'image/jpeg' || typeof image.dataUrl !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(image.dataUrl) || image.dataUrl.length > 410_000) throw new Error('comment images must be compressed JPEGs under 300 KB');
    attachmentBytes += image.dataUrl.length;
    if (attachmentBytes > 820_000) throw new Error('comment images exceed the combined size limit');
  }
  const record = {
    ...comment,
    id: comment.id ?? stableId('cm', `${Date.now()}:${Math.random()}`),
    resolved: false,
    status: 'open',
    codeRefs: [],
    replies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attachments: attachments.map(({ dataUrl, name, width, height }) => ({ dataUrl, name: typeof name === 'string' ? name.slice(0, 120) : 'reference.jpg', width: Number.isInteger(width) ? Math.max(1, Math.min(1600, width)) : null, height: Number.isInteger(height) ? Math.max(1, Math.min(1600, height)) : null, mimeType: 'image/jpeg' })),
    originalAnchor: comment.originalAnchor ?? linkedElement?.anchor ?? (linkedElement ? anchorFor(linkedElement) : null),
    anchorStatus: comment.elementId ? 'located' : 'missing',
  };
  session.comments.push(record);
  writeSession(cwd, session);
  return record;
  });
}

export function normalizeCodeReference(reference) {
  if (!reference || typeof reference !== 'object') throw new Error('code reference must be an object');
  const file = typeof reference.file === 'string' ? reference.file.trim().replaceAll('\\', '/') : '';
  const startLine = Number(reference.startLine);
  const endLine = reference.endLine == null || reference.endLine === '' ? startLine : Number(reference.endLine);
  if (!file || file.length > 500 || file.startsWith('/') || /^[a-z]:\//i.test(file) || file.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('code reference file must be a normalized project-relative path');
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine || endLine - startLine > 5000) throw new Error('code reference lines must be valid positive line numbers');
  return { file, startLine, endLine };
}

/**
 * Append a reply to an existing comment.
 * @param {string} cwd
 * @param {string} commentId
 * @param {{ text: string, author?: 'reviewer'|'agent', source?: string, displayName?: string }} [reply]
 */
export function addCommentReply(cwd, commentId, { text, author = 'reviewer', source, displayName } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('reply text must be 1–4000 characters');
  if (!['reviewer', 'agent'].includes(author)) throw new Error('reply author must be reviewer or agent');
  return withSession(cwd, () => {
  const session = readSession(cwd);
  const comment = session.comments.find((item) => item.id === commentId);
  if (!comment) return null;
  comment.replies = Array.isArray(comment.replies) ? comment.replies : [];
  const reply = { id: stableId('rp', `${commentId}:${Date.now()}:${Math.random()}`), text: text.trim(), author, source: source ?? author, ...(typeof displayName === 'string' ? { displayName: displayName.slice(0, 80) } : {}), createdAt: new Date().toISOString() };
  comment.replies.push(reply);
  comment.updatedAt = reply.createdAt;
  writeSession(cwd, session);
  return { comment, reply };
  });
}

export function addEdit(cwd, edit) {
  return withSession(cwd, () => {
  const session = readSession(cwd);
  const record = {
    id: edit.id ?? stableId('ed', `${Date.now()}:${Math.random()}`),
    applied: false,
    createdAt: new Date().toISOString(),
    ...edit,
  };
  session.edits.push(record);
  writeSession(cwd, session);
  return record;
  });
}

export function updateRecord(cwd, collection, id, patch) {
  return withSession(cwd, () => {
  const session = readSession(cwd);
  const idx = session[collection].findIndex((r) => r.id === id);
  if (idx < 0) return null;
  session[collection][idx] = { ...session[collection][idx], ...patch, ...(collection === 'comments' && patch.updatedAt === undefined ? { updatedAt: new Date().toISOString() } : {}) };
  writeSession(cwd, session);
  return session[collection][idx];
  });
}

export function reattachComment(cwd, commentId, elementId) {
  const session = readSession(cwd);
  const comment = session.comments.find((item) => item.id === commentId);
  const element = session.elements.find((item) => item.id === elementId);
  if (!comment || !element) return null;
  const at = new Date().toISOString();
  const anchorHistory = [...(Array.isArray(comment.anchorHistory) ? comment.anchorHistory : [])];
  if (comment.elementId && comment.originalAnchor) anchorHistory.push({ elementId: comment.elementId, anchor: comment.originalAnchor, at });
  Object.assign(comment, { elementId, originalAnchor: element.anchor ?? anchorFor(element), anchorStatus: 'located', anchorHistory, updatedAt: at });
  writeSession(cwd, session);
  return comment;
}

export function removeRecord(cwd, collection, id) {
  const session = readSession(cwd);
  const before = session[collection].length;
  session[collection] = session[collection].filter((r) => r.id !== id);
  if (session[collection].length === before) return false;
  writeSession(cwd, session);
  return true;
}

export function mergeCollaborativeSession(cwd, remoteSession) {
  if (!remoteSession || !Array.isArray(remoteSession.comments)) throw new Error('invalid collaborative session snapshot');
  const session = readSession(cwd);
  const merged = new Map(session.comments.map((comment) => [comment.id, comment]));
  for (const remote of remoteSession.comments) {
    if (!remote || typeof remote.id !== 'string' || typeof remote.text !== 'string') continue;
    const local = merged.get(remote.id);
    const stamp = (value) => Date.parse(value?.updatedAt ?? value?.replies?.at(-1)?.createdAt ?? value?.createdAt ?? '') || 0;
    if (!local || stamp(remote) >= stamp(local)) merged.set(remote.id, remote);
  }
  const comments = [...merged.values()];
  if (JSON.stringify(comments) === JSON.stringify(session.comments)) return session;
  session.comments = comments;
  return writeSession(cwd, session);
}

export const AGENT_README = `# .uidit

Machine-readable record of the developer's UI review session. A coding agent should
read \`session.json\` before making UI changes so it does not lose the user's feedback.

## Files

- \`config.json\` — uidit settings (\`targetUrl\`, \`dashboardPort\`).
- \`session.json\` — the live session. See schema below.

## session.json schema

\`\`\`jsonc
{
  "version": 1,
  "revision": 0,
  "updatedAt": "ISO-8601",
  "elements": [
    {
      "id": "el-a1b2c3d4",
      "selector": "#main > div.card:nth-child(2)",   // css selector, primary handle
      "selectorAlternatives": [".card", "div.card"], // fallbacks
      "tag": "DIV",
      "text": "Checkout",                          // trimmed, collapsed
      "accessibleName": "Checkout summary",
      "role": "region",
      "nearbyText": "Order total Checkout summary $42",
      "component": { "framework": "React", "name": "OrderSummary" }, // best effort
      "ancestors": ["body", "main#main"],          // tag#id chains for context
      "attributes": { "class": "card", "data-x": "" },
      "page": "http://localhost:3000/cart"
    }
  ],
  "comments": [
    {
      "id": "cm-9f2a1b0c",
      "elementId": "el-a1b2c3d4",                   // null = page-level note
      "page": "http://localhost:3000/cart",
      "text": "This padding is inconsistent with the card below.",
      "status": "open",                            // open | in_progress | needs_info
      "codeRefs": [{ "file": "src/cart/Card.tsx", "startLine": 20, "endLine": 28 }],
      "anchor": { "x": 0.62, "y": 0.31 },           // normalized page point for page-level notes
      "replies": [{ "id": "rp-1234", "author": "agent", "text": "Should I match the next card's 16px padding?", "createdAt": "ISO-8601" }],
      "drawing": null,                            // optional arrow/rectangle/ellipse/freehand with normalized page points
      "resolved": false,
      "createdAt": "ISO-8601"
    }
  ],
  "edits": [
    {
      "id": "ed-77ab12cd",
      "elementId": "el-a1b2c3d4",
      "kind": "text" | "style" | "attribute" | "class" | "remove",
      "property": "padding",                       // style/attribute/class only
      "before": "12px",
      "after": "16px",
      "applied": false,                            // committed to source code; preview-only edits remain false
      "page": "http://localhost:3000/cart",
      "note": "optional",
      "createdAt": "ISO-8601"
    }
  ]
}
\`\`\`

## How an agent should use this

1. Read \`session.json\`.
2. Filter \`comments\` where \`resolved === false\`, ordered by \`createdAt\`.
   Use \`status\` for open, in-progress, or needs-info work. \`resolved\` remains
   the completion flag. MCP triage groups and priority are heuristics; review original
   feedback before acting.
3. Inspect any \`codeRefs\` first, then locate the element via \`elements[].selector\` (fall back to
   \`selectorAlternatives\`); if the element cannot be found, report the comment against
   the nearest \`ancestors\` entry and say so explicitly. If a comment has a \`drawing\`,
   treat it as a visual instruction: \`type\` is \`arrow\`, \`rectangle\`, \`ellipse\`, or
   \`freehand\`; \`points\` are normalized 0–1 x/y coordinates over page dimensions
   recorded in \`pageWidth\` and \`pageHeight\`. Arrows point from the first point to
   the last. Use nearby content and comment text to identify the affected component and
   preserve the indicated direction or highlighted area.
4. Treat every entry in \`edits\` as an explicit, user-approved change to apply in source.
   \`before\` is what was live when the user made the change, so it doubles as a sanity check.
   \`applied: true\` means the change has been committed to source, never merely previewed.
5. Mark feedback resolved by setting \`resolved: true\` on the comments you handled, or by
   running \`uidit resolve <commentId>\`. Never delete comments — they are the user's history.
6. If a comment needs clarification, add an agent reply with \`uidit_reply_comment\`; ask a focused question in the thread instead of guessing. Reply there when you have handled a request, then resolve the comment only when its work is complete.
7. Set \`edits[].applied\` to \`true\` only after the change is committed to the real source files.
`;
