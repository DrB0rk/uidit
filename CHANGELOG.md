# Changelog

## 0.10.7 — 2026-10-22

- Overhauled the curl installer with numbered progress, visible download progress,
  release and runtime version details, exact installed-version verification, and
  actionable PATH and failure messages. It falls back from a missing release
  asset to the matching GitHub source archive.
- Kept installer and release version pins aligned at v0.10.7.

## 0.10.6 — 2026-10-22

- Added a local live browser activity view for MCP-driven actions. The preview
  shows an isolated cursor and target outline while an authorized action runs;
  Agents shows only bounded action/status metadata. Values, selectors, URLs,
  page text, and browser exception output are excluded.
- Kept browser inspection and browser control as separate opt-ins. Revoking a
  relevant permission clears pending live work rather than leaving a stale
  cursor or action state.

## 0.10.5 — 2026-10-22

- Rebuilt the hosted team review page as a compact UIDIT workspace with Review, Design, Runtime, and Project panels. Reviewers can inspect the HTML snapshot, pin feedback, reply, edit or delete their own comments, manage status and assignment, add reference photos, and view shared changes and activity.
- Team links now appear immediately while HTML capture runs in the background. Snapshot assets are fetched concurrently, and capture status is visible in the local dashboard.
- Store relay snapshots and sessions in bounded SQLite chunks so large snapshots fit safely and ordinary collaboration updates do not rewrite the HTML payload.

## 0.10.4 — 2026-10-21

- Team review links now share a self-contained, sanitized HTML snapshot instead of exposing a live preview through a tunnel. Reviewers can inspect elements, pin feedback, reply, and delete their own comments; owners can stop sharing completely.
- Fixed collaboration comment deletion so removed feedback stays removed, and added editing/deleting comments from the local dashboard context menu.
- Improved comment and drawing placement, dragging, undo, and Escape handling across the dashboard and preview.
- Grouped workspace sections into Review, Design, Runtime, and Project; updated the default control port to 12321 with fallback 32123.
- Updated the UIDIT agent skill and made release installation use the public GitHub tarball/source only.

## 0.10.3 — 2026-10-21

- Removed GitHub Packages publishing and authentication paths. Installs now come directly from GitHub release assets, with a GitHub source archive fallback.

## 0.10.2 — 2026-10-21

- Added a public install tarball to each GitHub release. The installer now uses that anonymous download by default, with authenticated GitHub Packages installation as an option.
- The release workflow attaches the tarball after the build and test suite pass, then publishes the scoped npm package.

## 0.10.1 — 2026-10-21

- Published the scoped `@drb0rk/uidit` package to GitHub Packages and added a release workflow that runs the build and full test suite before publishing.
- Updated the installer to install the exact release from GitHub Packages when authenticated, or fall back to the matching GitHub source tag. It accepts a classic PAT through `GH_PACKAGES_TOKEN` without writing credentials to the user's npm config.

## 0.10.0 — 2026-10-21

- Inspect is now a toggleable tool: the first click selects an element, a second click edits its text in place, and Escape ends the active tool without closing the workspace.
- The review workspace opens by default with a branded loading state, a UIDIT mark, and a smoother preview frame. Dragging the floating control no longer triggers the page scrollbar.
- Dashboard panels load on demand, reducing the initial dashboard bundle. Feedback triage now bounds duplicate comparisons and suggestions for large queues and reports when results are partial.
- Updated the UIDIT agent skill with a clearer workflow for locating page code, claiming tasks, attaching evidence, and verifying changes.

## 0.9.1 — 2026-10-13

- Keyboard shortcuts now work wherever focus is: the panel, the previewed page, and the floating control. `I`, `C`, `G`, `Escape` and `U` all reach the same actions from any of them, so reviewing the page no longer requires clicking back into the panel first.
- `Escape` clears what is in front of it before closing the panel: a selection, drawing or open menu goes first, then the next press closes the panel. Inside a field it leaves the field, and letters typed into page or panel fields are never read as shortcuts.
- The control's key hints match reality again (inspection is `I`, not `1`), and the browser suite now covers the shortcuts from the panel, the preview and the floating control.
- Fixed the overlay measuring itself: page size came from `documentElement.scrollWidth`, which includes the overlay's own layers, so the visuals layer grew on every render and page notes and drawings were normalized against an inflated width. Overlay geometry and stored anchors now measure the app body.

## 0.9.0 — 2026-10-13

- Every workspace section is visible at once: Feedback, Design, Elements, Changes, Flows, Server, Agents and Settings sit in one grid, each one click away. The "More" dropdown that hid half of them is gone.
- The panel no longer pins a full connection bar above every section. While reviewing it keeps a short strip (Reload, Inspect, Text, JSON); the target field, Connect and Discover moved into the Server section, next to the dev process and services they belong with.
- The duplicated server-state line folded into the footer, which now carries the server state on the left and the session state on the right. Panel chrome drops from 306px to 250px, giving section content about 94px more height, and the browser suite asserts that all eight sections are reachable without a menu.

## 0.8.4 — 2026-10-13

- Removed the 1 / 2 / 3 view selector: the preview is a single live frame again, and the device toolbar keeps Desktop, Tablet, Phone and Custom sizes.
- Dropped the multi-pane layout, its per-pane labels and the viewport-layout state from the dashboard and its stylesheet, and the browser suite now asserts one preview instead of two and three panes.

