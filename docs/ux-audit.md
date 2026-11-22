# Grtlabs / SignalDeck UX audit

Scope: the whole site except the image pane (being fixed separately; only consistency notes below).
Constraint: keep the base theme (OKLCH tokens in `app/globals.css`, teal primary, lavender accent, Hanken Grotesk + Spline Sans Mono). Nothing here changes a color, font or the dual theme. Items that would are listed under "Out of scope".

Evidence: live pages at 375x812 and desktop (landing, /login, /status), the four owner phone screenshots (image pane), and code review of the dashboard (not logged in, so panels, settings and assistant were audited from source). Skills lenses used: impeccable audit, hallmark slop gate, ponytail audit.

Effort S/M/L. Impact H/M/L. Priority P0 = broken, P1 = visibly rough, P2 = polish.

Method note: audit was done from code plus the public pages. Dashboard visuals were not seen live, so items marked (verify) need one look after implementation.

---

## Top 10 problems

1. P0 Login card overflows the phone viewport (page scrollWidth 436 vs 375). The sliding two-step track is wider than the card on mobile, the input and button are clipped on the right.
2. P0 Dashboard header bar is built for desktop. It holds theme toggle, edit, settings, two text "Sign out" buttons and "Operator" in one row, with a fixed 8.25rem left pad for the floating brand pill. On a phone it wraps into a messy second row.
3. P0 Dialogs and drawers have no keyboard model. No Escape handler, no focus trap, no focus return in SettingsPanel, the assistant drawer or RevealProvider (the only `keydown` in console code is in BrowserPane).
4. P1 One 3,337-line `AssistantSidebar.tsx` with 42 `useState` and a 2,147-line `assistant.module.css`. Every UX fix in the sidebar is slow and collides. Needs splitting before further polish.
5. P1 No shared UI primitives. Buttons are re-declared per module (`.signout`, `.iconAction`, `.assistantOpen`, login submit, settings buttons, `.edGo`, `.edClose`) with the same padding/border/hover recipe copied. Same for inputs, chips, cards, icon buttons.
6. P1 Type scale is bypassed. 207 uses of tokens, but one-offs remain: `0.65rem`, `0.66rem`, `0.67rem`, `0.7rem`, `1.7rem`, `0.92em`. The 0.65 to 0.7rem sizes are below readable on a phone. The scale has no step between `--text-xs` (12px) and a true caption or micro size, so people invented their own.
7. P1 Touch targets under 44px: console icon buttons are 34x34, `.signout` about 32px high, brand pill 88x34, theme toggle 48x26, assistant header icon buttons (15px icons). Fine on desktop, bad on the phone where the owner actually tests.
8. P1 Status page on mobile: heading sits flush under the floating brand pill (about 4px gap), the service picker wraps into an uneven 2-row segmented control with orphaned items, the summary stats are baseline-misaligned. Desktop shows 5 identical calendar cards, which is fine, but the empty bottom half of the page and tiny day cells are low-density.
9. P1 Loading, empty and error states are inconsistent. Panels have skeletons, the assistant has spinners, the image editor has chips, and errors are plain red boxes (see owner screenshots: error banner jumps layout, moves under the action buttons, long raw backend text such as "size 64-3072 px, at least one selected pixel, mask must match the image").
10. P2 Motion is rich but unsystematic: `--dur*` tokens exist, but 15 multi-property `transition:` blocks, ten `transition: none` overrides and 19 reduced-motion blocks are hand-written per file. No shared enter/exit pattern for modals, drawers, toasts, tab changes.

Counts for the summary: Global 9, Navigation/layout 6, Landing 5, Login/QR 5, Status 5, Dashboard grid/panels 8, Settings 6, Assistant 8, Mobile 5, Accessibility 7, States 6, Micro-interactions 6, Code health 6 = 82 items listed below (some cross-referenced).

---

## 1. Global system

