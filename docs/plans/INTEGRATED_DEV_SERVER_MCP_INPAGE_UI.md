# UIDIT: single-command dev server, in-page controls, and local MCP

**Status:** Implemented baseline in UIDIT 0.3.0; protocol interoperability and full acceptance coverage remain open
**Date:** 2026-10-11  
**Target:** DrB0rk/uidit (master)  
**Design principle:** One UIDIT command starts the chosen application dev server; the application itself is the review surface; humans and coding agents share one real-time state.

## Executive decision

Extend UIDIT with (1) a framework-independent **managed process supervisor**, (2) an **in-page floating control plus slide-out review panel**, and (3) a **local Model Context Protocol (MCP) server**. Retain the existing reverse proxy and feedback store instead of embedding Vite, npm, or any other framework runtime.

Expected first-run journey:

~~~text
$ cd my-project
$ uidit
uidit  starting: pnpm dev
app    ready: http://127.0.0.1:5173/
review http://127.0.0.1:7718/
mcp    available locally
~~~

Open the review URL: the **site fills the entire page**. A compact floating UIDIT button opens an action popover. The popover opens an optional right-side management drawer. The ordinary site remains usable when inspection mode is off.

This document records the target design and implementation status. The launcher, split-origin preview/control service, in-page controls, shared review state, and authenticated local MCP server are implemented. The official npm MCP SDK currently resolves to 1.32.1 (there is no published v2 package), so 2026 protocol-version negotiation and `subscriptions/listen` compatibility are not claimed by this release. The expanded browser, security, and legacy/modern-client acceptance matrix also remains to be completed.

### UIDIT 0.3.0 implementation status

- **Implemented:** detected/explicit dev commands, managed and attached process modes, project runtime lock, two loopback origins, preview overlay and isolated floating controls, mockup-inspired full-screen workspace and six drawer sections, feedback/element/edit persistence, live browser state, authenticated HTTP MCP plus stdio bridge, resources/tools, optional agent write/process-control permissions, and configuration migration.
- **Implemented with limits:** session revisioning and filesystem reconciliation are in place, but not a durable event log with replay/sequence IDs; MCP resource updates use the available SDK 1.x subscription model.
- **Open:** MCP 2026-07-28 and legacy-client interoperability verification, per-client token/revocation management, comprehensive hostile-origin and cross-stack acceptance coverage, and broader non-Node launch command discovery.

## Repository audit: what exists today

Inspected files in master:

| File | Relevant behavior | Proposed change |
|---|---|---|
| bin/uidit.js | Default command starts dashboard, discovers running targets, instructs users to start a dev server separately | Command resolution, project process supervisor, attach mode, CLI help, lifecycle and MCP connection commands |
| src/server/server.js | HTTP dashboard, injected HTML, reverse proxy, partial HMR upgrade forwarding and REST routes | Separate preview and privileged control origins, safer routing, proxy and overlay injection, lifecycle endpoints |
| src/server/discover.js | Enumerates ports with ss, probes HTML and loopback | Only fallback for attached/external servers, portability and probe fixes |
| src/server/store.js | .uidit/config.json and .uidit/session.json; atomic writes and comments/edits | Config migration, revisioned event source, serialized mutations, richer feedback metadata |
| src/server/realtime.js | Filesystem watcher and SSE broadcast to dashboard | Shared event bus for browser, CLI and MCP updates; replay and sequence IDs |
| src/public/overlay.js | Selectors, inspection, edits, postMessage to dashboard | Browser-side inspection bridge; mount separate-origin floating UI rather than growing app-script privileges |
| dashboard/src/components/Sidebar.jsx | Existing selected-element controls, feedback, elements, edits, markdown export | Reuse domain actions in drawer; avoid rewriting feedback behavior |
| dashboard/src/components/Dashboard.jsx | Iframe preview and always-visible sidebar | Keep as optional advanced/legacy workspace, not the primary UI |
| dashboard/src/styles/tokens.css | Dark neutral surfaces with muted violet accent, 4/8/12px spacing | Reuse visual system in isolated floating UI; host site colors must not be changed |
| dashboard/src/state/useSession.js | Fetch + EventSource | Shared typed client and event subscriptions |
| test/e2e.js and test/stacks.js | Browser/cross-stack coverage | Expand for managed process, embedded UI, MCP and isolation |

