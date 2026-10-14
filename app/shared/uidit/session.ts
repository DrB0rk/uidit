import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The canonical anchor shape lives with the rest of UIDIT so this app and the
// overlay/relay score anchors identically.
// @ts-expect-error -- the legacy store is plain JavaScript outside this package.
import { anchorFor } from "../../../src/server/identity.js";

export const UIDIT_DIR = ".uidit";

const EMPTY_SESSION = () => ({
  version: 2 as const,
  revision: 0,
  updatedAt: null as string | null,
  elements: [] as ReviewElement[],
  comments: [] as ReviewComment[],
  edits: [] as ReviewEdit[],
});

export interface ReviewAnchor {
  selector: string;
  tag: string;
  text: string;
  route: string;
  fingerprint: string;
}

export interface ReviewElement {
  id: string;
  selector: string;
  tag?: string;
  text?: string;
  page?: string;
  ancestors?: string[];
  routeKey?: string;
  anchor?: ReviewAnchor;
  anchorStatus?: string;
}

export interface ReviewReply {
  id: string;
  text: string;
  author: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  elementId: string | null;
  text: string;
  status: string;
  resolved?: boolean;
  replies?: ReviewReply[];
  codeRefs?: { file: string; startLine: number; endLine: number }[];
  createdAt: string;
  updatedAt?: string;
  anchor?: ReviewAnchor | null;
  anchorStatus?: string;
}

export interface ReviewEdit {
  id: string;
  kind: "style" | "text" | "class" | "attribute";
  property?: string;
  before: string | null;
  after: string;
  applied: boolean;
  elementId?: string | null;
  createdAt: string;
}

export interface ReviewSession {
  version: 2;
  revision: number;
  updatedAt: string | null;
  elements: ReviewElement[];
  comments: ReviewComment[];
  edits: ReviewEdit[];
}

/** Nearest ancestor directory (from this app's location) holding an initialized `.uidit`. */
export function projectRoot(): string {
  let dir = appDir();
  for (;;) {
    if (fs.existsSync(path.join(dir, UIDIT_DIR, "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return appDir();
}

function appDir(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function uiditDir(root: string): string {
  return path.join(root, UIDIT_DIR);
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function readSession(root: string = projectRoot()): ReviewSession {
  const file = path.join(uiditDir(root), "session.json");
  if (!fs.existsSync(file)) return EMPTY_SESSION();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReviewSession>;
  return {
    ...EMPTY_SESSION(),
    ...parsed,
    revision: Number.isSafeInteger(parsed.revision) ? (parsed.revision as number) : 0,
    elements: Array.isArray(parsed.elements) ? parsed.elements : [],
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    edits: Array.isArray(parsed.edits) ? parsed.edits : [],
  };
}

export function writeSession(session: ReviewSession, root: string = projectRoot()): ReviewSession {
  const next: ReviewSession = {
    ...session,
    version: 2,
    revision: (Number(session.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(uiditDir(root), { recursive: true });
  writeAtomic(path.join(uiditDir(root), "session.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function addComment(
  input: { text: string; elementId?: string | null; author?: string },
  root: string = projectRoot(),
): ReviewComment {
  const text = input.text.trim();
  if (!text || text.length > 4000) throw new Error("comment text must be 1–4000 characters");
  const session = readSession(root);
  const elementId = input.elementId ?? null;
  if (elementId && !session.elements.some((element) => element.id === elementId)) {
    throw new Error(`unknown element: ${elementId}`);
  }
  const element = elementId ? session.elements.find((item) => item.id === elementId) : undefined;
  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: `cm-${randomUUID()}`,
    elementId,
    text,
    status: "open",
    resolved: false,
    replies: [],
    codeRefs: [],
    createdAt: now,
    updatedAt: now,
    anchor: element?.anchor ?? (element ? anchorFor(element) : null),
    anchorStatus: elementId ? "located" : "missing",
  };
  session.comments.push(comment);
  writeSession(session, root);
  return comment;
}

const COMMENT_STATUSES: Record<string, true> = {
  open: true,
  acknowledged: true,
  in_progress: true,
  implemented: true,
  verified: true,
  accepted: true,
  blocked: true,
  rejected: true,
  reopened: true,
  cancelled: true,
};

export function updateComment(
  id: string,
  patch: { status?: string; replyText?: string; author?: string },
  root: string = projectRoot(),
): ReviewComment {
  const session = readSession(root);
  const comment = session.comments.find((item) => item.id === id);
  if (!comment) throw new Error(`unknown comment: ${id}`);
  const now = new Date().toISOString();
  if (patch.status !== undefined) {
    if (!COMMENT_STATUSES[patch.status]) throw new Error(`unsupported comment status: ${patch.status}`);
    comment.status = patch.status;
    comment.resolved = comment.status === "verified" || comment.status === "accepted";
  }
  if (patch.replyText !== undefined) {
    const replyText = patch.replyText.trim();
    if (!replyText || replyText.length > 4000) throw new Error("reply text must be 1–4000 characters");
    comment.replies = comment.replies ?? [];
    comment.replies.push({
      id: `rp-${randomUUID()}`,
      text: replyText,
      author: (patch.author ?? "agent").slice(0, 80),
      createdAt: now,
    });
  }
  comment.updatedAt = now;
  writeSession(session, root);
  return comment;
}

export const STYLE_PROPERTIES: Record<string, true> = {
  padding: true,
  margin: true,
  gap: true,
  display: true,
  "align-items": true,
  "justify-content": true,
  "grid-template-columns": true,
  "font-size": true,
  "font-weight": true,
  "line-height": true,
  "letter-spacing": true,
  color: true,
  "background-color": true,
  border: true,
  "border-radius": true,
  "box-shadow": true,
  opacity: true,
  width: true,
  "max-width": true,
  "min-height": true,
  "text-align": true,
};

const EDIT_KINDS: Record<string, true> = { style: true, text: true, class: true, attribute: true };

export function addEdit(
  input: {
    kind: ReviewEdit["kind"];
    after: string;
    before?: string | null;
    property?: string;
    elementId?: string | null;
  },
  root: string = projectRoot(),
): ReviewEdit {
  const session = readSession(root);
  if (!EDIT_KINDS[input.kind]) throw new Error(`unsupported edit kind: ${input.kind}`);
  const after = String(input.after ?? "").slice(0, 160);
  if (!after) throw new Error("edit value must not be empty");
  if (/[<>]/.test(after) || /url\s*\(|expression\s*\(/i.test(after)) {
    throw new Error("edit value contains unsupported syntax");
  }
  if (input.kind === "style") {
    if (!input.property || !STYLE_PROPERTIES[input.property]) {
      throw new Error(`style edits must target an allowlisted property`);
    }
  }
  if (input.elementId && !session.elements.some((element) => element.id === input.elementId)) {
    throw new Error(`unknown element: ${input.elementId}`);
  }
  const edit: ReviewEdit = {
    id: `ed-${randomUUID()}`,
    kind: input.kind,
    property: input.property,
    before: input.before ?? null,
    after,
    applied: false,
    elementId: input.elementId ?? null,
    createdAt: new Date().toISOString(),
  };
  session.edits.push(edit);
  writeSession(session, root);
  return edit;
}

export function markEditApplied(id: string, applied: boolean, root: string = projectRoot()): ReviewEdit {
  const session = readSession(root);
  const edit = session.edits.find((item) => item.id === id);
  if (!edit) throw new Error(`unknown edit: ${id}`);
  edit.applied = applied;
  writeSession(session, root);
  return edit;
}