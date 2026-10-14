// Server-only typed entry point to the existing UIDIT store.
//
// The store is plain JavaScript owned by the main `uidit` server. `allowJs` in
// tsconfig types it at this boundary instead of suppressing the import, so a
// change to its signatures surfaces here as a type error rather than as a
// runtime surprise in the review workspace.
export {
  addComment,
  addCommentReply,
  addEdit,
  isInitialized,
  readConfig,
  readSession,
  reattachComment,
  updateRecord,
  upsertElement,
  withSession,
} from "../../src/server/store.js";