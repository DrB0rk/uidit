# uidit

Local UI review dashboard for the project you're working on. Point it at your running
dev server, click elements in the live page, leave comments, and try quick edits — all
of it lands in `.uidit/` in your repo so a coding agent can pick the feedback up without
you retyping it.

```
uidit init     # once, creates .uidit/
npm run dev     # your project's dev server, in another terminal
uidit          # start the dashboard, auto-detects local dev servers
```

Then open <http://127.0.0.1:7717>.

## What it does

- **Discover** — scans common dev-server ports (3000, 5173, 8080, …) and offers them,
  or paste a URL manually. The page is proxied through uidit so the inspection overlay
  can be injected into *any* framework, not just one with a plugin.
- **Tag** — click any element. uidit stores a CSS selector, class-based fallbacks, an
  ancestor chain, trimmed text, and the relevant attributes.
- **Comment** — page-level or attached to a selected element.
- **Quick edits** — edit text in place, apply a CSS property, toggle a class, set an
  attribute, or remove an element. Changes apply to the preview immediately and are
  recorded as explicit before → after edits for the agent to implement in source.
- **Live sync** — the dashboard subscribes to an SSE stream. Feedback resolved by an
  agent writing `.uidit/session.json` appears in the UI immediately.

## For coding agents

Read `.uidit/session.json` (schema and rules in `.uidit/README.md`) before touching UI
code. Open comments are the work queue; every `edits[]` entry is a change the user
already approved. `applied: true` means "done in source", not "touched in the browser".

CLI helpers for agents:

```
uidit status              # open feedback + pending edits, print only
uidit resolve [ids…]      # mark comments resolved (all open when no ids given)
```

## Commands

| Command | Purpose |
| --- | --- |
| `uidit init` | create `.uidit/` in the current project |
| `uidit start [port]` | run the dashboard (default 7717), discovers dev servers |
| `uidit status` | print open feedback and pending edits |
| `uidit resolve [ids…]` | resolve comments |
| `uidit build` | rebuild the dashboard UI |

## Architecture

```
bin/uidit.js            CLI
src/server/server.js    HTTP: dashboard static assets, REST API, SSE, reverse proxy
src/server/store.js     .uidit read/write + the agent-facing README
src/server/discover.js  local dev-server discovery
src/server/realtime.js  SSE hub + fs watcher on .uidit/
src/public/overlay.js   injected into the previewed page (select / comment / edit)
dashboard/              Astro 7 app, React island, built to dashboard/dist
```

The dashboard UI is an [Astro](https://astro.build) app; all runtime data comes from
the uidit server over `fetch` + `EventSource`, so nothing is baked at build time.

## Install

```
npm install && npm link     # provides the `uidit` command
npm test                    # end-to-end browser test (Playwright)
```