## 0.8.3 — 2026-10-13

- The review panel is resizable: drag its left edge, or focus that edge and use ArrowLeft/ArrowRight (Home and End jump to the limits). It stays between 320px and 760px, keeps at least 360px of preview on smaller windows, and remembers the width per browser.
- The edge is an accessible separator (`role="separator"`, `aria-valuenow`/`min`/`max`, keyboard-operable) with an 11px grab area around its 1px rule, and the pointer keeps resizing even across the preview frame.
- The preview, the device toolbar and the start screen all follow the panel width. Below 400px the workspace tabs become icon-only so their labels never truncate, and the header caption clips to one line. Small screens keep the full-width sheet without a resizer.

## 0.8.2 — 2026-10-13

- The in-page button now follows the pointer while you drag it, and stays exactly where you drop it. The old model moved nothing until release and then snapped to one of nine viewport cells, which could park the button (and the panel under it) somewhere you did not ask for.
- The panel opens in the room beside the button, narrowing and switching sides where the preview is tight, so it always lands fully inside the viewport instead of being clipped at the bottom or forcing a scrollbar.
- The button is no longer clipped by its own frame while idle, and the floating rows no longer inherit a link underline.

## 0.8.1 — 2026-10-13

- Simplified the in-page quick actions: one-line rows instead of label-plus-hint pairs, a compact icon strip for the four drawing tools, and the live server state in the header instead of a subtitle. The menu is 358px tall where it used to be capped at 585px and scroll.
- Replaced the popup's 68px-blur shadow with a tight 12px one and reserved room for it on the leading edge. The floating control iframe clips anything wider than its own box, so the old shadow was cut off into a visible dark band around the menu.

## 0.8.0 — 2026-10-13

- The desktop preview now fills the review area beside the drawer instead of a fixed 1280 × 800 box, so the app renders at the window's real CSS width and wide screens no longer show a small preview floating in a gray field. The rounded frame, shadow, and outline stay, and tablet, phone, and custom viewports keep their exact device sizes.
- Added an Oh My Pi plugin surface to the package: `omp/extension.js` registers the `uidit_feedback` tool and `/uidit` command, which read `.uidit/` review state without a running dashboard; `mcp.json` declares the local MCP bridge; and the bundled `skills/uidit` installs with the plugin. `omp plugin install /path/to/uidit` wires all three.
- `uidit mcp stdio` now reports that no instance answered, instead of an empty Streamable HTTP error.

## 0.7.1 — 2026-10-12

- Refreshed the README example UI and added a screenshot gallery for every workspace section.
- Updated the documented feature, collaboration security, service workspace, and test-suite details for 0.7.0.

## 0.7.0 — 2026-10-11

- Added project-scoped multi-service management with dependency-aware start/stop, separate logs, isolated process ownership, and preview switching.
- Added selective HMR verification that checks linked anchors on the observed route and labels results as evidence rather than visual approval.
- Added browser-flow assertions for visibility, text, enabled state, and routes, with Playwright export that flags selector drift.
- Added reversible app-provided component state fixtures for loading, error, empty, success, open, closed, and selected states.
- Hardened remote reviews with seven-day invite expiry, owner-only session rotation, disconnect-on-revoke, comment-only reviewer permissions, explicit exposure acknowledgement, and visible activity history.
- Expanded E2E and unit coverage for service lifecycle, HMR evidence, flow assertions, state fixtures, and responsive workspace behavior.

## 0.6.0 — 2026-10-11

- Added route-scoped durable element IDs, recoverable comment anchors, v1 session backups, explicit reattachment, and missing/ambiguous anchor states.
- Added source search suggestions with honest inferred provenance, read-only Git context, and an observed-only element/component/route impact graph.
- Added versioned agent tasks, exclusive claims, append-only evidence, verified/reviewer acceptance states, and declarative visual proposals.
- Added opt-in sanitized live DOM and diagnostics to MCP, separate browser-control permission, bounded shared-preview actions, and local task-linked baseline/candidate screenshots.
- Added objective live-page audit findings with explicit coverage and manual-review categories.
- Added project design guidance context, wider CSS preview controls, and Playwright flow export with fixture placeholders and selector-drift assertions.
- Added custom and multi-pane responsive viewport previews, reversible focus/disabled state previews, and preview/revert for allowlisted CSS, text, class, and accessibility-attribute proposals.
- Added task activity timelines and reviewer cancellation controls; expanded E2E coverage for responsive panes, state restoration, and proposal reversion.
- Fixed comment marker clicks and thread redraws so comment replies remain interactive during scroll and inspection.

## 0.5.0 — 2026-10-11

- Added a visual design workspace with desktop, tablet, and phone previews, live style directions, component controls, and screenshot comparison.
- Added photo references to comments, including paste and drag-and-drop, plus visible comment markers, replies, and drawing annotations.
- Added shareable team reviews backed by a Cloudflare relay, with live comments, presence, and assignment updates.
- Added agent review context, feedback triage, recorded browser flows with screenshots, and flow replay.
- Simplified workspace navigation so the most-used review sections stay visible and advanced sections live under **More**.
- Expanded browser, relay, and framework compatibility coverage.
