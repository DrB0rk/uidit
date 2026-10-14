import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { projectRoot } from "../shared/uidit/session.js";
import { upsertElement } from "./uidit-store.js";

const MAX_SELECTOR = 2000;

export default defineAction({
  description:
    "Record or update an element the reviewer picked in the live preview, keyed by its CSS selector. Returns the stable element id that comments and edits attach to.",
  schema: z.object({
    selector: z.string().min(1).max(MAX_SELECTOR).describe("CSS selector for the picked element."),
    selectorAlternatives: z
      .array(z.string().max(MAX_SELECTOR))
      .max(12)
      .optional()
      .describe("Fallback selectors if the primary one stops matching."),
    tag: z.string().max(32).optional().describe("Lowercase tag name, e.g. div."),
    text: z.string().max(300).optional().describe("Collapsed visible text."),
    accessibleName: z.string().max(240).optional(),
    role: z.string().max(80).optional(),
    nearbyText: z.string().max(240).optional(),
    page: z.string().max(MAX_SELECTOR).optional().describe("URL of the page the element was picked on."),
    ancestors: z.array(z.string().max(120)).max(5).optional().describe("tag#id chain, innermost last."),
    attributes: z
      .record(z.string().max(80), z.string().max(300))
      .optional()
      .describe("Relevant attributes such as data-testid, name, href, aria-label."),
  }),
  run: async (element) => {
    try {
      const record = upsertElement(projectRoot(), {
        ...element,
        ancestors: element.ancestors ?? [],
      }) as { id: string; selector: string };
      return {
        id: record.id,
        selector: record.selector,
        // The preview overlay replays the saved record as `{ element }` when it
        // confirms a pick, so the stored record travels with the response.
        element: record,
        message: `Element ${record.id} recorded`,
        link: () => ({
          label: `Review ${record.selector}`,
          url: `/review?element=${encodeURIComponent(record.id)}`,
        }),
      };
    } catch (error) {
      throw fail((error as Error).message, { errorCode: "element_rejected", statusCode: 400 });
    }
  },
});