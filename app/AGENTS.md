# Chat — Agent Guide

Chat is the minimal chat-first agent-native app. `/` redirects to shared sign-in, then `/home`, the editable Get started page. Chat lives at `/chat`; new chats start there. Actions carry capabilities; screens exist only for durable workflows.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Application state

- `navigation` describes the view and selected ids. Chat is `chat` at `/chat` and `/chat/<threadId>`; the Get started page is `home` at `/home`; `/` opens shared sign-in/signup.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.

## UIDIT review app

`/review` is the domain route: the UI review queue for the project. It and the chat agent share one store — the review session in the project's `.uidit/session.json`. `shared/uidit/session.ts` is a thin typed entry point over `src/server/store.js`, which stays the single implementation of session semantics (v1→v2 migration, status normalization, anchor fallback, atomic writes). Add a rule there, not a second copy beside it.

- **Invariants.** A comment is never deleted; its status moves within `open → acknowledged → in_progress → implemented → verified → accepted` (with `needs_info`, `blocked`, `rejected`, `reopened`, `cancelled`). `verified` and `accepted` are the completion states. An `edit` is a proposal and stays `applied: false` until `mark-edit-applied` confirms it is in source. Style edits only allowlist the properties in `STYLE_PROPERTIES`; values reject `<`, `url(`, and `expression(`. An edit must target a tagged element id.
- **Report a rejection** with its `errorCode` (`comment_rejected`, `comment_not_found`, `edit_rejected`, `edit_not_found`, `missing_property`, `no_change`) and the action's message; never retry the same rejected input.
- **Conventions.** Times are UTC ISO 8601. Element matches come from observed page context and are suggestions — confirm them in source before proposing an edit.
- **Navigation.** `view: "review"` at `/review`.

### Live preview and the page editor

`/review` embeds the previewed app in an iframe and edits it in place. The preview is
served by the main `uidit` process, which injects its overlay; the injected overlay
cannot call this app's actions directly, so it asks its parent to relay each `/api/*`
call over `postMessage` and `useOverlayBridge` forwards it to the shared actions.

- The two halves must agree on an origin. The overlay only trusts a parent on its
  control port, so `ui.frameAncestors` in `.uidit/config.json` lists further loopback
  origins; those are emitted as `data-bridge` on the injected script and added to the
  floating-controls CSP. A workspace on another port without this entry will show
  "Connecting to preview…" forever — the overlay is running, but every message is dropped.
- The relay keeps the overlay's own route names (`/element`, `/comment`,
  `/comment-reply`, `/edit`) so an unrecognised route fails loudly instead of writing
  somewhere unexpected.
- An element pick writes through `tag-element`, which returns `{ element }` — the
  overlay replays that value when it confirms a selection.
- Edits preview live in the iframe and are recorded as `before → after`; they stay
  uncommitted until `mark-edit-applied`.

| Action | Use |
| --- | --- |
| `list-feedback` | Read elements, comments, and edits; unresolved queue by default, `includeResolved` for everything |
| `get-review-config` | Where the live preview is served, and which target it proxies |
| `add-comment` | Record user feedback against an element or the page |
| `update-comment` | Change a comment status and/or reply |
| `add-edit` | Propose a preview edit (uncommitted) |
| `mark-edit-applied` | Mark a proposed edit committed to source, or back |
| `tag-element` | Record an element picked in the live preview |
