# Design

## Source of truth

Status: Active · Date: 2026-10-21 · Surface: UIDIT review dashboard.

Evidence reviewed: `dashboard/src/components/Dashboard.jsx`, `Sidebar.jsx`, `RuntimePanels.jsx`, `dashboard/src/styles/tokens.css`, `dashboard/src/styles/global.css`, and the dashboard screenshots in `docs/screenshots/`. This brief records the existing product direction and the compact workspace navigation introduced with it.

## Brand

UIDIT is a focused workbench shared by a person reviewing a live page and a coding agent acting on their feedback. Keep the preview as the main canvas and the sidebar as a quiet tool surface. The existing neutral dark/light themes and violet selection accent are the visual identity; avoid decorative gradients, excess borders, and ornamental metrics.

## Product goals

- Let a reviewer point to a real page element, leave actionable feedback, and see edits in context.
- Keep page review and project tools easy to reach without crowding the preview.
- Persist review state in the project so coding agents can continue the work.
- Success signals: a reviewer can connect a local page, leave feedback, and find project tools without navigating away from the preview.

Non-goals: replacing the user's application, hiding project configuration, or making the dashboard a general analytics console.

## Personas and jobs

- **Reviewer:** inspect a running page, add or resolve feedback, compare a reference, and share a review.
- **Coding agent:** read the project feedback and review state, make a code change, then report and verify the result.
- **Project maintainer:** configure local servers, agent access, and workspace settings.

## Information architecture

The live page occupies the main canvas. The right workspace has four primary sections: **Review** (Feedback, Inspect, Changes), **Design**, **Runtime** (Flows, Server), and **Project** (Agents, Settings). Related views are grouped in compact secondary navigation inside their section. Review opens by default.

## Design principles

- Keep navigation compact so the live page retains room.
- Group by the reviewer's job; keep feedback and element inspection together.
- Keep secondary controls visible in their active section, with clear labels and active state.
- Reuse the existing theme, spacing, and component tokens.
- Make empty, loading, and active states explain what the reviewer can do next.

## Visual language

Use the existing OKLCH tokens in `dashboard/src/styles/tokens.css`: charcoal canvas and raised surfaces in dark mode, corresponding light surfaces, readable foregrounds, and violet for selection or active controls. Use the system sans-serif stack and compact 11–14px dashboard type. Prefer flat surfaces, fine borders, and 6–9px radii; reserve stronger contrast for the active view and primary action.

## Components

- `Dashboard.jsx` owns the workspace shell and primary section navigation.
- `Sidebar.jsx` owns Review subviews and feedback content.
- `DesignPanel.jsx` owns visual editing and reference comparison.
- `RuntimePanels.jsx` owns Flows, Server, Agents, and Settings views.
- `global.css` and `tokens.css` own workspace layout, themes, and shared visual tokens.

Use the existing button, tab, panel, and form patterns; do not create a parallel component library for the sidebar.

## Accessibility

Use native buttons with visible focus, accessible names, and a programmatically indicated active section. Keep keyboard navigation intact and do not rely on color alone for selection or status. Respect `prefers-reduced-motion` and maintain readable contrast in both themes.

## Responsive behavior

The workspace drawer resizes beside the preview on desktop and stacks below it on narrow screens. At compact drawer widths, primary navigation may use icons with accessible labels. Keep secondary controls touch-sized and prevent horizontal overflow.

## Interaction states

Retain the existing loading surface and honest empty states for feedback, flows, agents, and local servers. Active navigation must match the displayed panel. Server connection and review actions report success or failure through the existing status feedback.

## Content voice

Use short, literal labels such as “Review”, “Inspect”, “Flows”, and “Settings”. Explain an action in a sentence only where the next step is not obvious. Keep technical detail in panel descriptions and agent guidance.

## Implementation constraints

The dashboard is React rendered by Astro and styled in `dashboard/src/styles/global.css` using shared CSS custom properties. Keep heavy sections lazy-loaded, preserve query-based section links, keyboard shortcuts, narrow-screen layout, and existing Playwright coverage. Validate with the dashboard build and browser suite.

## Open questions

None for the current sidebar grouping request.
