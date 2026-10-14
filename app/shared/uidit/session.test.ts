import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addComment,
  addEdit,
  markEditApplied,
  readSession,
  updateComment,
  writeSession,
} from "./session.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uidit-session-"));
  fs.mkdirSync(path.join(root, ".uidit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".uidit", "config.json"), "{}\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedElement() {
  const session = readSession(root);
  session.elements.push({
    id: "el-card",
    selector: ".cart > .card",
    tag: "div",
    text: "Checkout",
    page: "http://127.0.0.1:3000/checkout",
  });
  writeSession(session, root);
  return "el-card";
}

describe("review session invariants", () => {
  it("refuses a comment on an untagged element and accepts a page comment", () => {
    expect(() => addComment({ text: "spacing", elementId: "el-missing" }, root)).toThrow(
      /unknown element/,
    );
    const comment = addComment({ text: "  page is off  " }, root);
    expect(comment.text).toBe("page is off");
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
    const edit = addEdit({ elementId, kind: "style", property: "padding", after: "16px" }, root);
    expect(edit.applied).toBe(false);
  });

  it("keeps an edit uncommitted until it is marked applied", () => {
    const elementId = seedElement();
    const edit = addEdit({ elementId, kind: "text", after: "Pay now" }, root);
    expect(readSession(root).edits[0].applied).toBe(false);
    expect(markEditApplied(edit.id, true, root).applied).toBe(true);
  });
});