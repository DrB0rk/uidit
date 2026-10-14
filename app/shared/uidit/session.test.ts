import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  init as storeInit,
  readSession as legacyReadSession,
  updateRecord,
  upsertElement,
  writeConfig as storeWriteConfig,
} from "../../../src/server/store.js";
import listFeedback from "../../actions/list-feedback.js";
import {
  addComment,
  addEdit,
  assertAgentWritesAllowed,
  markEditApplied,
  readSession,
  updateComment,
} from "./session.js";

let root: string;

let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uidit-session-"));
  storeInit(root, { force: true });
  // Actions resolve the project root from the working directory.
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
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

  it("refuses agent writes when mcp.allowAgentWrites is off, but not the reviewer UI", () => {
    storeWriteConfig(root, { mcp: { allowAgentWrites: false } });
    for (const caller of ["tool", "mcp", "a2a", "cli", "http", undefined]) {
      expect(() => assertAgentWritesAllowed(caller, root)).toThrow(/disabled/);
    }
    // The reviewer driving the dashboard is not an agent.
    expect(() => assertAgentWritesAllowed("frontend", root)).not.toThrow();
  });

  it("allows agent writes once the project opts in", () => {
    storeWriteConfig(root, { mcp: { allowAgentWrites: true } });
    expect(() => assertAgentWritesAllowed("tool", root)).not.toThrow();
  });

  it("keeps a CLI-resolved comment out of the queue", async () => {
    const elementId = seedElement();
    const comment = addComment({ text: "resolve me from the CLI", elementId }, root);
    // `uidit resolve` sets only this flag and leaves status at "open".
    updateRecord(root, "comments", comment.id, { resolved: true });

    const open = await listFeedback.run({});
    expect(open.comments.map((item: { id: string }) => item.id)).not.toContain(comment.id);
    expect(open.counts.unresolvedComments).toBe(0);

    const all = await listFeedback.run({ includeResolved: true });
    expect(all.comments.map((item: { id: string }) => item.id)).toContain(comment.id);
    expect(all.comments.find((item: { id: string }) => item.id === comment.id)?.resolved).toBe(true);
  });

  it("exposes the element selector for an element-bound comment", async () => {
    const elementId = seedElement();
    const comment = addComment({ text: "bound", elementId }, root);
    // The store records the durable anchor on `originalAnchor`.
    expect(readSession(root).comments[0].originalAnchor?.selector).toBe(".cart > .card");
    expect(readSession(root).comments.find((item) => item.id === comment.id)?.anchor).toBeUndefined();

    const feedback = await listFeedback.run({});
    expect(feedback.comments[0].selector).toBe(".cart > .card");
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