Specific cleanup surfaced by audit:

- Existing project README expects two terminals (npm run dev, then uidit); update usage after implementation.
- Existing UIDIT REST URLs take some application routes under /api, including /api/comment; this conflicts with legitimate application URLs. Namespace control routes.
- The HMR upgrade implementation uses an HTTP upstream and hostname without the same loopback resolution and HTTPS handling as ordinary requests. Make upgrade handling protocol-aware; test ws/wss and IPv6.
- The discovery helper probeEitherHost uses Promise.any over booleans resolved by each probe; a false result can count as success. Return an actual successful host or null, not the first fulfilled boolean. Support machines without ss.
- e2e.js and stacks.js contain a hardcoded /home/drb0rk/Projects/uidit path; derive repo path from import.meta.url.
- store.js currently treats a malformed session file as an empty session. Report and preserve corrupted state instead of silently replacing it during a write.
- Clarify that edit.applied means **committed into source**, never merely previewed. Existing comments/documentation mix these semantics.
- The current server and overlay are on a shared origin. **Do not expose a process-control or privileged MCP endpoint to JavaScript running in the previewed app.** This is a security requirement, not merely a UI preference.

## Universal launcher: command contract

### CLI surface

~~~sh
uidit                          # default: detect and launch project's dev command
uidit -- pnpm run dev           # explicit command; -- separates uidit flags
uidit -- bun run dev
uidit -- python -m http.server 8000
uidit -- cargo run
uidit --cmd "my-dev-command"    # shell syntax requires explicit opt-in / confirmation
uidit --attach http://127.0.0.1:4321  # connect to already running target; do NOT own it
uidit --no-start               # existing discover/manual-connect behavior
uidit start --port 7718        # compatibility control/dashboard port
uidit status                   # existing feedback summary + server status
uidit dev status|start|stop|restart|logs
uidit mcp info                 # endpoint, transport and copyable client config
uidit mcp stdio                # stdio bridge to already-running local instance
uidit init                     # create .uidit without clobbering existing data
~~~

Use a documented flag parser; don't treat an arbitrary number anywhere in argv as the UI port. Explicit arguments always override saved settings. Legacy modes remain available.

### Resolution precedence

1. Explicit args after -- (preserve argv and CWD; spawn with shell:false).
2. The project's explicit .uidit/config.json dev.command and dev.cwd.
3. A recognized project manifest's development entry: for Node projects use package.json scripts.dev, then packageManager and lockfile to select npm/pnpm/yarn/Bun. An explicit packageManager field wins over lockfile guesses. Support workspaces and the nearest project package.
4. Clearly identified conventional commands for other ecosystems only if safe and unambiguous, or ask for the command once and save it. Do **not** pretend a universal static lookup can reliably detect every Python/Go/Rust/.NET stack.
5. Attach/discovery/manual URL when a start command is unknown.

Recognize a configured command as project code with the same trust level as manually running that command. Never use a shell by default, execute install steps automatically, modify framework config, or choose an unrelated port just because it responds with HTML. In ambiguous cases show the detected options; remember the explicit user selection.

### Process supervisor

New src/server/process-manager.js and src/server/command-resolver.js should:

- Spawn the chosen process with correct cwd, environment, stdio, Windows/POSIX behavior, quoting and signal propagation.
- Own **only** the child process tree it launched. An attached target is never stopped or restarted.
- Report states: idle, detecting, starting, ready, stopping, stopped, crashed, attached, and error.
- Discover the actual upstream URL from explicit config, reliable stdout patterns and/or readiness probes. Do not assume a default port; support HTTPS and redirects. If multiple URLs appear, prefer a configured URL then ask the user.
- Wait for an actual HTTP readiness response; use bounded timeouts and an actionable failure screen (retry, edit command, attach URL, view logs).
- Maintain a bounded log ring with timestamps, stdout/stderr distinction and secret-redaction patterns. Never save complete environment or credentials.
- Handle Ctrl+C, SIGTERM and broken parents: send graceful signal first, escalate only for the process tree UIDIT owns. Make shutdown idempotent.
- Support manual restart, optional on-crash restart policy, command edits and simultaneous project instances via a robust per-project lock.
- Leave application HMR to the original dev server; UIDIT must not become a framework-specific bundler.

