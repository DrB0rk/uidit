import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { projectRoot } from "../shared/uidit/session.js";
import { readConfig } from "./uidit-store.js";

export default defineAction({
  description:
    "Describe the live preview host for this project: where UIDIT serves the previewed app, and which target URL it proxies. The review workspace embeds this preview.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    // The store defaults to the process cwd, which is the app package, not the
    // project under review.
    const config = readConfig(projectRoot()) as
      | { targetUrl?: string | null; previewPort?: number; controlPort?: number }
      | null;
    const previewPort = config?.previewPort ?? 7717;
    return {
      previewUrl: `http://127.0.0.1:${previewPort}`,
      targetUrl: config?.targetUrl ?? null,
      // Without a target the preview still serves UIDIT's own fallback page, so
      // the workspace can say so instead of showing an unexplained error.
      hasTarget: typeof config?.targetUrl === "string" && config.targetUrl.length > 0,
    };
  },
});