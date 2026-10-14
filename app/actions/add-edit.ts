import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { addEdit } from "../shared/uidit/session.js";

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
    "Record a proposed preview edit for a tagged element (CSS property, text, class, attribute, or hide). The edit starts uncommitted: call mark-edit-applied only once the change is in source.",
  schema: z.object({
    elementId: z.string().min(1).describe("Element id from list-feedback."),
    kind: z
      .enum(["style", "text", "class", "attribute", "remove"])
      .describe(
        "style = CSS property change, text = content, class = class list, attribute = HTML attribute, remove = hide the element.",
      ),
    after: z
      .string()
      .max(2000)
      .optional()
      .describe("New value to apply. Omit for remove, which has no value."),
    property: z
      .string()
      .max(100)
      .optional()
      .describe(
        "CSS property when kind is style (must be on the allowlist), the class name when kind is class, the attribute name when kind is attribute.",
      ),
    before: z.string().max(2000).optional().describe("Observed previous value, for the before → after record."),
  }),
  run: async ({ elementId, kind, after, property, before }) => {
    if (kind === "style" && !property) {
      throw fail("style edits need a property", { errorCode: "missing_property", statusCode: 400 });
    }
    if (kind !== "remove" && !after) {
      throw fail("edit value must not be empty", { errorCode: "missing_value", statusCode: 400 });
    }
    try {
      const edit = addEdit({ elementId, kind, after: after ?? "", property, before: before ?? null });
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