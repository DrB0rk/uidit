<p align="center">
  <img src="docs/banner.svg" alt="uidit — local UI review dashboard" width="100%">
</p>

<p align="center">
  Click elements in your running app, comment on them, try edits.<br>
  Everything lands in <code>.uidit/</code> so a coding agent can pick it up.
</p>

---

## The problem

You are reviewing UI in a browser and your agent is in a terminal. You write
"the padding on this card looks off" in chat. The agent asks *which card*. You
describe the selector. You describe the text. Ten minutes later, one line of CSS.

uidit closes that gap. Your feedback is already structured data in the project.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/DrB0rk/uidit/HEAD/install.sh | sh
```

Needs Node 22+ and npm. The installer checks for both, installs the `uidit`
command, and verifies it runs before exiting. From a clone instead: `npm install -g .`

## Use

```sh
cd your-project
uidit          # starts package.json's dev script and the UIDIT review server
```

UIDIT recognizes npm, pnpm, yarn, and Bun from `package.json` and lockfiles. For
other projects, pass a command explicitly with `uidit -- cargo run`, or configure
`dev.command` in `.uidit/config.json`. UIDIT never runs install commands. Use
`uidit --attach http://127.0.0.1:3000` to connect without owning that server, or
`uidit --no-start` for manual discovery.

![uidit reviewing a running app](docs/screenshot.png)

## What you get

**Discover** enumerates every port actually listening, probes IPv4 and IPv6
loopback, and lists what answers with HTML. Any port works. uidit never picks a
target for you, because the lowest listening port is usually CUPS or a Docker
proxy, not your app.

**Tag** — click any element. uidit records a CSS selector, class-based fallbacks,
an ancestor chain, its text, and its relevant attributes.

**Comment** — on the element, or on the page as a whole.

**Design studio** — switch the live preview between desktop, tablet, and phone
viewports. Apply a few visual directions to a selected component, tune individual
style properties, and undo the preview styling when you are done. Upload or paste a
reference screenshot to compare it with the live page as an overlay or side by side.
Comments accept up to two pasted or uploaded reference photos.

The preview toolbar also supports custom viewport dimensions and one-, two-, or
three-pane responsive comparisons. These panes resize the browser viewport; they do
not emulate touch hardware or native mobile browser behavior. Component state
controls can temporarily focus or disable a selected element and restore it. App-owned
loading, error, empty, and success states need project fixtures and are not forced by
generic DOM manipulation.

**Quick edits** — edit text in place, set a CSS property, toggle a class, set an
attribute, hide an element. The change applies to the preview immediately and is
saved as an explicit `before → after` record.

**Live sync** — the dashboard holds an SSE connection. When an agent writes to
`.uidit/session.json`, the UI updates without a refresh.

**Team review** — create an invite-only review room from the Feedback sidebar. A
Cloudflare Worker Durable Object keeps the room state and relays live comments,
replies, progress, assignments, participant presence, and activity to the local
UIDIT session. Teammates join from the invite page; their comments and replies
sync back to the project. The owner token stays in `.uidit/runtime/` and the
Worker admin secret is used only to create a room.

**Interaction flows** — record clicks, form actions, and navigation from the
Flows panel, then replay them against the connected preview. Each step can keep a
masked page screenshot; passwords, email addresses, phone numbers, and payment
fields are omitted. Console and failed network requests are captured only while
a recording is active. Flow metadata and screenshots stay in the local
`.uidit/` folder. Export a saved flow as a Playwright test; recorded input
values are replaced with environment placeholders, and selector drift fails
with an explicit assertion.

**Agent tasks and visual review** — create a task from feedback, let an agent
claim it, attach test or screenshot evidence, and move it through implemented
and verified states. Only a reviewer can accept it. In **Agents → Visual task
review**, capture local baseline and candidate screenshots for a task; UIDIT
stores them under `.uidit/artifacts/` and displays them side by side. These are
review evidence, not an automatic visual pass.

Agents can submit allowlisted visual proposals for CSS, text, classes, and safe
accessibility attributes. Reviewers can preview and revert these in the live page;
approval records a request and never edits source files.