G1 (P1, M, H) Add a primitives layer. Create `components/ui/` with `Button` (variants primary/secondary/ghost/danger, sizes md 40px / lg 44px, built-in loading + disabled), `IconButton` (min 40px desktop, 44px under 640px), `Field` (label, hint, error, input/textarea/select), `Chip`, `Card`, `Dialog`, `Toast`. Source of truth is the recipe already used in `.signout/.iconAction` (console.module.css:53-110) and login submit. Replace the copies batch by batch; do not restyle.

G2 (P1, S, H) Tighten the type scale in `globals.css`: keep existing tokens, add `--text-2xs: 0.6875rem` (11px, the floor, uppercase mono labels only) and `--text-mono: 0.8125rem`. Replace every `0.65rem/0.66rem/0.67rem/0.7rem` with `--text-2xs` or `--text-xs`; replace `1.7rem` with `--text-xl`/`--display` step; replace `0.92em` with a token. Body copy never below `--text-sm` on mobile.

G3 (P2, S, M) Add semantic spacing aliases used by primitives: `--gap-tight` (0.5rem), `--gap` (1rem), `--gap-section` (2.5rem), `--pad-card` (1rem mobile, 1.5rem desktop). Components currently mix raw `0.4rem/0.55rem/0.35rem` with tokens; the rhythm is uneven (e.g. console.module.css:54,92,305,326).

G4 (P1, S, M) Radius consistency: 60 `--radius-sm`, 25 `--radius-xs`, 16 `--radius-md`, plus hardcoded `3px/2px/4px/0.2rem`. Rule: controls sm, cards md, modals/sheets lg, chips pill. Replace hardcoded values.

G5 (P1, S, M) Elevation: only `--shadow-1/2`. Add `--shadow-3` for dialogs and popovers so modal, popover and card read as three levels (currently settings overlay and cards share shadows).

G6 (P1, M, H) Motion system in `globals.css`: utility classes `.enter` (opacity+8px rise, `--dur`), `.exit`, `.pop` (popover scale 0.97 to 1), `.sheet` (translateY from bottom), all collapsed under one `@media (prefers-reduced-motion: reduce)` block. Delete the per-file reduced-motion duplicates once adopted.

G7 (P2, S, M) Focus ring token: `--focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus)`. One global `:focus-visible` rule in `globals.css`; remove the 10 per-component `outline: none` (login.module.css:117, assistant.module.css:1241/1672/2030, reveal.module.css:76, settings.module.css:219/287/362/387/571) unless they supply the same ring.

G8 (P2, S, L) Selection and disabled states: a single `:disabled` rule (opacity 0.5, no pointer, `cursor: not-allowed`) and `::selection` using `--accent-soft`. Disabled controls in the owner screenshot (Add to selection, Remove, Reset) are barely distinguishable from enabled ones in light mode.

G9 (P2, S, L) Use `color-scheme` per theme and `accent-color: var(--accent)` globally so native radios/checkboxes/sliders (seen unstyled blue in the owner screenshots) match the theme until custom controls exist.

---

## 2. Navigation and layout

N1 (P0, M, H) Dashboard header bar on mobile (`console.module.css:17-110`, `ConsoleShell.tsx:155-208`). Under 640px: show brand pill, tag, theme toggle, a single overflow menu (`IconButton` MoreHorizontal) containing Edit dashboard, Settings, Sign out, Sign out everywhere. Keep Operator as the FAB. Remove the 8.25rem `padding-left` hack by making `BrandNav` part of the bar flow on `/dashboard` (it is `position: fixed`, BrandNav.module.css:1-15).

N2 (P1, M, M) Desktop header: group the right side as [theme] [edit] [settings] [account menu]; one Account menu replaces the two text Sign out buttons ("Sign out everywhere" next to "Sign out" is a mis-click hazard). Destructive "everywhere" requires a confirm.

