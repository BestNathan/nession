# Nession Web UI — Agent Guide

Entry document for work under `web/`. Read this before changing React/Web code.

This file is intentionally small. It owns **Web engineering boundaries**, not product/UI design guidance.

## UI / design-system work

For any task involving visual styling, layout, spacing, sizing, typography, surfaces, shadcn/ui, shared UI components, design tokens, product patterns, UI contracts, responsive behavior, or visual validation, **load and follow**:

[`../.claude/skills/nession-web-design/SKILL.md`](../.claude/skills/nession-web-design/SKILL.md)

The Skill owns the UI/design workflow. Do not duplicate its rules here.

For repository-wide development workflow, worktrees, CI, release, and general test policy, see the root `CLAUDE.md` and the relevant repository skills.

---

## 1. Purpose

Nession Web is the browser client for an intelligent workspace spanning local and remote execution contexts. The current implementation connects to a Nession server, discovers Agents, attaches to tmux-backed Sessions, and exposes Terminal and Workspace capabilities.

Do not infer permanent product boundaries from today's component tree or transport implementation. Product-facing UI decisions belong to `nession-web-design` and the canonical sources it references.

---

## 2. Hard engineering constraints

### Code ownership and import direction

| Rule | Detail |
|------|--------|
| Hooks | Shared hooks in `src/shared/hooks/`, feature hooks in `features/<feature>/hooks/`, app-composition hooks in `src/app/`. Never put `use*` modules under `components/` or `components/ui/`. |
| Components | Shared generic UI infrastructure lives in `src/components/ui/`; feature UI belongs in `features/<feature>/components/`; shell/composition UI belongs in `src/app/`. UI design/component-selection rules live in `nession-web-design`. |
| Layers | Import direction app → features → core → shared (`nession/no-reverse-imports`). Full module map: `docs/architecture/web.md`. |
| WebSocket | A new capability is a `CapabilityPlugin` (`src/services/socket/types.ts`) implemented inside its own feature (`features/<feature>/<Name>Plugin.ts`) and registered in `app/useAppConnection.ts` (`SERVER_CAPABILITIES`). Do not add capability-specific transport logic to core `WebSocketService`. |
| Types | Core types in `src/types.ts`; domain types in `{domain}/types.ts`; re-export from `types.ts` only when needed for compatibility. |
| CSS | Tailwind v4 via `@tailwindcss/vite`. Global CSS stays in `src/index.css`; component styling follows the existing component model. UI styling policy and design values live in `nession-web-design`. |
| Alias | `@/` → `src/` (see `vite.config.ts`). |

### Lint and React pitfalls

- **`eslint-disable` is forbidden.** Fix types, dependencies, or structure properly. `npm run lint` uses `--max-warnings 0`.
- **Event handlers:** never pass a function with optional parameters directly to `onClick` / `onChange`. Wrap it: `onClick={() => fn()}`.
- **Effect / connection ordering:** child effects run before parent effects on first mount. Async connection hooks must initialize to an optimistic in-progress state (for example `connecting`), not `disconnected`, or children can reject before connection startup.
- Under StrictMode mount → cleanup → mount, do not reject in-flight promise waiters during transient cleanup. Keep them on a ref and settle them from the surviving mount.

### WebSocket singleton

`WebSocketService` is a browser-session singleton responsible for request/response correlation, event pub/sub, and reconnect behavior.

Prefer an existing capability plugin over adding transport logic inside components. Current capability implementations include Files, Sessions, Agents, Env, Commands, Server, Claude Code, and Terminal-specific server integration.

---

## 3. Directory map (`web/src`)

```text
src/
├── App.tsx / main.tsx     # Auth gate and router entry
├── index.css              # Global CSS / Tailwind entry
├── types.ts               # Shared TS types
├── app/                   # App composition, shell, workspace, app-level hooks
├── features/              # Domain features: plugin + components/hooks/model
├── shared/                # Shared hooks and generic helpers
├── components/ui/         # Shared generic UI infrastructure
├── core/terminal-runtime/ # React-free terminal runtime
├── runtime/               # SessionRuntime ownership + attach state machines
├── atoms/                 # Jotai atoms split by domain
├── services/              # WS client and other core services
├── lib/                   # Pure helpers
├── markdown/              # Markdown preview pipeline
├── extensions/            # Extension registry / UI contributions
└── test/                  # Vitest setup
```

See `docs/architecture/web.md` for the complete layer model. E2E Playwright lives in repo-root `e2e/`, not under `web/`.

---

## 4. State and data

- Jotai atoms live under `src/atoms/` and feature-owned state directories such as `src/features/terminal/state/`. Prefer small domain atoms over mega-stores.
- Session / attach / file flows go through app-composition and feature hooks rather than embedding WebSocket calls deep in presentational components.
- Terminal attach supports relay (via server) and P2P (direct to agent). Preserve the existing `ConnectionManager` / transport boundaries.
- New feature capabilities should expose a feature-owned API/plugin boundary rather than leaking transport concerns into UI composition.

---

## 5. Testing and quality

Use repository commands rather than inventing local alternatives:

```bash
just web-lint
just web-test-unit
just web-test-integration
just web-coverage
```

E2E Playwright lives at repo root under `e2e/`.

For UI/design-system validation, browser verification, contracts, visual baselines, and canonical viewport rules, follow `nession-web-design` rather than duplicating that workflow here.

Do not lower coverage thresholds, weaken assertions, add broad excludes, or suppress lint failures merely to make CI green.

---

## 6. Common commands

From `web/`:

```bash
npm install
npm run dev
npm run build
npm run lint
npm test
npm run coverage
npx tsc --noEmit
```

From repository root, prefer `just` tasks when an equivalent task exists.

Local full stack:

```bash
HOME=/tmp/nession-demo cargo run -p nession-server
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml
cd web && npm run dev
```

---

## 7. Ownership map

- Web engineering architecture / imports / state / transport boundaries → this file + `docs/architecture/web.md`
- UI design and design-system usage → `.claude/skills/nession-web-design/SKILL.md`
- Repository development workflow / worktrees / general testing → root `CLAUDE.md` + `.claude/skills/nession-development`
- CI/CD / Docker / Kubernetes / release → `.claude/skills/nession-cicd`

Keep this separation deliberate. UI/design guidance belongs in the Skill or the canonical sources it references, not in this file.