**Live browser context** — enable **Live browser inspection** in Agents settings
to share a bounded, redacted DOM snapshot and browser diagnostics with MCP.
Browser control is a separate permission and only allows a limited set of
actions against observed elements. Disable inspection to stop sharing page
context. The audit tool reports measured DOM checks separately from manual
review candidates; it does not claim full WCAG conformance.

**Durable anchors and source hints** — comments preserve their original element
anchor when markup changes. UIDIT may suggest a replacement, but ambiguous
matches require an explicit reattach. Source search is an inferred hint that
must be confirmed in code. Git context is read-only, and the impact view reports
only elements and routes observed in this review session.

### Cloudflare relay setup

The relay is a standalone Worker under `cloudflare/relay/`. It uses a SQLite
Durable Object for room state and hibernating WebSockets for low-overhead live
updates. Deploy it with Wrangler from the repository:

```sh
npm install
npm run relay:deploy
npx wrangler secret put ADMIN_SECRET --config cloudflare/relay/wrangler.toml
```

Set `ADMIN_SECRET` to a long random value (at least 24 characters), then paste
the Worker origin and secret into **Feedback → Team review**. For local relay
development, run `npm run relay:dev -- --var ADMIN_SECRET:replace-with-a-long-random-value`.
The relay stores comments and room membership in Cloudflare; do not share
invite links outside the intended review group. The invite is a bearer link.

## Any dev server

uidit proxies the page and injects the inspection overlay, so there is no plugin
to add and no change to your app. It handles what real stacks do:

- root-absolute asset URLs (`/@vite/client`, `/src/main.tsx`, hashed bundles)
- the app's own `/api/*` calls — uidit claims only its own routes
- chunked and compressed HTML
- `/` → `/app/` redirects, rewritten to stay inside the proxy
- IPv6-only binds, HMR websockets, CSP and `Set-Cookie` headers that would
  otherwise block the injected script

## For coding agents

Read `.uidit/session.json` before touching UI code. The schema and the rules are
in `.uidit/README.md`, written into every project that runs `uidit init`.

```jsonc
{
  "elements": [{ "id": "el-a1b2c3d4", "selector": "#main > article.card",
                 "ancestors": ["body", "main#main"], "text": "Checkout" }],
  "comments": [{ "id": "cm-9f2a1b0c", "elementId": "el-a1b2c3d4",
                 "text": "Padding is 12px here, 16px above.", "resolved": false }],
  "edits":    [{ "id": "ed-77ab12cd", "kind": "style", "property": "padding",
                 "before": "12px", "after": "16px", "applied": false }]
}
```

The two things worth knowing:

- **Open comments are the work queue.** `resolved: false`, oldest first.
- **`edits[]` are already approved.** The user saw the change happen in the
  preview and kept it. `applied: true` means *committed to source*, not *touched
  in the browser* — set it yourself once you have done the work.

Never delete a comment. They are the user's record of why something looks the way
it does.

Two commands help:

```sh
uidit status              # open feedback and pending edits, print only
uidit resolve [ids…]      # mark comments resolved (all open, if no ids)
uidit mcp info            # show the authenticated local MCP endpoint
uidit mcp stdio           # stdio bridge for MCP clients; UIDIT must be running
```

UIDIT exposes an authenticated, loopback-only Streamable HTTP MCP endpoint at
`http://127.0.0.1:7718/mcp` by default. Run `uidit mcp info` to obtain the project
token and connection details. The token is stored under `.uidit/runtime/` with
owner-only permissions; `.uidit/` is ignored by `uidit init`. MCP connections are
enabled by default, while agent writes and dev process control are disabled until
you enable them in the Agents panel or `.uidit/config.json`.

