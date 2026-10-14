import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error -- the store is plain JavaScript outside this package.
import { init as storeInit, readSession as legacyReadSession, upsertElement } from "../../../src/server/store.js";
import { addComment, addEdit, markEditApplied, readSession, updateComment } from "./session.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uidit-session-"));
  storeInit(root, { force: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const seedElement = () =>
  upsertElement(root, {
    selector: ".cart > .card",
    tag: "div",
    text: "Checkout",
    page: "http://127.0.0.1:3000/checkout",
  }).id as string;

describe("review session invariants", () => {
  it("refuses a comment on an untagged element and accepts a page comment", () => {
    expect(() => addComment({ text: "spacing", elementId: "el-missing" }, root)).toThrow(
      /unknown element/,
    );
    const comment = addComment({ text: "  page is off  " }, root);
    expect(comment.status).toBe("open");
    expect(comment.resolved).toBe(false);
  });

  it("resolves a comment only when its status reaches verified", () => {
    const comment = addComment({ text: "spacing" }, root);
    expect(updateComment(comment.id, { status: "implemented" }, root).resolved).toBe(false);
    expect(updateComment(comment.id, { status: "verified" }, root).resolved).toBe(true);
  });

  it("rejects an unsupported status and leaves the comment intact", () => {
    const comment = addComment({ text: "spacing" }, root);
    expect(() => updateComment(comment.id, { status: "shipped" }, root)).toThrow(
      /unsupported comment status/,
    );
    expect(readSession(root).comments[0].status).toBe("open");
  });

  it("only allows allowlisted style properties and safe values", () => {
    const elementId = seedElement();
    expect(() =>
      addEdit({ elementId, kind: "style", property: "position", after: "fixed" }, root),
    ).toThrow(/allowlisted/);
    expect(() =>
      addEdit({ elementId, kind: "style", property: "padding", after: "url(x)" }, root),
    ).toThrow(/unsupported syntax/);
    expect(addEdit({ elementId, kind: "style", property: "padding", after: "16px" }, root).applied).toBe(
      false,
    );
  });

  it("keeps an edit uncommitted until it is marked applied", () => {
    const elementId = seedElement();
    const edit = addEdit({ elementId, kind: "text", after: "Pay now" }, root);
    expect(readSession(root).edits[0].applied).toBe(false);
    expect(markEditApplied(edit.id, true, root).applied).toBe(true);
  });

  it("exposes the element selector for an element-bound comment", () => {
    const elementId = seedElement();
    const comment = addComment({ text: "bound", elementId }, root);
    // The store records the durable anchor on `originalAnchor`.
    expect(readSession(root).comments[0].originalAnchor?.selector).toBe(".cart > .card");
    expect(readSession(root).comments.find((item) => item.id === comment.id)?.anchor).toBeUndefined();
  });

  it("stays readable by the existing store, with anchors the overlay can score", () => {
    const elementId = seedElement();
    const comment = addComment({ text: "spacing is off here" }, root);
    updateComment(comment.id, { status: "in_progress", replyText: "on it" }, root);
    addEdit({ elementId, kind: "style", property: "padding", after: "16px", before: "12px" }, root);

    // Read back through the legacy module: this app must not write a shape that
    // drops fields the overlay and relay depend on.
    const legacy = legacyReadSession(root);
    expect(legacy.version).toBe(2);
    expect(legacy.comments[0].status).toBe("in_progress");
    expect(legacy.comments[0].replies).toHaveLength(1);
    expect(legacy.comments[0].codeRefs).toEqual([]);
    expect(legacy.comments[0].originalAnchor).toBeNull();
    // A comment bound to an element keeps the anchor the overlay can re-score.
    const bound = addComment({ text: "bound to the card", elementId }, root);
    const boundRecord = legacyReadSession(root).comments.find(
      (comment: { id: string }) => comment.id === bound.id,
    );
    expect(boundRecord.originalAnchor).toBeTruthy();
    expect(legacy.elements[0].anchor.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(legacy.edits[0].before).toBe("12px");
    // Both modules read one revision counter, so each write is visible to the
    // overlay's SSE fan-out rather than clobbering it.
    expect(legacyReadSession(root).revision).toBe(readSession(root).revision);
  });
});