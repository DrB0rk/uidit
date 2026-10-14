import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { addEdit, assertAgentWritesAllowed } from "../shared/uidit/session.js";

const STYLE_PROPERTIES = [
  "padding",
  "margin",
  "gap",
  "display",
  "align-items",
  "justify-content",
  "grid-template-columns",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
  "width",
  "max-width",
  "min-height",
  "text-align",
] as const;

export default defineAction({
  description:
    "Record a proposed preview edit for a tagged element (CSS property, text, class, or attribute). The edit starts uncommitted: set applied to true with mark-edit-applied only after the change is in source.",
  schema: z.object({
    elementId: z.string().min(1).describe("Element id from list-feedback."),
    kind: z
      .enum(["style", "text", "class", "attribute"])
      .describe("style = CSS property change, text = content, class = class list, attribute = HTML attribute."),
    after: z.string().min(1).max(160).describe("New value to apply."),
    property: z
      .enum(STYLE_PROPERTIES)
      .optional()
      .describe("Required when kind is style; must be one of the allowlisted CSS properties."),
    before: z.string().max(160).optional().describe("Observed previous value, for the before → after record."),
  }),
  run: async ({ elementId, kind, after, property, before }, ctx) => {
    try {
      assertAgentWritesAllowed(ctx?.caller);
    } catch (error) {
      throw fail((error as Error).message, { errorCode: "agent_writes_disabled", statusCode: 403 });
    }
    if (kind === "style" && !property) {
      throw fail("style edits need a property", { errorCode: "missing_property", statusCode: 400 });
    }
    try {
      const edit = addEdit({ elementId, kind, after, property, before: before ?? null });
      return {
        id: edit.id,
        applied: false,
        message: `Edit ${edit.id} proposed; commit it with mark-edit-applied once it is in source`,
        nextRequiredAction: "mark-edit-applied",
      };
    } catch (error) {
      throw fail((error as Error).message, { errorCode: "edit_rejected", statusCode: 400 });
    }
  },
});