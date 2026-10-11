import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

const EMPTY = () => ({ version: 1, revision: 0, updatedAt: null, elements: [], comments: [], edits: [] });

function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
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
    dev: { command: null, cwd: '.', url: null, autoStart: true, restartOnCrash: false },
    ui: { position: 'bottom-left', defaultOpen: false, inspectionDefault: false },
    mcp: { enabled: true, allowAgentWrites: false, allowAgentServerControl: false } };
}

export function migrateConfig(value = {}) {
  const base = defaultConfig();
  const controlPort = value.controlPort ?? value.dashboardPort ?? base.controlPort;
  return { ...base, ...value, version: 2, dashboardPort: controlPort, controlPort,
    previewPort: value.previewPort ?? base.previewPort, dev: { ...base.dev, ...(value.dev ?? {}) },
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
    const session = { ...EMPTY(), ...parsed, revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 0 };
    session.comments = Array.isArray(session.comments) ? session.comments.map((comment) => ({ ...comment, replies: Array.isArray(comment.replies) ? comment.replies : [] })) : [];
    return session;
  } catch (error) {
    // Preserve corrupt user data. Returning an empty session here made the next
    // mutation silently overwrite the only copy of their review history.
    throw new Error(`Cannot read ${file}: ${error.message}. The file was left untouched.`);
  }
}

export function writeSession(cwd, session) {
  const next = { ...session, version: 1, revision: (Number(session.revision) || 0) + 1, updatedAt: new Date().toISOString() };
  fs.mkdirSync(uiditDir(cwd), { recursive: true });
  writeAtomic(path.join(uiditDir(cwd), 'session.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function stableId(prefix, selector) {
  const hash = crypto.createHash('sha1').update(selector).digest('hex').slice(0, 8);
  return `${prefix}-${hash}`;
}

export function upsertElement(cwd, element) {
  const session = readSession(cwd);
  const id = element.id ?? stableId('el', element.selector);
  const idx = session.elements.findIndex((e) => e.id === id);
  const record = { ...(idx >= 0 ? session.elements[idx] : {}), ...element, id };
  if (idx >= 0) session.elements[idx] = record;
  else session.elements.push(record);
  writeSession(cwd, session);
  return record;
}

export function addComment(cwd, comment) {
  const session = readSession(cwd);
  const record = {
    id: comment.id ?? stableId('cm', `${Date.now()}:${Math.random()}`),
    resolved: false,
    replies: [],
    createdAt: new Date().toISOString(),
    ...comment,
  };
  session.comments.push(record);
  writeSession(cwd, session);
  return record;
}

export function addCommentReply(cwd, commentId, { text, author = 'reviewer', source } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('reply text must be 1–4000 characters');
  if (!['reviewer', 'agent'].includes(author)) throw new Error('reply author must be reviewer or agent');
  const session = readSession(cwd);
  const comment = session.comments.find((item) => item.id === commentId);
  if (!comment) return null;
  comment.replies = Array.isArray(comment.replies) ? comment.replies : [];
  const reply = { id: stableId('rp', `${commentId}:${Date.now()}:${Math.random()}`), text: text.trim(), author, source: source ?? author, createdAt: new Date().toISOString() };
  comment.replies.push(reply);
  writeSession(cwd, session);
  return { comment, reply };
}

export function addEdit(cwd, edit) {
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
}

export function updateRecord(cwd, collection, id, patch) {
  const session = readSession(cwd);
  const idx = session[collection].findIndex((r) => r.id === id);
  if (idx < 0) return null;
  session[collection][idx] = { ...session[collection][idx], ...patch };
  writeSession(cwd, session);
  return session[collection][idx];
}

export function removeRecord(cwd, collection, id) {
  const session = readSession(cwd);
  const before = session[collection].length;
  session[collection] = session[collection].filter((r) => r.id !== id);
  if (session[collection].length === before) return false;
  writeSession(cwd, session);
  return true;
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
      "ancestors": ["body", "main#main"],          // tag#id chains for context
      "attributes": { "class": "card", "data-x": "" },
      "page": "http://localhost:3000/cart",
      "status": "open"                             // open | resolved
    }
  ],
  "comments": [
    {
      "id": "cm-9f2a1b0c",
      "elementId": "el-a1b2c3d4",                   // null = page-level note
      "page": "http://localhost:3000/cart",
      "text": "This padding is inconsistent with the card below.",
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
3. For each, locate the element via \`elements[].selector\` (fall back to
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