N3 (P1, S, M) BrandNav pill collides with page content on /status and the tile grid (about 4px gap below it at 375px). Add `padding-top: calc(var(--pad-y) + 34px + var(--space-sm))` to the page wrappers on mobile, or make the brand sticky-in-flow on non-landing pages.

N4 (P1, M, M) Breadcrumb or context: dashboard shows a bare "console" mono tag. Replace with page title plus live connection state (see S4). Status page gets the same header pattern so /status and /dashboard share a layout shell.

N5 (P2, S, M) Page transitions: `PageTransition` exists (32 lines) but dashboard to landing to login is not consistently animated; also respect reduced motion. Verify once after N1.

N6 (P2, M, L) Add a 404 and error boundary pages in the same style (check for `app/not-found.tsx` and `app/error.tsx`; none found in the listing).

---

## 3. Landing `/`

L1 (P1, S, M) Hierarchy: title, tagline, status pill, CTA, traffic tag, spec grid all stack with similar weight. Make the CTA the focal point: move the status pill above the title as a small eyebrow, or reduce the pill's size and border so "Authenticate" leads. Keep copy.

L2 (P1, S, M) The status pill is three lines at 375px ("All systems operational", "4 services up 22d 03:22:51", "checked 2s ago") with mixed separators and a live uptime clock that ticks constantly. Split into primary line plus a single muted secondary line; tick uptime only when tab visible; set `font-variant-numeric: tabular-nums` (`tnum`) so it does not jitter.

L3 (P2, S, M) Traffic tag row (`nas idle / home idle / media idle`, "live via Cloudflare") floats between CTA and specs with no container. Give it the same chip treatment as the specs or fold it into the footer.

L4 (P2, S, M) Spec tiles: values mix `19/29GB` and `2.7/4.0TB` with units smaller than values, labels in tiny mono. Raise label to `--text-xs`, align baselines, make tile heights equal. The load tile bar is a 2px line at the bottom, nearly invisible (verify at dark).

L5 (P2, S, L) Footer: "GitHub / Notes / Status" plus version at 12px with 24px-ish tap area. Pad links to 44px touch height on mobile, add visible hover/focus underline. Desktop screenshot during boot showed a blank hero for >1s (the `.boot` stagger); keep total boot under 600ms and never hide content if JS is slow (use CSS-only animation with `animation-fill-mode: both`, no JS gate).

---

## 4. Login and QR (`app/login`)

LG1 (P0, S, H) Fix overflow at <=960px. `.step` is `flex: 0 0 100%` inside `.track` inside `.steps{overflow:hidden}`, but the measured step right edge is 729px at a 375 viewport, meaning `.steps` or `.card` is wider than the viewport (the card has `width:100%` with `.wrap` padding `var(--pad-x)` and `place-items: center`). Set `.card { min-width: 0; width: min(100%, 26rem) }`, `.wrap { padding-inline: var(--pad-x) }`, `.steps { min-width: 0; width: 100% }`, and `.form { min-width: 0 }` so the grid child cannot grow to its content width. Verify scrollWidth equals clientWidth at 320, 375, 430.

LG2 (P1, S, M) The brand dock plus logo animation on mobile is clever but fragile; ensure the pill and the empty `.brandDock` are never mispositioned during transition (screenshot shows pill above the card, fine). Add `min-height` so the card does not jump when the code step has a different height.

LG3 (P1, S, M) Inputs: set `autocomplete="current-password"` and `autocomplete="one-time-code"` + `inputmode="numeric"` on the code field (check `LoginForm.tsx`); label above the field in sentence case instead of mono lowercase "dashboard password". Show/hide password toggle.

LG4 (P1, S, M) Error: generic error must be announced (`role="alert"`) and must not shift the layout; reserve its line height. Throttle message ("try again in 30s") should be a live countdown, not static.

LG5 (P2, S, L) QR login page (`app/login/qr/page.tsx`): the confirm step needs a clear "which device, what happens" summary and a Cancel; check for loading and expired-token states (single-use 60s token) and show a distinct "link expired, ask for a new one" state.