### Proposed config

Additive and migration-safe from existing version 1. **Illustrative**, final schema must be validated and versioned:

~~~json
{
  "version": 2,
  "dashboardPort": 7718,
  "controlPort": 7718,
  "previewPort": 7717,
  "targetUrl": null,
  "dev": {
    "command": ["pnpm", "dev"],
    "cwd": ".",
    "url": null,
    "autoStart": true,
    "restartOnCrash": false
  },
  "ui": {
    "position": "bottom-right",
    "defaultOpen": false,
    "inspectionDefault": false
  },
  "mcp": {
    "enabled": true,
    "allowAgentWrites": false,
    "allowAgentServerControl": false
  }
}
~~~

Never place bearer tokens, cookies or machine secrets in committed project config. Store runtime auth securely in per-user local config / ephemeral protected storage (0600 where applicable). UIDIT's generated project .uidit files must be ignored by default or be safe to commit; provide a gitignore helper.

## Network and isolation architecture

~~~text
                    one command: uidit
                           |
        +------------------+--------------------+
        |                  |                    |
  command supervisor  preview reverse proxy  local control plane
  runs project dev     127.0.0.1:7717         127.0.0.1:7718
  server on ANY port       |                    |
        ^                 |              +-----+-------------+
        |                 |              |                   |
        +--- HTTP / WS ---+      isolated UI iframe      MCP endpoint
                          |       + REST + UI events       /mcp
                    real app page       |                   |
                    with inspector      |              coding agents
                    bridge + button ----+              
                                    shared domain services
                                            |
                                    .uidit/session.json
                                    .uidit/config.json
                                    bounded runtime log
~~~

There are **two internal local HTTP listeners but only one top-level UIDIT command**. The preview runs the application's unmodified JS at :7717. The privileged UI, process-management API and MCP listen on separate origin :7718. This separation matters because even trusted-looking frontends can run untrusted dependencies. Do not put privileged credentials or unrestricted admin REST routes into the preview origin.

- Proxy only application pages/assets/API/websockets at :7717, plus a narrowly reserved, non-privileged UIDIT bootstrap route.
- Inject a minimal inspector bridge into HTML. The floating UX is rendered in a **cross-origin iframe**, visually contained in a small anchored window (button/popover/drawer) so host scripts cannot read credentials or event handlers. The iframe expands only when needed, and its pointer region never blocks the whole page while closed.
- Validate postMessage origin, source window, message schema and capability. Treat DOM descriptions arriving from an app page as untrusted data.
- Keep proxy operations compatible with base paths, query strings, HTML responses, redirects, compressed bodies, Content Security Policy, streamed assets, OAuth callbacks, cookies, IPv4/IPv6, HTTP/HTTPS and ws/wss. Do not unnecessarily strip upstream CSP globally; document any dev-only compatibility exceptions.
- Serve the existing full dashboard as an optional advanced view from the **trusted** control origin. Migrate existing API and overlay consumers with compatibility tests.
- Control and MCP bind loopback only by default. Explicit external exposure is a separate future design, never a side effect of --host 0.0.0.0 in the target app.

## In-page UX design

### Closed / neutral state

A 40–44px circular UIDIT mark with a subtle unread-feedback indicator sits near the bottom-right edge, 16–24px from the viewport safe area. It must not take away pointer events elsewhere, should be draggable or relocatable, have a hide option and avoid clashing with application chat widgets. No persistent toolbar, browser chrome or sidebar.

Inspect mode is **OFF** by default, so app links/buttons continue to work. Show a label/tooltip or screen-reader name. Keyboard can open the menu; Escape closes it; motion respects prefers-reduced-motion.

### Small anchored action popover

