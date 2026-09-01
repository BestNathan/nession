# Web Active Terminal — Canonical Screen (terminal-native chrome)

**Date:** 2026-09-01
**Status:** Approved (brainstorming)
**Umbrella:** [#561](https://github.com/BestNathan/nession/issues/561) Phase 2A
**Visual language:** [`docs/design/visual-language.md`](../../design/visual-language.md) (PR #562)
**Composition:** [`docs/design/composition.md`](../../design/composition.md) (PR #562)
**Pattern specs:** [`docs/design/design-system/patterns.md`](../../design/design-system/patterns.md)
**Branch:** `feat/web-active-terminal-canonical` (base: `origin/staging` — session-first shell is unreleased there)

---

## Goal

Produce and approve the **Web Active Terminal canonical screen** at `1440 × 900` on the staging session-first shell, validating the visual language of PR #562.

Primary design question (from #561):

> Does the UI make the Terminal unmistakably dominant while keeping Session navigation and connection context immediately available but visually quiet?

The screen is produced with **real components + a deterministic fixture route** — the same fixture becomes the Phase 6 golden-baseline source.

## Current state (staging)

- `web/src/session-first/` implements the 9 pattern specs (patterns/), `TerminalCapsule` (rearchitected in #551, token-positioned), `TerminalWell`.
- Remaining visual-language gaps:
  - Global chrome bar with a large **"Nession" wordmark** (text-lg semibold) — violates P2 / "no product wordmark in shell".
  - Sidebar uses `bg-sidebar` + `border-r` — two separation cues stacked.
  - `SessionHeader` renders as a bordered bar with title + AgentContext + ConnectionStatus + SurfaceSwitcher.
  - Rows use `rounded-lg` + `bg-muted` selection — boxed appearance.
  - Shell chrome uses `--sf-*` local vars (convergence is Phase 5 — this PR does not tokenize them, only re-arranges).

## Design — terminal-native chrome

The approved direction: **chrome is styled as if it could render inside the terminal itself** — no bands, no background blocks, hairline separators, mono micro-labels. The Terminal is the only bright surface.

```text
┌─────────────────────────┬───────────────────────────────────────┐
│ search… [▾]  + [create] │ fix-terminal-reconnect                │
│                         │ codex · devbox-01 · online · attached │ ← session 行
│ ● fix-terminal…         │ [Terminal | Workspace]                │
│ ● design-system         │ ┌───────────────────────────────────┐ │
│ ○ prod-shell            │ │                                   │ │
│ ⋮                       │ │      TERMINAL (唯一亮面)           │ │
│  server: connected      │ │                                   │ │
│                         │ │            [input  ▸]             │ │
│                         │ └───────────────────────────────────┘ │
└─────────────────────────┴───────────────────────────────────────┘
```

### 1. Shell composition

- **Global chrome bar removed.** No wordmark, no separate top bar. The sidebar header row and the session line are the only chrome.
- Sidebar background block removed (`bg-sidebar` → canvas); separation is a **hairline** `border-r` on the same canvas.
- Chrome budget: sidebar head row + session line ≈ 70 px of 900; the Terminal well owns the rest.
- No rounded blocks, no shadows on chrome (R-S5); elevation belongs only to the capsule.

### 2. Sidebar

- **Row selection**: 2px accent left bar + session name in `text-foreground`; no background box (one coherent cue; SessionItem anti-pattern).
- Row content unchanged: name (primary) → metadata line `shell · agent · recency` (tertiary) → state-driven copy (existing `agent.*` channel colors).
- Kill button keeps hover/focus disclosure (P8); selected row shows it.
- Header row: search / filter / sort / create keep function; quiet styling (no title block, ghost input, no background).
- Footer row: overflow menu + `server: connected` micro-text (server connection status lives here; degraded → colored).

### 3. Session line (replaces SessionHeader bar)

- No bar, no `border-b`; one line of text.
- Session name in **mono, semibold** (session names are terminal objects; R-T2).
- Context line, muted mono: `codex · devbox-01 · online · attached` — workload · Agent identity · the three state channels.
- **State-driven emphasis** (P3): all-muted when healthy; a degraded channel fragment switches to `agent.offline` / `agent.error` color + weight. This is the compact form of ConnectionStatus in the header.
- `[Terminal | Workspace]` — text-only switcher; active item foreground/accent, no segmented background.

### 4. Global state and errors

- Server connection → sidebar footer micro-text (§2).
- Error banner unchanged (destructive surface; state-driven, legal).
- Degraded states escalate in place (session line / row copy), never via new chrome.

### 5. Terminal well + capsule

- `TerminalWell` unchanged: flush, `--sf-terminal-well` (Catppuccin base), the only bright surface.
- `TerminalCapsule` untouched (token-positioned float, flat/stacked per #551); the only elevated element.

### 6. Fixture route (deterministic)

- `/fixture` route (HashRouter), always available, hidden from navigation.
- Renders the **real** session-first component tree (`SessionFirstShell` → `SessionFirstMain`).
- Deterministic data: 6 sessions, 3 agents:
  - `fix-terminal-reconnect` — selected, attached, healthy
  - `design-system` — healthy, detached
  - `prod-shell` — Agent `offline` (state-driven emphasis proof)
  - `staging-deploy` — Session `exited`
  - 2 regular sessions (varied workloads/recency)
  - agents: `devbox-01` online, `macbook` online, `sg-prod` offline
- Terminal: real xterm instance with pre-seeded deterministic content (no network, no transport).
- Fixture data module is standalone and unit-testable; this is the Phase 6 golden-baseline source.

### 7. Verification and tests

- Vitest: fixture data shape test + FixtureShell component test; existing shell tests stay green.
- Playwright e2e: visit `/fixture` at 1440×900 → assert structure (terminal well visible, session line present, exactly one selected row) → screenshot = the canonical approval artifact, posted as a PR comment.
- New styles use existing tokens only (`--sf-*`, generated tokens, shadcn semantic) — no new hex literals.

### 8. Docs sync + out of scope

- Same PR updates:
  - `docs/design/visual-language.md` — surface hierarchy: navigation separation = same canvas + hairline (terminal-native decision).
  - `docs/design/composition.md` — shell geometry: single chrome line, no global bar, chrome budget.
- Out of scope: Workspace canonical screen (Phase 2B), App canonical screen (Phase 2C), full `--sf-*` convergence (Phase 5), capsule internals, interaction/state logic.

## Acceptance

- [ ] Terminal is the unmistakable dominant surface at 1440×900.
- [ ] No global wordmark bar; chrome = sidebar head + session line.
- [ ] Healthy state is quiet (all-muted context line; no badges).
- [ ] Degraded states escalate in place via `agent.*` emphasis.
- [ ] Selection uses one coherent cue (accent bar, no background box).
- [ ] `/fixture` renders the real shell with deterministic data, no network.
- [ ] Playwright 1440×900 screenshot captured and posted for human approval.
- [ ] Docs updated to match the approved screen.