---

## 5. Status page

ST1 (P1, S, M) Mobile top spacing: heading is about 4px under the brand pill (N3).

ST2 (P1, S, M) Service picker: 5 options in a 2-row wrapped segmented control with centred orphans. Use a horizontally scrollable pill row (`overflow-x:auto; scroll-snap-type:x mandatory`) or a `<select>` under 480px.

ST3 (P2, S, M) Summary stats (`86.4% uptime`, `3 incident days`, `0d streak`): number and unit baseline misaligned; add `tnum`, align units, and give them an accessible label ("uptime this month").

ST4 (P2, M, M) Calendar: days 18, 19, 22 are red/amber with only color distinguishing them (plus text colour). Add a small shape or label on tap (tooltip showing date + status + duration), and make a day tappable on mobile with a bottom sheet. Legend: add "today" marker.

ST5 (P2, S, L) Desktop: five equal cards leave the lower half empty; collapse to the "All systems" card full width on top then 4 smaller, or make the first card a timeline strip. Optional.

---

## 6. Dashboard grid and panels (code audit)

D1 (P1, M, H) Tile chrome: `.panel/.panelHead` (console.module.css:522-560) vs `.dashTile > .panel` (189). Ensure every tile has the same header: icon, title, status dot, optional action. Add per-tile "last updated" with stale styling (uses snapshot `stale` flag today only in header).

D2 (P1, M, M) Skeletons: only `.skeletonRow`. Make a `Skeleton` primitive (line, block, circle) with a calmer shimmer and the same dimensions as final content to avoid layout shift. Reduced-motion: static.

D3 (P1, S, M) Edit mode: dashed `.dropGhost` and resize handles are good; add an explicit "Add widget" affordance and an empty-grid state ("No tiles. Add one"). Edit state must be visible in the bar (Done button exists), also announce with `aria-live`.

D4 (P1, M, M) Error/partial data: when a backend is unreachable the panel should show "Proxmox unreachable, last data 3m ago" with a Retry, not blank rows. Check `ComputePanel`, `StoragePanel`, `MediaPanel`, `AutomationPanel` for `data == null && !loading`.

D5 (P2, S, M) Number formatting: mono/tnum for all metrics, consistent unit style (GB vs GiB, %), rounding to one decimal.

D6 (P2, S, M) Meters (`.meter` grid auto/1fr/auto): add accessible `role="meter"` with `aria-valuenow`, threshold colors from existing `--warn/--down` tokens at 80/90%.

D7 (P2, M, M) History strip rows: `grid-template-columns: 1fr auto` at <=560px orders cells below; fine, but day cells need >=24px hit area if interactive.

D8 (P2, S, L) Dense tile text at `--text-xs` with muted color on `--surface`: check the contrast of `--muted` (oklch .47 light) at 12px; it passes AA for text but just; use `--ink` for any value users need to read.

---

## 7. Settings (`SettingsPanel.tsx`, `settings.module.css`)

SE1 (P0, M, H) Make it a proper dialog: Escape closes, focus moves in and returns to the trigger, Tab is trapped, body scroll locked. Use a shared `Dialog` (G1) built on native `<dialog>` with `showModal()`.

SE2 (P1, M, M) Mobile layout: left nav plus content becomes a top segmented/scrollable tab bar or a list to detail drill-down at <=640px; full-screen sheet, sticky header with close button, sticky save bar.

SE3 (P1, S, M) Unsaved-changes state: dirty indicator, disabled Save until dirty, confirm on close with changes; inline "Saved" feedback via Toast instead of silent.

SE4 (P1, S, M) Secret fields: reveal needs password+TOTP (`RevealProvider`); the modal should explain why, show a 30s countdown on the revealed value, auto-hide, and copy button with "Copied" feedback.

SE5 (P2, S, M) Switches (`role="switch"`, SettingsPanel.tsx:193): label association, 44px hit area via padding, `:focus-visible` ring, and an on/off text for non-color cue.