- **Inspect element** — toggles target highlighting, selection and click interception only while active.
- **Comment on page** — opens a small composer without forcing selection.
- **Quick edit** — starts the existing text/style editing workflow for a selected element.
- **Open workspace** — slides out the full drawer.
- **Development server** — small status line with controls for owned process: restart, stop, logs; attached server shows disconnect instead.
- **Hide controls** — reversible shortcut / URL switch.

Provide a direct feedback action even while nothing is selected. Show a badge for unresolved comments, and a connection indicator when the local agent MCP has clients.

### Right slide-out drawer

Resizable at desktop: 420px by default, dragged between 320px and 760px from its left edge (arrow keys and Home/End on the focused separator, width remembered per browser) while at least 360px of preview stays visible; adaptive mobile full-width sheet without a resizer. App remains visible and can be interacted with while drawer is open.

Sections / tabs:

1. **Feedback:** open/resolved comments, page/element context, filter, search, reopen/resolve, add and edit notes, copy feedback Markdown. Keep historical comments by default.
2. **Inspect:** current element selector, ancestry, text, attributes, selection highlight, live edit controls, copy selector, navigate-to-element.
3. **Changes:** preview-only vs applied-to-source status, before/after, provenance, user approval, agent acknowledgements.
4. **Server:** running command, upstream URL, start/restart/stop, tail logs, readiness, attached vs managed status.
5. **Settings / Agents:** keyboard shortcuts, badge placement, theme, dev-command picker, MCP status/connected clients, access controls and copy setup instructions.

Reuse current UIDIT dark neutral, restrained violet, borders, typography and tokens. Unlike a permanent dashboard split, the page is the hero. Use focus containment only for genuinely modal subflows; keep the nonmodal drawer accessible. All actions need labels, keyboard support, visible focus, and meaningful loading/failure states.

### Interactions and persistence

Opening/closing the menu or drawer is local UI state. Comments, tags, edits, agent acknowledgements and application server status are shared, real-time state. UI and MCP changes must land in **the same service layer** and emit a single authoritative update. Changing browser selection should emit a short-lived selection event without writing excessive hover events into session.json.

## Built-in local MCP: agent API

This is part of the initial implementation, not a separate optional future feature. Support **MCP 2026-07-28** and compatibility with **2025-era clients**, using the current official TypeScript SDK v2. The 2026 protocol's realtime change feed uses opt-in **subscriptions/listen**; 2025 clients use their earlier resource update subscription/notification model as supported by the SDK. MCP is not ordinary polling and is not the same as UIDIT's browser SSE.

Suggested endpoint (control origin only):

~~~text
http://127.0.0.1:7718/mcp
~~~

Transport choices:
- **Streamable HTTP** to the long-running UIDIT instance for local clients supporting HTTP. Use the SDK's supported Node adapter; negotiate legacy and modern MCP versions.
- **stdio bridge** via uidit mcp stdio for clients that only understand stdio. This process connects to the existing UIDIT runtime; it must not launch a second unmanaged dev server or occupy the same ports.
- Local connection metadata and ready-to-copy snippets from uidit mcp info. Do not silently edit external agent configurations.

Expose structured and validated MCP tools. Names are illustrative:

| Tool | Behavior |
|---|---|
| uidit_get_context | Project identity, active page, target, selected element, counts, capabilities and revision |
| uidit_list_feedback | Filter/paginate comments by open/resolved, page, element, time |
| uidit_add_comment | Create element-bound or page-level comment with source=agent |
| uidit_update_comment | Resolve/reopen/update comment with expected revision |
| uidit_list_elements | Selected/tagged elements, selectors, fallbacks and metadata |
| uidit_select_element | Highlight an element in the live browser and focus it if a UI is connected |
| uidit_list_edits | Read recorded quick edits with before/after and source-applied status |
| uidit_mark_edit_applied | Mark as source-applied only after the agent actually edits/verifies source; record provenance |
| uidit_get_dev_status | PID (owned only), command, URL, ready state, recent error |
| uidit_get_dev_logs | Bounded lines/offsets, redacted output |
| uidit_restart_dev | Optional privileged operation, restricted to UIDIT-owned process |
| uidit_get_config | Safe, non-secret config snapshot |
| uidit_set_config | Validated allowlisted settings; command changes require explicit permission |

