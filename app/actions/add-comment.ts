import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { addComment } from "../shared/uidit/session.js";

export default defineAction({
  description:
    "Record a review comment in the UI session, either against a tagged element or against the page as a whole. Use this when the user reports what looks wrong on a screen.",
  schema: z.object({
    text: z.string().min(1).max(4000).describe("What is wrong or what should change."),
    elementId: z
      .string()
      .optional()
      .describe("Element id from list-feedback; omit for a whole-page comment."),
    author: z.string().max(80).default("agent").describe('Who is leaving the comment, e.g. "agent".'),
  }),
  run: async ({ text, elementId, author }) => {
    try {
      const comment = addComment({ text, elementId: elementId ?? null, author });
      return {
        id: comment.id,
        status: comment.status,
        elementId: comment.elementId,
        message: `Comment ${comment.id} recorded`,
        nextRequiredAction: "list-feedback",
      };
    } catch (error) {
      throw fail((error as Error).message, { errorCode: "comment_rejected", statusCode: 400 });
    }
  },
});