SE6 (P2, M, L) Group long forms (Agent access, Sessions, Assistant) with section headings and a one-line description each; destructive actions (revoke token, sign out others) in a visually separate danger zone with confirm.

---

## 8. Assistant sidebar and drawer

A1 (P1, L, H) Split `AssistantSidebar.tsx` (3,337 lines, 42 `useState`): extract `Composer`, `MessageList`, `ActionCard` (exists at 2979), `ChatHistory`, `MemoryPanel`, `WorkspaceCard`, `HeaderBar`, plus a `useAssistantTask` hook for stream/reattach logic. Pure refactor first, no visual change, so later polish is cheap. Must not touch the server-owned-chat and reattach invariants in CLAUDE.md.

A2 (P1, M, M) Header toolbar: Globe, Image, New chat, History, Memory, Hide are six 15px icons with only `aria-label`; add tooltips (desktop) and group into primary (New chat, History) and an overflow for Browser/Image/Memory on mobile.

A3 (P1, M, H) Mobile drawer: the FAB (52px) overlaps content and the dock; drawer should be a full-height sheet with swipe-down/close handle, safe-area padding for the composer (`env(safe-area-inset-bottom)`), and `100dvh` so the browser URL bar does not hide the input. Check `.sidebar` height units (assistant.module.css) are `dvh`, not `vh`/`100%`.

A4 (P1, S, M) Composer: autosize textarea, Enter to send / Shift+Enter newline with hint, visible Stop button while a task runs, attachment chips with remove, disabled state while offline.

A5 (P1, M, M) Streaming state: show "working" with the current tool name, elapsed time, and a stop control; reconnection banner (`sessionBanner`) uses `role="alert"` already, add retry.

A6 (P2, S, M) `ActionCard` confirm/reauth cards: Confirm (primary) and Cancel (secondary) always same order and size; destructive wording explicit ("Delete container 105"), risk label, and elevated (reauth) state clearly different.

A7 (P2, S, M) Markdown (`Markdown.tsx`, markdown.module.css): code blocks need copy button, horizontal scroll, and a max-height with expand; tables scroll inside their own wrapper on mobile.

A8 (P2, S, L) Empty chat state: suggested first actions (3 chips drawn from real tools) instead of a blank pane; chat history list with relative dates and delete confirm (Trash2 has no undo).

---

## 9. Mobile (cross-cutting; phone screenshots + 375px checks)

M1 (P0) Login overflow (LG1). M2 (P0) Dashboard bar (N1).

M3 (P1, S, H) Touch targets: enforce a 44px minimum on `IconButton`, theme toggle (48x26 now), brand pill (34 high), footer links, calendar days, checkbox/radio rows. Use padding or `::after` hit-area expansion so visuals stay the same.

M4 (P1, S, M) Viewport units: replace `100vh/100svh` on full-screen overlays with `100dvh` plus safe-area insets; the owner screenshots show a panel ending above the browser bottom bar with an empty gap and clipped glow at the bottom-right, a sign of fixed positioning against the wrong viewport.

M5 (P2, S, M) Landscape and small width (320px): check specs grid (3 columns at 375), segmented controls, and settings. Add `@media (max-width: 380px)` fallbacks (2 columns).

Breakpoint hygiene: only 640, 560, 760, 961, 1100, 1101, 1340 plus 600 and 960 appear. Normalize to three (`--bp-sm` 640, `--bp-md` 1100, `--bp-lg` 1340) in comments/containers; consider container queries for tiles.

---

## 10. Accessibility

