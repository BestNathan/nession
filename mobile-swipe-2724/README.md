# Mobile App Swipe Navigation Lab (#2724)

## Owning Requirement
[Requirement #2724 — Redesign mobile App swipe navigation and gesture ownership](https://github.com/BestNathan/nession/issues/2724)

## Decision under test
Make the established **Sessions ← Terminal → Workspace** spatial model discoverable through *in-flight feedback* without sacrificing the work surface. Horizontal navigation must be claimed only after origin + direction + movement gates, with a proportional drag/release behavior. On a phone, ordinary vertical Terminal scroll, full-screen TUI mouse input, long-press arrow control, Capsule Peek, content selection, and pushed Workspace detail must take priority over shell navigation.

This is an interaction hypothesis, **not approval of production thresholds or evidence that iOS Safari delivers edge touch events**.

## Entry, complete mock scenario and visual states
Open `index.html` directly over HTTPS in a mobile browser (or local file; no external assets).

1. The initially selected `dev-session` opens its quiet Terminal. With one finger starting from its **left 28px**, drag right: the Terminal translates under the finger, revealing Sessions and an in-flight pill. Release after the threshold to enter Sessions. Swipe left from the **right edge** of the list to return, or use the arrow.
2. From the Terminal **right 28px**, drag left to reveal Workspace; release to commit. In Workspace root, drag right from the **left edge** to return. Buttons in the Terminal header provide a visible alternative to every swipe route.
3. Repeat with a short edge drag (< threshold) and a diagonal/vertical edge drag: short horizontal movement must snap back, and vertical movement must give up navigation immediately.
4. Scroll **the middle of the Terminal** vertically and switch between normal shell scrollback / mouse-aware TUI fixture. Neither mode may page the App on a central touch. Switch long-press **On** and hold a center touch still ~380ms; the mock directional overlay owns subsequent movement until release. It does not emit actual keys.
5. Expand the lower Context Capsule (+) and drag the expanded Peek or composer: they keep their touches. Swipe from the outer page edge only when the target is not an interactive control.
6. Open `Workspace 详情` (or Files from Workspace), simulate editing and attempt an edge drag: the detail owns Back. Tap Back: a confirmation blocks leaving until the user cancels or discards.
7. Switch to `无 Session`: Sessions becomes the root; no fake Terminal or Workspace is accessible until choosing a Session row.
8. Enable `显示边缘范围` to inspect the 28px starting zones (debug only), and use shortcuts `→ Sessions` / `→ Workspace` to replay a full mock gesture without requiring a precise phone edge.

### Interaction states
`idle → candidate → navigation | content | direction → committed | cancelled`.
The inspector displays current page, gesture phase, owner, destination, travel, commit result and bounded event history. Native vertical scrolling in the mock content remains possible. `pointercancel` aborts navigation.

## Prototype parameters (hypotheses)
- Start band: 28 px, **measured against the phone shell**, not browser window. Chrome outside work surfaces does not need the edge band.
- Movement slop before ownership: 12 px; vertical axis wins when `abs(dy) > 0.85 * abs(dx)`.
- Commit by travel ≥ `max(64px, 0.18 * shell width)`; or quick flick ≥40 px and mean absolute velocity ≥0.45 px/ms toward a valid target.
- Right swipe from Terminal left edge opens Sessions; left swipe from Terminal right edge opens Workspace (only with Session). Reverse page swipes are constrained to the opposite edge when over interactive content.
- Swipe animation is ~175ms, reduced-motion preference respected. Real-device acceptance may adjust these values.

## Fidelity and limitations
- **Mock**: terminal output, scrollback, Session/Agent/Workspace data, connection, direction-pad behavior, page transitions, editor dirty state. No PTY/tmux/xterm.js, OS navigation gesture listener, TUI event bytes, Clipboard, backend calls or persistent state.
- **Simulated but interactive**: pointer-drag ownership, swipe reveal/threshold/velocity/return, normal vertical DOM scroll, long-press exclusivity, Capsule Peek and Workspace depth guard, accessible visible navigation controls.
- **Not proven**: real Safari/PWA edge gesture interception; native touch cancellation timing; xterm alternate-screen / mouse-reporting; keyboard/IME integration; actual PTY dimensions; production focus/scroll preservation; iOS haptics.
- CSS is a compact visual approximation of the Nession dark Terminal App. It does not claim to be emitted by production design tokens, and has no dependency on the real App bundle.

## Verification
- HTML is standalone with inline CSS/JS and no remote/CDN assets.
- Repository readback: JS syntactically compiled in a JS runtime; no duplicate DOM IDs or missing `$('id')` DOM references.
- Real browser interaction and actual mobile Safari/PWA execution: **not independently verified**. Production Acceptance, device testing and Pages SHA readback are **Pending**.
- Reproduce via direct pointer/touch interactions described above. A completed workflow must additionally inspect the browser console, screenshot 375/390/430 widths and landscape, and verify iOS Safari edge ownership.

## Publication
- **Expected rendered HTML:** https://bestnathan.github.io/nession/prototypes/mobile-swipe-2724/index.html (only authoritative after matching the Pages manifest commit SHA).
- **Gallery:** https://bestnathan.github.io/nession/#/prototypes
- **Source:** https://github.com/BestNathan/nession/tree/prototype/mobile-swipe-2724
- **Requirement:** https://github.com/BestNathan/nession/issues/2724

Keep the prototype in the shared orphan `prototype` branch. Do not merge into `main` or include it in production Web.