MCP clients can start with `uidit_get_agent_brief` for a bounded snapshot of open
feedback, linked elements, pending preview edits, current selection, and project
state. The `uidit_work_on_feedback` prompt packages that snapshot with a safe
review workflow; agents can also read the live `uidit://agent/brief` resource.
The brief includes heuristic triage suggestions, related groups, and possible
duplicates. `uidit_triage_feedback` returns these suggestions directly. Element
records include best-effort accessible names, roles, nearby text, and framework
component hints when the page exposes them. Comment threads can carry project
relative file and line references; use `uidit_link_code` to add one. Both agents
and reviewers can set feedback progress to `open`, `in_progress`, or `needs_info`;
resolution remains a separate completion action.
Tasks are separate from comment resolution: agents claim them with revision
checks, attach evidence, and report implementation and verification updates;
only the reviewer can accept a verified task. Additional MCP tools include
`uidit_get_live_dom`, `uidit_get_browser_diagnostics`,
`uidit_get_element_source`, `uidit_get_impact_graph`, `uidit_get_task_queue`,
`uidit_create_task`, `uidit_attach_evidence`, and
`uidit_propose_visual_change`. Use `uidit_export_flow_as_playwright` to generate
a test without exporting recorded form values.
Feedback is project data: agents should inspect source, ask questions in comment
threads when intent is unclear, report completed work in the thread, and resolve
feedback only after implementing and verifying it. Brief resource updates are
sent when the review session, selection, configuration, or dev process changes.

An `uidit` skill for agents is bundled in [`skills/uidit/`](skills/uidit/) —
copy it to `~/.omp/agent/skills/uidit` if your agent reads skills from there.

## Commands

| Command | Does |
| --- | --- |
| `uidit init` | create `.uidit/` in the current project |
| `uidit start [--port N]` | run the review UI and preview proxy (control port defaults to 7718) |
| `uidit -- <command...>` | launch an explicit project dev command |
| `uidit --attach <url>` | attach to a local server without stopping it |
| `uidit --no-start` | legacy manual discovery workflow |
| `uidit mcp info` | print local MCP connection details |
| `uidit mcp stdio` | bridge stdio MCP to a running local instance |
| `uidit status` | print open feedback and pending edits |
| `uidit resolve [ids…]` | resolve comments |
| `uidit build` | rebuild the dashboard UI |

Keyboard: `I` toggles inspection, `C` opens Feedback, `G` opens the workspace,
`Escape` closes the current panel, and `U` restores hidden in-page controls.

## How it works

```
your dev server :3000
        │
        │  preview proxy :7717, injects unprivileged overlay.js
        ▼
your browser ───── isolated control UI + REST/SSE + MCP :7718
                         │
                         └── .uidit/session.json  ◄── your agent
```

The preview runs on a separate loopback origin from the dashboard and MCP. The
injected overlay has no privileged token; it sends a narrow set of review actions
to the trusted dashboard using origin-checked `postMessage` and persists through
the control API.

### Layout

```
bin/uidit.js            CLI
src/server/server.js    HTTP: static assets, REST API, SSE, reverse proxy
src/server/store.js     .uidit read/write, and the agent-facing README
src/server/discover.js  finds listening dev servers (ss, dual-stack)
src/server/realtime.js  SSE hub + fs watcher on .uidit/
src/public/overlay.js   injected into the previewed page
dashboard/              Astro 7 + React island
```

The UI is an [Astro](https://astro.build) app. All data arrives at runtime over
`fetch` and `EventSource`; nothing is baked in at build time.

## Accessibility

The dashboard is built to WCAG 2.2 AA and checked against a real browser, not
assumed: every control has an accessible name, a 2px `:focus-visible` ring, and a
pointer target of at least 24px. Status is always paired with an icon and a label,
so colour is never the only signal. Tokens are `oklch()` throughout, and motion
respects `prefers-reduced-motion`.

## Development

```sh
npm install && npm link   # provides the `uidit` command from this clone
npm run build:dashboard   # build the UI (done automatically on first run)
npm test                  # unit, proxy, browser and cross-stack suites
```

### Preview compatibility checks

`npm test` starts real local dev servers and checks them in Chromium through the
UIDIT preview and overlay. The current matrix covers:

- Vite vanilla SPA, React 19, Vue 3, and Svelte 5 (including a React HMR update
  and an app-owned JSON API request)
- Astro 7 dev server with file-based routes
- Plain Node HTTP with an IPv6-only listener and chunked HTML responses

This exercises the local dev-server preview path, including root-relative assets,
route forwarding, the review overlay, and Vite's WebSocket HMR connection. It does
not claim production deployment or framework-specific server adapter coverage.

`npm test` runs 21 unit and proxy tests, a browser suite that drives the real
dashboard against a fixture dev server, and a cross-stack check that renders two
differently shaped servers — one IPv6-only with chunked HTML, one with a redirect,
a hashed bundle and its own API.

## License

[MIT](LICENSE)
