# Nession Web UI — Agent Guide

Entry document for work under `web/`. Read this before changing React/Web code.

This file is intentionally small. It owns **Web engineering boundaries**, not the UI design system.

## UI / design-system work

For any task involving visual styling, layout, spacing, sizing, typography, surfaces, shadcn/ui, shared UI components, design tokens, product patterns, UI contracts, responsive behavior, or visual validation, **load and follow**:

[`../.claude/skills/nession-web-design/SKILL.md`](../.claude/skills/nession-web-design/SKILL.md)

Do not duplicate design-system rules in this file. The Skill owns the workflow for locating canonical design sources, consuming/extending tokens and components, shadcn integration, pattern boundaries, layout semantics, contracts, and UI validation.

For repository-wide development workflow, worktrees, CI, release, and general test policy, see the root `CLAUDE.md` and the relevant repository skills.

---

## 1. Purpose

Nession Web is the browser client for an intelligent workspace spanning local and remote execution contexts. The current implementation connects to a Nession server, discovers Agents, attaches to tmux-backed Sessions, and exposes Terminal and Workspace capabilities.

Do not infer permanent product boundaries from today's component tree or transport implementation. Product-facing UI decisions belong to the design hierarchy referenced by `nession-web-design`.

---

## 2. Hard engineering constraints

### Code ownership and import direction

| Rule | Detail |
|------|--------|
| Hooks | Shared hooks in `src/shared/hooks/`, feature hooks in `features/<feature>/hooks/`, app-composition hooks in `src/app/`. Never put `use*` modules under `components/` or `components/ui/`. |
| Components | `src/components/ui/` is shared generic UI infrastructure. Feature UI belongs in `features/<feature>/components/`; shell/composition UI belongs in `src/app/`. For design-system/component rules, use `nession-web-design`. |
| Layers | Import direction app → features → core → shared (`nession/no-reverse-imports`). Full module map: `docs/architecture/web.md`. |
| WebSocket | A new capability is a `CapabilityPlugin` (`src/services/socket/types.ts`) implemented inside its own feature (`features/<feature>/<Name>Plugin.ts`) and registered in `app/useAppConnection.ts` (`SERVER_CAPABILITIES`). Do not add capability-specific transport logic to core `WebSocketService`. |
| Types | Core types in `src/types.ts`; domain types in `{domain}/types.ts`; re-export from `types.ts` only when needed for compatibility. |
| CSS | Tailwind v4 via `@tailwindcss/vite`. Global CSS stays in `src/index.css`; component styling stays colocated through the existing Tailwind/component model. Design values and styling policy are owned by `nession-web-design`. |
| Alias | `@/` → `src/` (see `vite.config.ts`). |

### Lint and React pitfalls

- **`eslint-disable` is forbidden.** Fix types, dependencies, or structure properly. `npm run lint` uses `--max-warnings 0`.
- **Event handlers:** never pass a function with optional parameters directly to `onClick` / `onChange`. Wrap it: `onClick={() => fn()}`.
- **Effect / connection ordering:** child effects run before parent effects on first mount. Async connection hooks must initialize to an optimistic in-progress state (for example `connecting`), not `disconnected`, or children can reject before connection startup.
- Under StrictMode mount → cleanup → mount, do not reject in-flight promise waiters during the transient cleanup. Keep them on a ref and settle them from the surviving mount.

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

Use the repository commands rather than inventing local alternatives:

| Layer | Command / location |
|-------|-------------------|
| Unit / component | `just web-test-unit` |
| Integration | `just web-test-integration` |
| Coverage | `just web-coverage` |
| Typecheck + lint + generated design checks | `just web-lint` |
| E2E | repo-root `e2e/` Playwright |

For **UI/design-system validation**, including contract checks, browser verification, visual baselines, canonical viewports, and shadcn/token normalization, follow `nession-web-design` instead of duplicating that workflow here.

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
- UI design system / tokens / shadcn / primitives / patterns / layout / contracts / visual validation → `.claude/skills/nession-web-design/SKILL.md`
- Repository development workflow / worktrees / general testing → root `CLAUDE.md` + `.claude/skills/nession-development`
- CI/CD / Docker / Kubernetes / release → `.claude/skills/nession-cicd`

Keep this separation deliberate. If a UI design rule starts growing here, move it to the design skill or its canonical design source instead of creating another copy.