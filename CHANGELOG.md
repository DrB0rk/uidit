# Changelog

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
