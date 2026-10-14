import * as store from './store.js';

/**
 * The project's opt-in for letting an agent change the review session.
 *
 * `mcp.allowAgentWrites` defaults to false, and every agent-facing write must
 * honour it. The check lives here rather than inline at each call site: it was
 * copy-pasted eleven times, so a new tool that forgot it would have opened a
 * silent write path with no test able to catch the omission.
 *
 * Deliberately throws rather than returning a boolean, so a caller cannot
 * accidentally ignore the result and write anyway.
 */
export function assertAgentWritesAllowed(cwd) {
  const config = store.readConfig(cwd);
  // No config means no UIDIT project is initialized here; there is no policy
  // to honour and nothing for the agent to write into.
  if (config && !config.mcp?.allowAgentWrites) {
    throw new Error('Agent writes are disabled in .uidit/config.json');
  }
}