Useful read-only resources:

~~~text
uidit://project/context
uidit://session
uidit://feedback/open
uidit://elements/selected
uidit://edits/pending
uidit://dev/status
uidit://dev/logs
~~~

Serve resources with monotonic revision/sequence info. Send MCP resource-updated notifications to subscribed modern and legacy clients according to their respective protocol semantics; clients re-read changed resources. Publish updates **immediately after a committed mutation** through one in-process event bus, rather than waiting for a filesystem polling loop. For changes directly written by a coding agent to .uidit/session.json, retain the fs watcher as compatibility input; de-bounce/coalesce external writes, reconcile revisions and never lose agent changes. Provide browser event streams and MCP notifications from the same canonical events.

Optional prompt template: review_open_feedback — summarizes current open review tasks and approved edits without inventing implementation results. MCP tool output includes stable IDs, structuredContent where supported, and version-safe, small payloads. Large lists paginate; don't resend the entire session for each mousemove.

**Permissions:** read-only operations enabled by default, writing feedback may be user-enabled at first connect, source-applied markers restricted, and dev-server control **disabled for MCP by default** unless explicitly authorized. Provide per-client status and revoke/disconnect in the drawer. Process spawning/arbitrary shell execution must never be exposed as an unrestricted agent tool.

### Agent configuration concept

~~~json
{
  "mcpServers": {
    "uidit": {
      "command": "uidit",
      "args": ["mcp", "stdio"]
    }
  }
}
~~~

This is a generic example, **not** a claim that every agent uses exactly this schema. Provide adapters/instructions for each tested host (OMP, Claude Code, Cursor, VS Code and other MCP clients). Document how to locate the active project instance and how to distinguish multiple UIDIT processes. Prefer a per-project runtime registry over guessing ports.

## Security requirements (release blockers)

- Preserve the trust boundary between **untrusted previewed application JavaScript** and privileged UIDIT APIs/MCP/process controls by separate origins and an isolated UI iframe.
- Bind MCP/control to 127.0.0.1 or ::1 by default, validate Host and Origin (DNS rebinding prevention), authenticate every privileged call, validate Content-Type/CSRF where relevant, use capability-scoped tokens and avoid permissive CORS. Separate browser-auth and agent-auth mechanisms.
- Local means local, **not** inherently trustworthy: browser tabs and other local processes can try to reach localhost. Default least privilege, request limits, audit logs, access revocation and no command execution from an untrusted HTTP request.
- Project code and package scripts are potentially untrusted; only start inside an explicitly selected/trusted project directory. Display what will execute.
- Treat project-sourced text (DOM, comments, logs and application responses) as untrusted content in MCP resources, so it is not promoted into agent instructions.
- Never expose environment variables, API keys, bearer tokens, full process command secrets or arbitrary filesystem content.
- Confirm the MCP SDK v2 release's Node engine requirements before updating the package. The existing package specifies Node >=18, which is end-of-life; target a supported Node LTS (22 or 24), document the breaking change and test both.
- Use official MCP SDK handlers/adapters rather than writing ad hoc JSON-RPC. Verify protocol legacy negotiation, Host/Origin protections, authentication and subscription semantics with interoperability tests.

## Proposed modules and API structure

~~~text
bin/uidit.js
src/server/
  command-resolver.js       # manifest/package manager, explicit command
  process-manager.js        # spawn, lifecycle, log ring, cleanup
  runtime.js                # per-project single owner / lock / shared state
  events.js                 # revisioned domain event bus
  store.js                  # config/session migration, serialized commits
  server.js                 # preview proxy and control server wiring
  proxy.js                  # HTTP/websocket/redirect rewriting
  control-api.js            # trusted browser operations
  mcp/
    server.js               # official SDK v2 tools, resources, subscriptions
    stdio-bridge.js         # bridge to existing local instance
    permissions.js          # capabilities and authentication
src/public/
  overlay.js                # slim inspect/selection bridge
  bootstrap.js              # mount isolated floating iframe
dashboard/src/
  components/FloatingControl.jsx
  components/ActionMenu.jsx
  components/ReviewDrawer.jsx
  components/ServerControls.jsx
  components/AgentsPanel.jsx
  state/useSession.js
  styles/tokens.css
