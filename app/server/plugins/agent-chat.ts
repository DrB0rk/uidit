import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "list-feedback",
  "add-comment",
  "update-comment",
  "add-edit",
  "mark-edit-applied",
  "view-screen",
  "navigate",
];

export default createAgentChatPlugin({
  appId: "app",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the UIDIT review agent. The /review route and this chat share one contract: the UI review session in the project's .uidit/session.json.

Start with list-feedback. Elements are what the user tagged on the running page, comments are their feedback with a status, and edits are proposed changes that are uncommitted until mark-edit-applied says they are in source. Never claim a change is committed before it is; never delete a comment.

Confirm source matches before proposing an edit: element matches are suggestions from observed page context.`,
});
