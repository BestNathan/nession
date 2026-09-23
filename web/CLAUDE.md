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
| Hooks | Shared hooks in `src/shared/hooks/`, capability/product hooks in `<owner>/hooks/`, app-composition hooks in `src/app/`. Never put `use*` modules under `components/` or `components/ui/`. |
| Components | Shared generic UI infrastructure lives in `src/components/ui/`; capability/product UI belongs in `<owner>/components/`; shell/composition UI belongs in `src/app/`. UI design/component-selection rules live in `nession-web-design`. |
| Layers | The vocabulary is `app` composes `product` / `capabilities` / `platform` / `shared`, over generic `components/ui`; `features/` no longer exists. Rule: `nession/no-reverse-imports`; full model, ownership per layer, and migration state: `docs/architecture/web.md`. |
| WebSocket | A new wire-protocol family is a `TransportPlugin` (`src/platform/socket/types.ts`) implemented inside its own layer (`<owner>/<Name>Plugin.ts`) and registered in `app/useAppConnection.ts` (`SERVER_PLUGINS`). **"Transport plugin" is not "Product Capability"** — the latter is the discoverable/activatable concept with presence (`product/capability`); a transport plugin has no presence and is user-invisible. Do not add protocol-specific transport logic to core `WebSocketService`. |
| Wire names | Three categories, and the name says which (#953): an **operation** is `<answerer>.<subject>.<operation>` and is answered by one runtime; a **notification** is `<emitter>.<subject>.<event>` and is pushed by one runtime; **control** is `control.<verb>` and every runtime handles it. Operations are the only category with generated bindings — a notification or a control wire is a string here, checked by `just check-protocol`. Never invent a `.response` suffix: a reply carries its request's own wire name and is correlated by the envelope's `id` (`MessageRouter` keys its pending map by `id`, and returns before subscribers see a correlated message). |
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
│                          #   experiences/{web,app}/ own each experience's
│                          #   frame and its Workspace layouts
├── product/               # Nession product concepts + their Product Patterns
│                          #   <concept>/patterns/ holds a component that
│                          #   implements a named canonical pattern
│                          #   (docs/design/design-system/patterns/*.md) and its
│                          #   contract; ordinary feature UI stays in components/.
│                          #   A pattern whose styling vocabulary is shell chrome
│                          #   lives in the shell instead — see web.md on
│                          #   SessionHeader, which the layer rule settled.
├── capabilities/          # discoverable / activatable / contributable
│                          #   capabilities, as vertical slices; one that
│                          #   contributes to the shell declares it in its own
│                          #   contribution.tsx (claude-code is the reference)
├── platform/              # transport, runtime, attach — and framework-level
│                          #   code with no product semantics: socket/, server/,
│                          #   protocol/ (React-free — consumer-side contract
│                          #   resolution, #678), explorer/, terminal-runtime/ (React-free),
│                          #   session-runtime/, attach/
├── shared/                # Shared layer: hooks/, lib/ (generic pure helpers),
│                          #   markdown/. May import nothing above it.
├── components/ui/         # Shared generic UI infrastructure
├── (no atoms/)            # state lives with its owner: product/*/state,
│                          #   platform/attach/state
├── (no lib/)              # generic helpers are shared/lib/; owner-specific ones
│                          #   live with the owner that consumes them
├── extensions/            # the generic UI-slot registry (no contributor today)
└── test/                  # Vitest setup
```

See `docs/architecture/web.md` for the complete layer model. E2E Playwright lives in repo-root `e2e/`, not under `web/`.

---

## 4. State and data

- Jotai atoms live in their owner's `state/` (`product/<concept>/state/`, `platform/<domain>/state/`). `src/atoms/` is gone. Prefer small domain atoms over mega-stores. **State follows ownership, not state-management technology** — "it is a Jotai atom" is not a boundary, and there is no central state directory to default into (#801 Phase 5).
- Session / attach / file flows go through app-composition and owner hooks rather than embedding WebSocket calls deep in presentational components.
- Terminal attach supports relay (via server) and P2P (direct to agent). Preserve the existing `ConnectionManager` / transport boundaries.
- A new capability should expose an owner-owned API/plugin boundary rather than leaking transport concerns into UI composition.

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