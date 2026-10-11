---
name: uidit
description: Read and update a project's UI feedback captured by the `uidit` dashboard in `.uidit/`. Use this whenever the task involves UI, styling, layout, components, copy, or visual polish in a project that has a `.uidit/` folder — even if the user never says "uidit". Also use it when the user says things like "check my feedback", "what did I comment on", "fix what I flagged", "my notes in the dashboard", or asks you to resolve/apply UI feedback, or to record UI changes/decisions so they show up in their dashboard. Trigger it before writing UI code in any uidit-enabled project.
---

# uidit

The user runs their project's dev server and reviews the UI in a local dashboard
(`uidit`). Every element they click, comment they leave, and quick edit they try
lands in `.uidit/session.json` in the project root. That file is the conversation —
read it, and your work and their feedback stay in sync without them retyping things.

## Check first, then code

Before touching any UI code in a project that has `.uidit/`:

```bash
uidit status          # human-readable: open comments + pending edits
```

or read `.uidit/session.json` directly (add `| head -60` if it's large). `.uidit/README.md`
in the project documents the schema — read it if anything is unclear.

If this project exposes UIDIT MCP, begin with `uidit_get_agent_brief` or the
`uidit_work_on_feedback` prompt. The brief links each open comment to its tagged
element, includes pending preview edits and current selection, and can be filtered
with `focus`. Read `uidit://agent/brief` for the same live-updating context.

**Check `.uidit/` before you plan, not after.** A pending item there usually *is* the
task the user actually wants, phrased in their words. If they said "make this form
better" and there's an open comment "the labels jump when you tab through fields",
that comment is the spec.

## What the data means

| Field | Meaning |
| --- | --- |
| `comments[].resolved === false` | Open work, ordered by `createdAt`. The work queue. |
| `comments[].elementId` | Which tagged element it refers to; `null` means page-level. |
| `elements[].selector` | CSS selector to find it. `selectorAlternatives` are fallbacks. |
| `elements[].ancestors` | Tag/id chain — your anchor when the selector no longer matches. |
| `edits[]` | A change the user already tried in the browser and approved. Apply it in source. |
| `edits[].before` / `.after` | Live values when they made the change — `before` is a sanity check. |
| `edits[].applied` | `true` only after *you* committed the change to real source. |

`edits` are the highest-signal thing in the file. The user saw their change happen in
the preview and kept it — that is pre-approved work, not a suggestion to evaluate.

## Applying the work

1. Read open comments and pending edits before writing code.
2. For each, find the element by `selector`; if it no longer exists, say so explicitly
   and fall back to the nearest `ancestors` entry. Silently skipping feedback is the
   single most annoying failure mode here — the user can't tell the difference between
   "handled" and "ignored".
3. Make the change in **source**, not as an inline style in the dashboard. The dashboard
   is a preview; the repo is the product.
4. If MCP writes are enabled, reply in the comment thread with a question or concise
   completion summary using `uidit_reply_comment`. Mark preview edits applied only
   after source verification, and resolve comments only after the request is done.
   Without MCP, use the CLI/API workflow below.
5. Say what you did in terms of their feedback, not a file list.

Never delete comments. They're the user's history and they often reference the reason
behind a design decision.

## Recording your changes back

When you change UI on your own initiative — a layout fix, a component variant, a copy
change — tell the user they can review it in the dashboard, and make sure they can:
the change has to be visible in their running dev server for the dashboard to show it.
If you'd rather leave a note in the file itself, add a comment via the API:

```bash
curl -s -X POST http://127.0.0.1:7717/api/comment \
  -H 'content-type: application/json' \
  -d '{"elementId":null,"text":"Split the header into its own component."}'
```

That only works while `uidit` is running. Otherwise write the note into the project's
normal source comments — don't create a parallel convention.

## Starting the dashboard

The user usually runs this themselves. If they ask you to, or if `.uidit/` is missing
and they want the workflow available:

```bash
uidit init            # create .uidit/ in the current project (once)
uidit                 # dashboard on http://127.0.0.1:7717, auto-detects dev servers
```

`uidit` proxies their dev server and injects an inspection overlay, so it works with
any framework — no plugin, no component wrappers, no changes to their app.

## Scope boundaries

- Don't restyle from an `edits[]` entry you don't understand. Ask; the user is right there.
- Don't invent new feedback entries on their behalf to justify your own choices.
- `.uidit/` is gitignored by convention — it is local state, not something to commit
  unless they ask.
