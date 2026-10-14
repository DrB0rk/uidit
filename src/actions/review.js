import * as store from '../server/store.js';

/**
 * One definition per review operation, shared by every surface.
 *
 * The dashboard's HTTP routes, the MCP tools an agent calls, and the CLI all
 * dispatch through this registry, so a rule lives in exactly one place. Adding
 * an action here exposes it everywhere; the alternative -- a route handler and a
 * tool handler that each call the store -- is what let them drift apart.
 *
 * Each action declares `description` (what the agent reads to choose it) and
 * `run(cwd, input)`, which performs the work and returns the records the caller
 * needs. Response shapes are the routes' own, so the dashboard is unaffected.
 */
export const reviewActions = {
  'tag-element': {
    description:
      'Record or update an element picked in the preview, keyed by its CSS selector. Returns the stable element id that comments and edits attach to.',
    run: (cwd, input) => ({ element: store.upsertElement(cwd, input) }),
  },

  'add-comment': {
    description:
      'Record a review comment against a tagged element, or against the page as a whole when no element is given.',
    run: (cwd, input) => ({ comment: store.addComment(cwd, input) }),
  },

  'reply-comment': {
    description: 'Append a reply to an existing review comment thread.',
    run: (cwd, input) => {
      // The reviewer writes from the dashboard, an agent writes through MCP;
      // the thread shows who said what, so identity travels with the call.
      const author = input.author === 'agent' ? 'agent' : 'reviewer';
      const result = store.addCommentReply(cwd, input.commentId, {
        text: input.text,
        author,
        source: input.source ?? author,
      });
      // A null result means the comment is gone; the caller reports that as 404
      // rather than inventing an empty success.
      return result ? { comment: result.comment, reply: result.reply } : null;
    },
  },

  'add-edit': {
    description:
      'Record a proposed preview edit (CSS property, text, class, attribute, or hide). It stays uncommitted until it is marked applied.',
    run: (cwd, input) => ({ edit: store.addEdit(cwd, input) }),
  },

  'update-record': {
    description:
      'Patch one comment, edit, or element by id -- status, resolved, applied, and the rest of its fields.',
    run: (cwd, input) => {
      const record = store.updateRecord(cwd, input.collection, input.id, input.patch);
      return record ? { record } : null;
    },
  },
};

/**
 * Run a review action by name. Returns the action's payload, or null when the
 * action reported "nothing to act on" so callers can answer 404 honestly.
 */
export function runReviewAction(name, cwd, input) {
  const action = reviewActions[name];
  if (!action) throw new Error(`unknown review action: ${name}`);
  return action.run(cwd, input);
}

/** Name and description for every action, for tool registration and docs. */
export function describeReviewActions() {
  return Object.entries(reviewActions).map(([name, action]) => ({
    name,
    description: action.description,
  }));
}
