import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { assertAgentWritesAllowed, updateComment } from "../shared/uidit/session.js";

export default defineAction({
  description:
    "Update one review comment: move it to a new status, reply to it, or both. Use it to claim work, report what you changed, and close the loop after the user confirms a fix.",
  schema: z.object({
    commentId: z.string().min(1).describe("Comment id from list-feedback."),
    status: z
      .enum([
        "open",
        "acknowledged",
        "in_progress",
        "implemented",
        "verified",
        "accepted",
        "blocked",
        "rejected",
        "reopened",
        "cancelled",
      ])
      .optional()
      .describe("New comment status; omit to only add a reply."),
    replyText: z.string().min(1).max(4000).optional().describe("Reply to append to the comment thread."),
    author: z.string().max(80).default("agent").describe('Author of the reply, e.g. "agent".'),
  }),
  run: async ({ commentId, status, replyText, author }, ctx) => {
    try {
      assertAgentWritesAllowed(ctx?.caller);
    } catch (error) {
      throw fail((error as Error).message, { errorCode: "agent_writes_disabled", statusCode: 403 });
    }
    if (status === undefined && replyText === undefined) {
      throw fail("provide a status or a replyText", { errorCode: "no_change", statusCode: 400 });
    }
    try {
      const comment = updateComment(commentId, { status, replyText, author });
      return {
        id: comment.id,
        status: comment.status,
        resolved: comment.resolved === true,
        replyCount: comment.replies?.length ?? 0,
        message: `Comment ${comment.id} is now ${comment.status}`,
      };
    } catch (error) {
      throw fail((error as Error).message, { errorCode: "comment_not_found", statusCode: 404 });
    }
  },
});