AC1 (P0, M, H) Dialog focus management and Escape (SE1, shared `Dialog`).
AC2 (P1, S, M) Skip link (`Skip to content`) in `app/layout.tsx`; `<main id>` on every page.
AC3 (P1, S, M) Status colors never the only cue: add icons or text for operational/partial/down in calendar cells, panel dots, history cells.
AC4 (P1, S, M) `prefers-reduced-motion`: telemetry canvas (`TelemetryCanvas.tsx`, 441 lines) and pulse animations should pause or go static; verify the canvas stops its rAF loop in reduced motion and when the tab is hidden (battery on phones).
AC5 (P1, S, M) Live regions: status pill and "reconnecting..." need `aria-live="polite"`; error banners `role="alert"`; toasts `role="status"`.
AC6 (P2, S, M) Form labels: every input has a visible label or `aria-label` (settings `aria-label={field.label}` exists); error text linked with `aria-describedby`.
AC7 (P2, S, L) Contrast: `--muted` on `--surface-2` in light mode at 12px and the disabled state of `--accent` buttons (owner screenshot: pale lavender "Generate" with white text, below 3:1) need a check; fix by using `--accent-strong` fill at reduced opacity only for non-text, and a separate disabled style with `--ink` at lower emphasis.

---

## 11. Loading, empty, error states (system)

ES1 (P1, M, H) One `StateBlock` component (icon, title, one-line explanation, action) for empty/error/offline; replace ad hoc strings.
ES2 (P1, S, M) Inline errors: reserve space or animate height; never insert above/below actions in a way that moves the primary button (owner screenshots: error banner moves the button row).
ES3 (P1, S, M) Human error copy: map known backend messages ("image or mask rejected ...") to short messages with a Details disclosure for the raw text.
ES4 (P2, S, M) Button loading: spinner replaces icon, label stays, width fixed (no jump).
ES5 (P2, S, M) Offline/stale: global banner under the bar when `/api/console` fails twice, with last success time.
ES6 (P2, S, L) First-run: empty dashboard layout and empty assistant chat get a one-time hint.

---

## 12. Micro-interactions and transitions

MI1 (P1, S, M) Press feedback: `:active { transform: translateY(1px) }` on primitives; hover only under `@media (hover: hover)` so touch devices do not stick.
MI2 (P1, S, M) Modal/sheet/popover enter and exit using G6 classes (currently settings overlay and SystemsPopover appear abruptly; verify).
MI3 (P2, S, M) Tab/segment changes: sliding indicator under the status picker and settings nav.
MI4 (P2, S, M) Toasts for save/copy/revoke instead of silent success.
MI5 (P2, S, L) Number changes in live panels tween or flash briefly (opacity pulse 200ms) so updates are noticed, not jarring; respect reduced motion.
MI6 (P2, S, L) Theme toggle: keep the crossfade (already in globals.css `html.theme-changing`); ensure the toggle meets M3 size.

---

## 13. Code health (ponytail lens)

CH1 (P1, L, H) AssistantSidebar split (A1) and assistant.module.css (2,147 lines, 98 font-size declarations) split per component.
CH2 (P1, M, M) Duplicated button/input/chip CSS across `console.module.css`, `settings.module.css`, `assistant.module.css`, `login.module.css`, `reveal.module.css` collapses into `components/ui/*.module.css` (G1).
CH3 (P2, S, M) `DebugPanel.tsx` (224 lines) and `FirstLoadReset.tsx`: confirm they are dev-only and excluded from production bundles; delete if unused.
CH4 (P2, S, M) `TelemetryCanvas` 441 lines for a background: profile cost on a phone; cap DPR at 2 and frame rate at 30fps.
CH5 (P2, S, L) `AuthDoor`, `LoadTile`, `Clock`, `PulseGlyph`, `Wordmark` are tiny single-use components; fine, but keep one CSS module per component only if it has more than a few rules.
CH6 (P2, S, L) Inline `style` objects with CSS custom properties (`boot(i)` in page.tsx) are fine; ensure no other inline layout styles exist (grep `style={{`).

---

## Image pane consistency notes (do not edit here)

