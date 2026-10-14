import fs from "node:fs";
import path from "node:path";

// UIDIT already owns session semantics (v1→v2 migration, status normalization,
// anchor fallback, atomic writes). This module is a typed entry point to that one
// implementation -- it must never grow a second copy of those rules.
// @ts-expect-error -- the store is plain JavaScript outside this package.
import { addComment as storeAddComment, addCommentReply, addEdit as storeAddEdit, readSession as storeReadSession, updateRecord } from "../../../src/server/store.js";

export const UIDIT_DIR = ".uidit";

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
  originalAnchor?: ReviewAnchor | null;
  anchorStatus?: string;
}

export interface ReviewEdit {
  id: string;
  kind: "style" | "text" | "class" | "attribute" | "remove";
  property?: string;
  before: string | null;
  after: string;
  applied: boolean;
  elementId?: string | null;
  createdAt: string;
}

export interface ReviewSession {
  version: number;
  revision: number;
  updatedAt: string | null;
  elements: ReviewElement[];
  comments: ReviewComment[];
  edits: ReviewEdit[];
  [collection: string]: unknown;
}

/** Statuses the store treats as completion for a comment. */
const RESOLVED_STATUSES: Record<string, true> = {
  verified: true,
  accepted: true,
};

/**
 * A comment is done when the store says so, whichever way it was marked:
 * `resolved` is set by `uidit resolve` and by the review UI, while the
 * verified/accepted statuses mean the same thing to a reviewer.
 */
export function isResolved(comment: ReviewComment): boolean {
  return comment.resolved === true || RESOLVED_STATUSES[comment.status] === true;
}

// The store coerces an unknown status back to "open" on the next read, which
// would silently discard the caller's intent. Reject it here instead.
const COMMENT_STATUSES: Record<string, true> = {
  open: true,
  acknowledged: true,
  in_progress: true,
  needs_info: true,
  implemented: true,
  verified: true,
  accepted: true,
  blocked: true,
  rejected: true,
  reopened: true,
  cancelled: true,
};

/**
 * Nearest ancestor directory holding an initialized `.uidit`.
 *
 * Anchored on the process working directory rather than this module's location:
 * `import.meta.dirname` is undefined in some bundled output, and the cwd is
 * what an operator means by "this project" anyway.
 */
export function projectRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, UIDIT_DIR, "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function readSession(root: string = projectRoot()): ReviewSession {
  return storeReadSession(root) as ReviewSession;
}

export function addComment(
  input: { text: string; elementId?: string | null; author?: string },
  root: string = projectRoot(),
): ReviewComment {
  const session = readSession(root);
  const elementId = input.elementId ?? null;
  if (elementId && !session.elements.some((element) => element.id === elementId)) {
    throw new Error(`unknown element: ${elementId}`);
  }
  return storeAddComment(root, {
    elementId,
    text: input.text,
    page: null,
    author: input.author ?? "agent",
    attachments: [],
  }) as ReviewComment;
}

export function updateComment(
  id: string,
  patch: { status?: string; replyText?: string; author?: string },
  root: string = projectRoot(),
): ReviewComment {
  if (patch.replyText !== undefined) {
    addCommentReply(root, id, {
      text: patch.replyText,
      author: patch.author === "agent" ? "agent" : "reviewer",
    });
  }
  if (patch.status !== undefined) {
    if (!COMMENT_STATUSES[patch.status]) {
      throw new Error(`unsupported comment status: ${patch.status}`);
    }
    const updated = updateRecord(root, "comments", id, {
      status: patch.status,
      // Reopening must clear the flag, or the comment stays done for the queue.
      resolved: RESOLVED_STATUSES[patch.status] === true,
    });
    if (!updated) throw new Error(`unknown comment: ${id}`);
  }
  const comment = readSession(root).comments.find((item) => item.id === id);
  if (!comment) throw new Error(`unknown comment: ${id}`);
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
  if (input.elementId && !session.elements.some((element) => element.id === input.elementId)) {
    throw new Error(`unknown element: ${input.elementId}`);
  }
  if (input.kind === "style" && !input.property) {
    throw new Error("style edits need a property");
  }
  if (input.kind === "style" && !STYLE_PROPERTIES[input.property as string]) {
    throw new Error(`style edits must target an allowlisted property: ${input.property}`);
  }
  const after = String(input.after ?? "").slice(0, 160);
  if (!after) throw new Error("edit value must not be empty");
  if (/[<>]/.test(after) || /url\s*\(|expression\s*\(/i.test(after)) {
    throw new Error("edit value contains unsupported syntax");
  }
  return storeAddEdit(root, {
    elementId: input.elementId ?? null,
    kind: input.kind,
    property: input.property,
    before: input.before ?? null,
    after,
  }) as ReviewEdit;
}

export function markEditApplied(
  id: string,
  applied: boolean,
  root: string = projectRoot(),
): ReviewEdit {
  const updated = updateRecord(root, "edits", id, { applied });
  if (!updated) throw new Error(`unknown edit: ${id}`);
  return updated as ReviewEdit;
}