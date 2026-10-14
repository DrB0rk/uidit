import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { readSession } from "../shared/uidit/session.js";

export default defineAction({
  description:
    "List the UI review session: elements that were tagged on the running page, reviewer comments with their status, and preview edits with whether they were committed to source.",
  schema: z.object({
    includeResolved: z
      .boolean()
      .default(false)
      .describe("Include resolved comments; defaults to false (the open queue only)."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ includeResolved }) => {
    const session = readSession();
    const comments = session.comments.filter((comment) =>
      includeResolved ? true : comment.status !== "verified" && comment.status !== "accepted",
    );
    return {
      revision: session.revision,
      updatedAt: session.updatedAt,
      elements: session.elements.map((element) => ({
        id: element.id,
        selector: element.selector,
        tag: element.tag ?? null,
        text: element.text ?? null,
        route: element.routeKey ?? element.page ?? null,
        anchorStatus: element.anchorStatus ?? "located",
      })),
      comments: comments.map((comment) => ({
        id: comment.id,
        elementId: comment.elementId,
        selector: comment.anchor?.selector ?? null,
        text: comment.text,
        status: comment.status,
        replyCount: comment.replies?.length ?? 0,
        createdAt: comment.createdAt,
      })),
      edits: session.edits.map((edit) => ({
        id: edit.id,
        kind: edit.kind,
        property: edit.property ?? null,
        before: edit.before,
        after: edit.after,
        applied: edit.applied,
        elementId: edit.elementId ?? null,
      })),
      counts: {
        openComments: comments.filter((comment) => comment.status === "open").length,
        pendingEdits: session.edits.filter((edit) => !edit.applied).length,
      },
    };
  },
});