- Use the same `Button/Field/Dialog/StateBlock` primitives (G1, ES1) so the image pane looks like the rest of the site; owner screenshots show native radios (blue), native checkbox, native details marker, unstyled range input: these belong to the system via `accent-color` (G9) now and custom segmented controls (`edSeg3`) after.
- Toolbar with 4 secondary buttons wrapping into three rows ("Exclude points", "Add to selection", "Remove from selection", "Reset points"): collapse into one icon toolbar with tooltips.
- Panel title "Image generation" shares header pattern with the assistant (A2).
- Disabled button contrast (AC7) and error placement (ES2/ES3).

---

## Out of scope (conflicts with "keep the base theme and colors")

- New brand colors, new accent, replacing teal/lavender or the OKLCH palette.
- Changing fonts (Hanken Grotesk, Spline Sans Mono).
- Reworking the dual-theme model or making dark the default.
- Removing the telemetry canvas background (only perf and reduced-motion handling in scope).
- Rebranding "Grtlabs"/"SignalDeck" naming.

---

## Implementation order (4 batches, no file collisions)

Batch 1 - Foundations and global (files: `app/globals.css`, new `components/ui/*`, `app/layout.tsx`)
G1 (Button, IconButton, Field, Chip, Card, Skeleton, StateBlock, Toast), G2, G3, G4, G5, G6, G7, G8, G9, AC2, AC5 (live regions in new components), MI1. No consumer files touched yet, so zero collisions; ship the primitives with a tiny `/dev/ui` or Storybook-free test page only if cheap.

Batch 2 - Public pages and mobile blockers (files: `app/login/*`, `app/page.tsx` + `app/page.module.css`, `app/status/*`, `components/ServiceHistory*`, `components/BrandNav*`, `components/ThemeToggle*`, `components/StatusPulse*`, `components/TrafficTag*`, `components/AuthDoor*`)
LG1 to LG5, L1 to L5, ST1 to ST5, N3, N5, N6 (new `not-found.tsx`/`error.tsx`), M3 (public part), M5, AC3, AC4 (canvas pause), CH4. Re-verify at 320/375/430 and both themes, run `npx tsc --noEmit`, restart the dev server before measuring.

Batch 3 - Console shell, grid, settings (files: `components/console/ConsoleShell.tsx`, `console.module.css`, `DashboardGrid.tsx`, `panels.tsx`, `widgets.tsx`, `bits.tsx`, `SettingsPanel.tsx`, `settings.module.css`, `*Settings.tsx`, `RevealProvider.tsx`, `reveal.module.css`)
N1, N2, N4, D1 to D8, SE1 to SE6 (shared `Dialog`), AC1, AC6, AC7, ES1 to ES6 (for these surfaces), MI2 to MI5, M4. Keep the security invariants (session checks, reauth gate, write-only keys) untouched; this batch is UI only.

Batch 4 - Assistant sidebar and cleanup (files: `components/console/AssistantSidebar.tsx`, `assistant.module.css`, `Markdown.tsx`, `markdown.module.css`, and, after the other agent finishes, the image pane files for consistency)
First A1/CH1 as a pure refactor in its own step (no visual change, confirm the chat reattach/persist behavior is unchanged), then A2 to A8, M3/M4 for the drawer, ES2/ES3 for the image pane, CH2 (delete now-duplicated CSS), CH3, CH6. Do the image pane consistency pass last so it does not collide with the agent editing it now.

## Progress

Batch 1 done: G1 (Button, IconButton, Field, Chip, Card, Skeleton, StateBlock, Toast in `components/ui/`), G2 (tokens `--text-2xs`, `--text-mono`; replacing the one-off sizes in consumer files is left to batches 2-4), G3, G4 (rule stands; hardcoded radii replaced in later batches), G5, G6, G7, G8, G9, AC2, AC5, MI1. Dev gallery: `/dev/ui` (404 in production).
Left for later: `Dialog` (Batch 3, SE1/AC1), consumers adopting primitives, sliding segment indicator (MI3).
