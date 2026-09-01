# Nession Web UI — Agent Guide

Entry document for work under `web/`. Read this before changing React/UI code.

**This file is not design source of truth.** Product model, IA, tokens, patterns, and measurable UI contracts live in repository architecture docs. Skills and prompts may point here; they must not invent a parallel design system.

Root monorepo workflow (worktrees, CI, release): see repository root `CLAUDE.md`.

---

## 1. Purpose

Nession Web is the browser client for a **remote session workspace**: connect to a Nession server, discover Agents, attach to tmux-backed Sessions, and work primarily in a Terminal surface with session-scoped Workspace tools (Files, Agent detail, …).

It is **not** an AI chat client or agent runtime UI.

---

## 2. Design truth (read these; do not duplicate them)

| Concern | Canonical location |
|---------|-------------------|
| Index | [`docs/design/README.md`](../docs/design/README.md) |
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

**Principle (from #544):** AI decides *what* to change; Nession UI architecture constrains *how* it may look and behave.

When architecture and shipping code disagree, treat `docs/design/` as the **target**. Shipping components (Dashboard, Agent cards, ModeBar, …) are often predecessors of Session-first patterns — do not treat them as the long-term IA.

---

## 3. Product constraints (principles only)

- **Session-first:** Session is the primary navigation object; Terminal is the default work surface; Workspace augments the Session; Agent is infrastructure / tmux proxy context, not the nav parent.
- **Independent state dimensions:** Agent connection, Session lifecycle, and attachment must not collapse into one generic status.
- **Web:** Sessions sidebar + active Session; Terminal | Workspace are **peer** surfaces (one visible at a time) — not a permanent Terminal|Files split shell.
- **App:** Spatial model `Sessions ← Terminal → Workspace`, not a shrunk Web layout. Until a native App ships, narrow/mobile Web may proxy App experience rules (see validation docs).
- **Tokens:** Consume Semantic / Domain / Experience — not Primitive palette literals (`text-green-500`, raw hex). Do not invent ad-hoc spacing/radius/color outside the token model.
- **Contracts:** Measurable layout rules (single-line, height token, overflow strategy, touch target, scroll owner) belong in `design/contracts/` once #545 lands — not as one-off magic numbers in components or copied into pattern Acceptance prose.
- **No second design system** in this file, in skills, or in PR descriptions.

---

## 4. Hard engineering constraints

### Layout of code

| Rule | Detail |
|------|--------|
| Hooks | All custom hooks live in `src/hooks/` (or `src/terminal/hooks/`). Never put `use*` modules under `src/components/`. |
| Components | `src/components/` is UI only. If a file starts with `use`, it belongs in hooks. |
| WebSocket | New capabilities go in `src/services/websocket/plugins/`, not in core `WebSocketService`. |
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
├── App.tsx / main.tsx     # Root shell, router entry, toaster
├── index.css              # Sole global CSS (Tailwind + theme)
├── types.ts               # Shared TS types
├── atoms/                 # Jotai atoms (connection, session, probe, …)
├── components/            # React UI (feature + ui/ primitives)
│   └── ui/                # shadcn primitives (generated + wrappers)
├── hooks/                 # App-level custom hooks
├── services/              # WS client, file ops, deep link, prefs, …
│   └── websocket/         # Core service + plugins/
├── terminal/              # xterm lifecycle, transport, input, state, UI
├── markdown/              # Markdown preview pipeline
├── lib/                   # Pure helpers (cn, encoding, language id, …)
├── extensions/            # Extension registry (e.g. claude-code)
└── test/                  # Vitest setup
```

E2E Playwright lives in repo-root `e2e/`, not under `web/`.

---

## 6. UI building rules

1. **Primitives vs patterns:** `components/ui/*` stay product-agnostic. Session / Agent / attachment semantics belong in feature components aligned with `docs/design/design-system/patterns/*`.
2. Prefer composition of existing patterns over new one-off layout chrome.
3. Web vs App (or mobile) differences must be **intentional** and eventually expressed in contracts (`web` / `app` blocks) — not scattered `if (isMobile)` styling with unexplained magic numbers.
4. Preserve maximum Terminal viewport; keep chrome compact.
5. After functional UI changes, verify with Playwright (local stack + browser) before claiming done — unit/lint alone is insufficient for visual/interaction work.

---

## 7. State and data

- **Jotai** atoms under `src/atoms/` (and `src/terminal/state/`) split by domain (connection, session, layout, input, …). Prefer small atoms over mega-stores.
- Dashboard / attach / file flows go through hooks (`useDashboard`, `useAppConnection`, `useFileViewer`, …) rather than embedding WS calls deep in presentational components.
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
| UI contracts (planned) | See `docs/design/design-system/validation.md` | Assertions → viewport matrix → small visual baselines; gated on #467 then #545–#548 |

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
- Executable token JSON / codegen paths → #467 and `docs/design/design-system/tokens.md`
- Contract file format and assertion helpers → #545–#548 and `contracts.md` / `validation.md`

When unsure whether a change is “design” or “implementation,” update or follow `docs/design/` first, then code.
