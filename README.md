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

**Quick edits** — edit text in place, set a CSS property, toggle a class, set an
attribute, hide an element. The change applies to the preview immediately and is
saved as an explicit `before → after` record.

**Live sync** — the dashboard holds an SSE connection. When an agent writes to
`.uidit/session.json`, the UI updates without a refresh.

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

`npm test` runs 21 unit and proxy tests, a browser suite that drives the real
dashboard against a fixture dev server, and a cross-stack check that renders two
differently shaped servers — one IPv6-only with chunked HTML, one with a redirect,
a hashed bundle and its own API.

## License

[MIT](LICENSE)
