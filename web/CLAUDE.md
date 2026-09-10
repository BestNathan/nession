# Nession Web UI — Agent Guide

Entry document for work under `web/`. Read this before changing React/UI code.

**This file is not design source of truth.** Product direction and product decision rules live at the repository root; product model, IA, interaction, visual language, tokens, patterns, and measurable UI contracts live in repository design docs. Skills and prompts may point here; they must not invent a parallel product or design system.

Before proposing or implementing any user-facing Web change, read these two upstream constraints first:

1. [`../VISION.md`](../VISION.md) — where Nession is going and what problem it exists to solve.
2. [`../PRINCIPLE.md`](../PRINCIPLE.md) — the durable rules for product and UX decisions.

`VISION.md` defines product direction. `PRINCIPLE.md` defines how product decisions are made. `docs/design/*` translates those constraints into concrete product and UI models. Existing code does not override that precedence.

Root monorepo workflow (worktrees, CI, release): see repository root `CLAUDE.md`.

---

## 1. Purpose

Nession Web is the browser client for an **intelligent workspace spanning local and remote execution contexts**. Its current implementation connects to a Nession server, discovers Agents, attaches to tmux-backed Sessions, and works primarily in a Terminal surface with contextual Workspace capabilities.

The current tmux/session implementation is not the permanent product boundary. Web should evolve toward the repository Vision and Principles rather than treating today's transport, shell chrome, or feature placement as product truth.

---

## 2. Design truth (read in this order; do not duplicate them)

