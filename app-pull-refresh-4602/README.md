# App host pull-to-refresh — #4602

- **Requirement:** [#4602 — Unify frontend pull/refresh lifecycle and manual refresh for all mutable lists](https://github.com/BestNathan/nession/issues/4602)
- **Surface:** App Experience, Sessions layer at rest (host-owned vertical scroll region), plus the Web disclosure refresh for comparison.
- **Fidelity baseline:** `docs/design/interaction/app.md` (gestures and visible alternatives; swipe contact ownership #2724; host-owned scrolling #4115), `docs/design/interaction/web.md`, `mobile-swipe-2724` prototype. Product area is a visual approximation of the App shell, not the React components.

## Question this prototype settles

The App has no resting manual refresh (deliberately, #1083 §6) and a vertical
pull gesture would compete with four existing owners: the horizontal
Sessions/Workspace pager, the platform edge guard, a nested collection scroller,
and the Terminal's own touch input. #4602 requires a host-owned pull accelerator
**and** a non-gesture action available even when the list is healthy or empty.

Unresolved before this mock:

1. Can a downward pull at the list top be distinguished from the horizontal pager and from ordinary scrolling, without stealing either?
2. Does a 64 CSS px release threshold feel deliberate, and does a short drag cancel cleanly with no request?
3. Where does the non-gesture action live so it is discoverable without becoming a permanent refresh row?
4. Does the indicator preserve Capsule clearance and leave scroll/selection untouched?

## Scenario / critical path

Entry: App Sessions layer, list at top, healthy data.

1. **Short pull → cancel.** Drag down ~30 px and release. Indicator retracts, **no request** is made, rows unchanged.
2. **Qualified pull → release.** Drag down past 64 px and release. One request commits; host indicator shows busy until it settles; rows update in place; scroll position and selection unchanged.
3. **Failure → retry.** With the error scenario armed, a qualified pull settles into a failure state that keeps the last known rows and offers Retry. The header action retries the same scope.
4. **Non-gesture action.** The header Refresh works with keyboard and touch, and is present in the **empty** and **error** scenarios too.
5. **Guards.**
   - *Scrolled / non-top:* a downward drag scrolls normally; no pull indicator, no request.
   - *Horizontal swipe:* the pager claims the contact; the pull never arms.
   - *Nested scroller:* the inner collection scrolls; the host pull does not capture it.
   - *Terminal:* the surface owns its touches; no pull.
6. **Page switch while running.** Switching surface mid-request cancels the indicator without dropping the settled result into the wrong surface.

## Ownership tree (current production, checked against `main`)

```
AppLayout / AppLayers
  └ AppSessionsSurface            ← Sessions layer at rest
      ├ AppHomeHeader             ← one header band; Sessions menu
      │   └ (candidate) Refresh action  ← #4602 delta, non-gesture alternative
      ├ host scroll region        ← vertical scroll owner (#4115)
      │   └ session rows
      └ Capsule Zone              ← floating, host-measured clearance
```

**Current vs candidate delta:** today the App renders `RefreshButton` only inside
the disconnected problem strip (`AppSessionsSurface.tsx`), by the #1083 §6
ruling. #4602 explicitly evolves that: the action must exist while healthy/empty,
hosted in the existing header rather than as a permanent refresh row, and the
host additionally owns a pull accelerator. No capability renders its own page
header, scroll container or gesture.

## Fidelity

| Aspect | Classification |
|---|---|
| Session rows, agents, counts | `mock` — deterministic local fixture |
| Refresh request / latency / failure | `mock` — deferred promise with scripted outcome |
| Gesture axis lock, threshold, indicator | `mock` — real pointer-event logic, no transport |
| Capsule clearance | `mock` — static measured inset, not the production observer |
| Web disclosure comparison | `mock` — static representation of the existing pattern |
| Backend, WebSocket, Jotai, pull controller | **not present** — production implementation is #4602's own scope |

Gaps: no real `KeyboardAvoidanceScroller`, no real swipe pager coordinator, no
production token pipeline (colors approximate the App dark shell), no safe-area
environment on a physical device. Chromium touch emulation only — **no Safari or
physical-device claim**.

## Usage

Open `index.html` directly, or serve the branch root:

```sh
python3 -m http.server 8099
# http://localhost:8099/app-pull-refresh-4602/index.html
```

Review controls (outside the product viewport): device width 375/390/430, Reset,
scenario (healthy / empty / error), surface (Sessions / Files nested / Terminal),
and a gesture log inspector.

## Checks

```sh
node --test app-pull-refresh-4602/smoke-test.mjs
```

The smoke test executes the mock's gesture decision function against synthetic
contacts: axis lock, threshold, non-top surrender, horizontal surrender, nested
and Terminal exclusion, and single-commit release. **10/10 pass.**

### Real browser verification (Chromium, 2026-11-27)

Served over `python3 -m http.server` and driven with Playwright pointer events at
device widths 390 and 375 (review host 1280×900). Observed:

| Check | Observed |
|---|---|
| Device content width | exactly 390 / 375 CSS px, no scaling |
| Short pull (30 px) | indicator retracts to 0, log `release 30px → cancel, no request` |
| Qualified pull (90 px) | `aria-busy=true`, indicator `active busy`, then `request #1 applied 14 rows` |
| Selection across refresh | `aria-selected="true"` retained on the chosen row |
| Not at top (`scrollTop=220`, scrollHeight 1239 > clientHeight 780) | no indicator, **no request** |
| Horizontal drag | indicator stays 0; pager edge hint shown mid-drag |
| Nested collection scroller | no host capture, no request |
| Terminal surface | no host capture, no request |
| Empty scenario | header Refresh visible and functional (`applied 0 rows`) |
| Failure scenario | `failed; last known rows kept`, 14 rows retained, Retry present |
| Console | only a `favicon.ico` 404; no script errors |

Screenshot: `.playwright-mcp/screenshots/proto-4602-pull-375.png` (local evidence,
not committed). This is Chromium touch/pointer emulation — **no Safari or
physical-device claim**, and not production acceptance.

## Limitations / non-goals

- A mock is not production acceptance. SC-05 still needs Chromium/Playwright
  proof against the real App fixture after implementation.
- The 64 px threshold and 0.5 drag resistance are **initial proposals** to be
  tuned by observation, exactly as #4602 §4 states.
- Does not decide the Web refresh placement — that is precise reuse of the
  existing Sessions disclosure.
