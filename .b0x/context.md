# B0rk's UI/UX — Global Roles & Project Design Memory

> Powered by the b0x MCP server. Shipped with global repository roles and baseline constraints from the b0x repository, layered with project-specific overrides.

## Global repository roles

- **ui-engineer**: UI Engineer (Implementation & Primitives) — Build robust, accessible component primitives and page layouts with clean DOM semantics, sound token usage, modern CSS standards, and predictable interaction states.
- **ui-auditor**: UI Auditor (Interface Review & Quality Gate) — Review and critique interfaces against objective user consequences, measurable standards, scanning ergonomics, and state completeness, resisting generic AI defaults and subjective taste.
- **content-designer**: Content Designer (Microcopy, Clarity & Ethics) — Shape labels, microcopy, errors, and flows so every word communicates purpose, guides recovery, and respects user trust.
- **motion-specialist**: Motion Specialist (Transitions, Morphing & Effects) — Implement purposeful, performant animations and visual depth that explain causality and state changes without introducing layout thrash or accessibility barriers.
- **accessibility-specialist**: Accessibility Specialist (WCAG 2.2 AA & Input Ergonomics) — Ensure the interface is non-negotiably operable across keyboard, screen readers, magnification, motor constraints, and varying display contexts.

## Global baseline hard rejections (all projects)

- Never hand-author SVG icons. Use a maintained icon set such as Lucide instead. _(tags: icons, svg, components)_
- Never use marketing-heavy or filler language. Every word, label, and element must have a purpose and be a logical fit for the screen it appears on. _(tags: content, copywriting, clarity)_
- Never use a coloured accent bar or rail on the leading edge of active/selected items when already carrying background selection. Use single-signal emphasis (label weight or background contrast). _(tags: navigation, accent, visual-hierarchy)_
- Never describe GSAP as simply free. Its no-charge licence requires that end users are not charged a fee of any kind. _(tags: gsap, licensing, motion)_
- Never infer AI authorship from visual style or report subjective taste preferences as defects. _(tags: review, craft, heuristics)_
- Never fabricate trust signals, user counts, testimonials, ratings, awards, or artificial urgency. _(tags: content, ethics, trust)_
- Never animate layout-triggering properties (height, width, top, left, margin) when transform or opacity can achieve the effect without layout thrashing. _(tags: motion, performance, css)_
- Never stream AI-generated text without user scroll-anchoring and block-level buffering to prevent content jumping and layout instability. _(tags: ai, streaming, ux)_
- Never use color as the sole carrier of status, selection, or error state. Always pair color with text, an icon, or a distinct shape for Color Vision Deficiency (CVD) accessibility. _(tags: color, accessibility, cvd)_
- Never use pure white (#ffffff) on pitch black (#000000) for large body text areas in dark mode. Use off-white on deep slate to prevent halation and eye strain. _(tags: color, dark-mode, typography)_

> Binding global constraints. If a task requires breaking one, say so explicitly and ask before proceeding.

## Global baseline preferences (apply unless task argues otherwise)

- Prefer CSS transitions and the Web Animations API for interface micro-interactions; reach for GSAP only for choreographed, scroll-linked or morphing work. _(tags: motion, animation, performance)_
- Animate transform and opacity rather than layout properties such as height, top or left. _(tags: motion, css, performance)_
- Honour prefers-reduced-motion by reducing or replacing motion, never by deleting the feedback a transition provided. _(tags: motion, accessibility, a11y)_
- Use box-shadow for opaque rectangular surfaces and filter: drop-shadow() for shapes with an alpha channel. _(tags: shadows, css, styling)_
- When revising UI copy, cut adjectives, superlatives, and abstract qualifiers. Replace them with the specific, concrete thing the user will do or see. _(tags: content, editing, microcopy)_
- Every element on a screen should have a reason: a user need, a state it surfaces, or a downstream action it enables. If it has none, remove it. _(tags: composition, hierarchy, layout)_
- Use semantic HTML native controls (<button>, <a>, <input>) before custom composite ARIA widgets. _(tags: accessibility, semantics, html)_
- Use oklch() for color palette generation and theme scales to ensure perceptual lightness uniformity and predictable contrast. _(tags: color, oklch, css, design-system)_
- Use container queries (@container) for component-level responsiveness rather than relying exclusively on viewport media queries. _(tags: responsive, container-queries, css)_
- Use the native HTML Popover API and @starting-style with transition-behavior: allow-discrete for top-layer elements and entry/exit transitions. _(tags: popover, dialog, html, css)_
- Target INP <= 200ms at p75 and use the Long Animation Frames (LoAF) API to identify and split tasks blocking user interaction responsiveness. _(tags: performance, inp, loaf, web-vitals)_
- Use CSS linear() piecewise easing function for spring and physics approximations in CSS without loading JavaScript animation libraries. _(tags: motion, spring, css, animation)_
- Apply the 60-30-10 palette architecture: 60% dominant surface/canvas neutral, 30% structural elements and secondary surfaces, 10% accent/interactive focal points. _(tags: color, palette, design-system)_
- Structure scan-heavy layouts with prominent visual anchors (layer-cake headings, spotted numbers/chips) and front-load key verbs to accommodate F-pattern scanning. _(tags: layout, typography, scanning)_
- Calibrate information density to the audience: provide dense multi-column tables and keyboard efficiency for B2B/enterprise workflows, and generous breathing room with single-path clarity for B2C consumer flows. _(tags: layout, b2b, density, audience)_

> Global defaults. A task-specific reason may override; note the reason when it does.

## Project-specific memory (`.b0x/`)

### Project preferences

- Verified contrast fix: Split the accent into two tokens: --accent (fill, white text on it) and --accent-text oklch(0.78 0.13 283) for all text/icons. Verified 7.86:1 on canvas, 7.12:1 on surface, 6.31:1 on raised. _(tags: contrast, audit-fix)_
- Verified html fix: Give every input a real <label for>, use aria-labels for the paired value inputs, and .sr-only text on icon-only buttons. Verified 0 unnamed controls across all inputs in the live DOM via a full a11y sweep. _(tags: html, audit-fix)_
- Verified target fix: Set every control to min-height 32px (28px for .sm), give icon buttons a ::after hit-area expander, and a 28px min-height on selector buttons. Verified 0 of 38 controls under 24px in the rendered DOM. _(tags: target, audit-fix)_

---

_Total active rules: 28 (global baseline: 25, user global: 0, project: 3). Generated 2026-10-11T08:18:58.670Z._
