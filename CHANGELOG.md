# Changelog

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