docs/
  plans/INTEGRATED_DEV_SERVER_MCP_INPAGE_UI.md
~~~

Use one testable domain layer for both REST and MCP tool handlers; don't duplicate storage mutations. Preserve old config/session migration and compatibility whenever feasible.

## Required acceptance tests

**Single command:** In clean fixtures, uidit launches a package.json dev script using npm, pnpm, yarn and Bun as available; an explicit non-Node command works; actual readiness URL is used; one Ctrl+C cleans up the owned process and leaves attached processes alone; restart and crash diagnostics work.

**Proxy compatibility:** End-to-end coverage for Astro/Vite, React, Next.js and a non-JS HTTP server; root-absolute assets, API calls, redirects, HTML injection, nested routes, websocket HMR, IPv6-only bind, local HTTPS/wss, cookies and CSP behavior. The app's own /api/comment and similar names must keep working.

**Embedded UI:** With inspection OFF, app buttons still work. Floating button -> popover -> drawer are fully interactive. Selection, page comments, quick edits, resolve/reopen, agents status and dev controls all use the same persisted backend. Escape, keyboard, screen-reader names, reduced motion and mobile viewports are exercised.

**MCP:** At least one modern 2026-07-28 client and one legacy 2025 client connect. Tools/resources return correct structured data. An agent creating/resolving feedback updates the browser immediately. A user adding feedback triggers subscribed MCP resource updates; an agent can request current state after notification. Reconnect has a snapshot fallback. External session.json edits propagate. stdio bridge reaches running instance without duplicate launch.

**Security:** A hostile script in previewed app cannot read privileged auth material, call dev start/stop, read private MCP resources or mutate comments without authorization; malicious Host/Origin rejected; default MCP dev control denied; tokens never emitted in logs; attached targets cannot be killed by UIDIT.

**Reliability:** File-write collisions, malformed sessions, log bursts, invalid config, dead servers, lingering child trees, crashes, multiple projects, stale pidfiles and occupied ports have deterministic handling. Fix existing absolute paths in test suites and discovery false-positive behavior before asserting portability.

## Build sequence / workstreams

1. **Runtime foundation:** process supervisor + detector, config migration, lifecycle tests. Keep existing dashboard working.
2. **Isolation and proxy:** explicit preview/control origins, reserved route migration, secure message bridge, HTTP/HMR compatibility.
3. **Embedded UX:** Shadow DOM/iframe mount, floating action menu, contextual drawer, feedback and editing reuse, responsive/a11y checks.
4. **Shared event layer:** revisioned store and event notifications for REST, browser and file watcher.
5. **MCP integration:** official SDK, Streamable HTTP + stdio, tools/resources, live subscriptions, per-client permissions, agent setup.
6. **Release readiness:** browser/multi-stack/MCP/security tests, docs/README/CLI examples, migration, supported Node LTS, packaging of built UI assets.

The workstreams should converge before calling the feature complete: the end goal is a single, coherent default workflow, not two unrelated optional products.

## Definition of done

- In an ordinary supported project, **cd project && uidit** is sufficient.
- The user opens the served site and sees only a small UIDIT button until they choose otherwise.
- The button opens a minimal action popover; a slide-out drawer handles comments, quick edits, server configuration and connected agents.
- Framework, package manager and custom-command independence is demonstrable, not merely described.
- Agents can discover the live review context over local MCP, operate on feedback, and receive protocol-correct push notifications with no polling; user interaction and agent changes stay in sync.
- Privileged control functions are isolated from the preview page and bound to authorized local users/agents.
- Existing sessions and explicit attached-server usage remain supported.
- Documentation, install instructions, tests and README reflect the new default workflow.

## Upstream protocol/reference materials

- MCP specification (released 2026-07-28): https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Official TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- MCP protocol-version compatibility: https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
- SDK HTTP handler and subscriptions: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/createMcpHandler.html
- Node.js supported release schedule: https://github.com/nodejs/Release

Document authored from repository source inspection. No change to live UIDIT runtime is implied by committing this planning file.
