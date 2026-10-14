import { defineAction, fail } from "@agent-native/core/action";
import type { WriteReceipt } from "@agent-native/core/action";
import { z } from "zod";

import { assertAgentWritesAllowed, markEditApplied } from "../shared/uidit/session.js";

export default defineAction({
  description:
    "Mark a preview edit as committed to source (applied true) or back to uncommitted. Call it only after the change is actually in the project files.",
  schema: z.object({
    editId: z.string().min(1).describe("Edit id from list-feedback."),
    applied: z.boolean().describe("True when the edit is committed in source."),
  }),
  run: async ({ editId, applied }, ctx) => {
    try {
      assertAgentWritesAllowed(ctx?.caller);
      const edit = markEditApplied(editId, applied);
      const _receipt: WriteReceipt = {
        changed: true,
        verified: "unverified",
        subject: `edit:${edit.id}`,
        summary: applied
          ? `Edit ${edit.id} marked committed to source.`
          : `Edit ${edit.id} marked uncommitted.`,
      };
      return { id: edit.id, applied: edit.applied, _receipt };
    } catch (error) {
      throw fail((error as Error).message, {
        errorCode: (error as Error).message.includes("disabled in .uidit/config.json")
          ? "agent_writes_disabled"
          : "edit_not_found",
        statusCode: (error as Error).message.includes("disabled in .uidit/config.json") ? 403 : 404,
      });
    }
  },
});