| Concern | Canonical location |
|---------|-------------------|
| Product direction | [`VISION.md`](../VISION.md) |
| Product principles | [`PRINCIPLE.md`](../PRINCIPLE.md) |
| Design index | [`docs/design/README.md`](../docs/design/README.md) |
| Product model | [`docs/design/product-model.md`](../docs/design/product-model.md) |
| Information architecture | [`docs/design/information-architecture.md`](../docs/design/information-architecture.md) |
| Web interaction | [`docs/design/interaction/web.md`](../docs/design/interaction/web.md) |
| App interaction | [`docs/design/interaction/app.md`](../docs/design/interaction/app.md) |
| Workspace | [`docs/design/workspace.md`](../docs/design/workspace.md) |
| Tokens | [`docs/design/design-system/tokens.md`](../docs/design/design-system/tokens.md) · executable: [#467](https://github.com/BestNathan/nession/issues/467) |
| Pattern prose | [`docs/design/design-system/patterns.md`](../docs/design/design-system/patterns.md) · [#470](https://github.com/BestNathan/nession/issues/470) |
| UI contracts | [`docs/design/design-system/contracts.md`](../docs/design/design-system/contracts.md) · [#545](https://github.com/BestNathan/nession/issues/545) |
| Validation (assert / matrix / visual) | [`docs/design/design-system/validation.md`](../docs/design/design-system/validation.md) · [#546](https://github.com/BestNathan/nession/issues/546)–[#548](https://github.com/BestNathan/nession/issues/548) |
| Migration | [`docs/design/migration.md`](../docs/design/migration.md) |

For product-facing work, apply this precedence:

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
feature design
    ↓
shipping implementation
```

When a lower-level design doc, executable contract, fixture, screenshot, or shipping component disagrees with Vision or Principles, treat the lower level as convergence debt rather than weakening the upstream constraint.

**Existing architectural principle (from #544):** AI decides *what* to change; Nession UI architecture constrains *how* it may look and behave.

---

## 3. Product constraints (principles only)

- **Work first:** organize the experience around what the user is doing, not around a catalog of tools, plugins, or infrastructure.
- **Quiet by default:** a capability being implemented or installed does not entitle it to permanent UI.
- **Contextual capability:** capability presence follows context (`unavailable → available → relevant → active`) and may gain stronger presence only as relevance/activity increases.
- **Progressive disclosure:** show presence/state/smallest useful action first; deeper details, history, configuration, and advanced operations open explicitly.
- **Nession owns experience:** extensions contribute capability/state/actions/views; Nession owns global placement, interaction, hierarchy, and visual language.
- **Session-first current model:** Session is the primary active work object; Terminal is the current default live surface; Workspace is contextual depth; Agent/location is infrastructure context rather than the navigation parent.
- **Workspace is not a feature lobby:** its visible resources/capabilities are context-driven rather than a permanent tool strip.
- **App:** spatial model `Sessions ← Terminal → Workspace`, not a shrunk Web layout; gestures require visible alternatives.
- **Independent state dimensions:** Agent/location connectivity, Session lifecycle, and attachment must not collapse into one generic status.
- **Precision over decoration:** quality comes from spacing, type, hierarchy, motion, feedback, stable geometry, and consistent interaction rather than extra chrome.
- **Tokens/contracts:** use the repository design-system layers; do not create a feature-local visual language or magic metric system.

---

## 4. Hard engineering constraints

### Layout of code

| Rule | Detail |
|------|--------|
| Hooks | Shared hooks in `src/shared/hooks/`, feature hooks in `features/<feature>/hooks/`, app-composition hooks in `src/app/`. Never put `use*` modules under `components/` or `components/ui/`. |
| Components | `src/components/ui/` holds only shared shadcn primitives. Feature UI belongs in `features/<feature>/components/`; shell UI in `src/app/`. |
| Layers | Import direction app → features → core → shared (`nession/no-reverse-imports`). Full module map: `docs/architecture/web.md`. |
| WebSocket | New capabilities go in `src/services/socket/plugins/` (constructor-injected `CapabilityPlugin`s), not in core `WebSocketService`. |
| Types | Core types in `src/types.ts`; domain types in `{domain}/types.ts`; re-export from `types.ts` when needed for compatibility. |
| CSS | Tailwind v4 via `@tailwindcss/vite`. **One** stylesheet: `src/index.css`. Component styles = Tailwind utilities only. |
| Alias | `@/` → `src/` (see `vite.config.ts`). |

### UI kit

- Prefer **shadcn/ui** primitives in `src/components/ui/`. Add via CLI and commit generated files:
  ```bash
  cd web && npx shadcn@latest add <component-name> --yes
  ```
- Inventory / mapping: `.claude/skills/nession-development/references/shadcn-components.md`
- Do not hand-roll tab strips, resize chrome, or destructive confirms when Tabs / Resizable / AlertDialog already cover the need.
- Icon-only controls need Tooltip (or equivalent accessible name).

### Theming

- Chrome UI follows the shadcn dark Zinc/neutral theme.
- **Terminal** keeps Catppuccin Mocha via terminal theme code — independent of chrome theme. Do not restyle xterm to match Zinc.

### Lint and React pitfalls

- **`eslint-disable` is forbidden.** Fix types, deps, or structure properly. `npm run lint` uses `--max-warnings 0`.
- **Event handlers:** never pass a function with optional parameters directly to `onClick` / `onChange`. Always wrap: `onClick={() => fn()}`.
- **Effect / connection ordering:** child effects run before parent effects on first mount. Async connection hooks must initialize to an optimistic in-progress state (e.g. `'connecting'`), not `'disconnected'`, or children reject before connect starts. Under StrictMode (mount→cleanup→mount), do not reject in-flight promise waiters in cleanup — keep them on a ref and settle on the second mount.

### WebSocket singleton

`WebSocketService` is a browser-session singleton: request/response correlation, event pub/sub, auto-reconnect. Prefer existing plugins (`RequestPlugin`, `TerminalPlugin`, `EventPlugin`, …) before adding transport hacks in components.

---

## 5. Directory map (`web/src`)

```text
src/
├── App.tsx / main.tsx     # Auth gate → SessionFirstShell | LoginPage; router entry
├── index.css              # Sole global CSS (Tailwind + theme)
├── types.ts               # Shared TS types
├── app/                   # App layer — the session-first shell + app hooks (app/public.ts)
│   ├── SessionFirstShell / Workspace / Sidebar / Main / Terminal / …
│   ├── patterns/, app-spatial/, workspace/ (+ tools/), fixture/
│   ├── useAppConnection, useDashboard(+Filter/Modals), useProbePolling, …
│   └── LoginPage.tsx
├── features/              # Domain features — each = plugin + components/hooks (+ model)
│   ├── terminal/ explorer/ files/ sessions/ agents/ env/ commands/ server/ claude-code/
├── shared/                # Shared layer — hooks/ (generic React hooks)
├── components/
│   └── ui/                # shadcn primitives (generated + wrappers) — shared
├── core/terminal-runtime/ # React-free terminal runtime (controller, transport, input)
├── runtime/               # SessionRuntime ownership + attach state machines
├── atoms/                 # Jotai atoms (connection, session, probe, …)
├── services/              # WS client (socket/), attach prefs, deep link (core layer)
├── lib/                   # Pure helpers (cn, encoding, language id, …)
├── markdown/              # Markdown preview pipeline
├── extensions/            # Extension registry (e.g. claude-code UI contributions)
└── test/                  # Vitest setup
```
Layers: see `docs/architecture/web.md`. E2E Playwright lives in repo-root `e2e/`.

E2E Playwright lives in repo-root `e2e/`, not under `web/`.

---

## 6. UI building rules

1. **Primitives vs patterns:** `components/ui/*` stay product-agnostic. Session / Workspace / Agent / capability semantics belong in feature/product patterns aligned with `docs/design/design-system/patterns/*`.
2. Prefer composition of existing patterns over new one-off layout chrome, but do not preserve a pattern when the higher-level product model has intentionally changed.
3. Web vs App differences must be **intentional** and eventually expressed in contracts (`web` / `app` blocks) — not scattered `if (isMobile)` styling with unexplained magic numbers.
4. Preserve maximum current-work/Terminal viewport; chrome yields first.
5. A registered extension must not automatically add permanent navigation. Derive presence from context and capability state.
6. After functional UI changes, verify with Playwright (local stack + browser) before claiming done — unit/lint alone is insufficient for visual/interaction work.

---

## 7. State and data

- **Jotai** atoms under `src/atoms/` (and `src/features/terminal/state/`) split by domain (connection, session, layout, input, …). Prefer small atoms over mega-stores.
- Session / attach / file flows go through app-composition hooks (`app/useDashboard`, `app/useAppConnection`) and feature hooks rather than embedding WS calls deep in presentational components.
- Terminal attach supports **relay** (via server) and **P2P** (direct to agent). Respect existing `ConnectionManager` / transport boundaries.

---

## 8. Testing and quality

| Layer | Command / location | Notes |
|-------|-------------------|--------|
| Unit / component | `npm test` (Vitest) | Colocate `__tests__/unit` and `__tests__/integration` |
| Coverage | `npm run coverage` | Thresholds in `vite.config.ts` (lines 78 / functions 72 / statements 76 / branches 65). Pre-push enforces web coverage when `web/**` changes. |
| Typecheck | `npx tsc --noEmit` | Also part of `npm run build` |
| Lint | `npm run lint` | `--max-warnings 0` |
| E2E | `e2e/` Playwright | Login, session lifecycle, terminal I/O; CI workflow `e2e.yml` |
| UI contracts | See `docs/design/design-system/validation.md` | Assertions → viewport matrix → focused visual baselines; update contracts/baselines together when intentional product behavior changes |

Do not lower coverage thresholds or add broad excludes to “make CI green” without owner approval.

---

## 9. Commands

```bash
cd web
npm install          # after package.json changes
npm run dev          # Vite :13000 — proxies /ws and /api → localhost:19090
npm run build        # tsc + vite build → dist/
npm run lint
npm test
npm run coverage
npx tsc --noEmit
npx shadcn@latest add <name> --yes
```

Local full stack (from repo root, isolated HOME recommended — see root `CLAUDE.md`):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml
cd web && npm run dev
```

---

## 10. Out of scope here

- Rust crates, Docker, Kubernetes, release/version bump → root `CLAUDE.md` and `.claude/skills/nession-cicd`
- Product direction / product decision rules → root `VISION.md` / `PRINCIPLE.md`
- Executable token JSON / codegen paths → #467 and `docs/design/design-system/tokens.md`
- Contract file format and assertion helpers → #545–#548 and `contracts.md` / `validation.md`

When unsure whether a change is “design” or “implementation,” start from `VISION.md` and `PRINCIPLE.md`, update/follow the relevant `docs/design/` owner, then change code.
