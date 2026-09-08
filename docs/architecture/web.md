# Web Frontend Architecture

Final module map and rules after the layering migration (#649 / #655).
Product design truth lives in [`docs/design/`](../design/README.md); this
document describes how the code is organised and where new code goes.

## Layer model

Dependency direction: **app → features → core → shared**. Same-layer imports
are allowed; reverse imports are a lint error (`nession/no-reverse-imports`,
`web/eslint-plugin-nession/rules/no-reverse-imports.js`).

| Layer | Physical home (`web/src/`) | Owns | May import |
|---|---|---|---|
| **app** | `app/` | composition root: the single session-first shell (`SessionFirstShell`), sidebar/workspace chrome, `app-spatial/`, `workspace/tools/`, fixture screens, app-composition hooks (`useAppConnection`, `useDashboard`, `useProbePolling`, deep-link restore), `LoginPage` | features, core, shared |
| **features** | `features/<feature>/` | domain capability plugins + feature UI/hooks/model (`terminal`, `explorer`, `files`, `sessions`, `agents`, `env`, `commands`, `server`, `claude-code`) | core, shared |
| **core** | `core/`, `runtime/`, `services/` | React-free terminal runtime, session-runtime ownership, WebSocket client | shared |
| **shared** | `shared/`, `components/ui/`, `lib/`, `atoms/` | generic hooks (`shared/hooks/`), shadcn primitives, pure helpers, shared atoms | — |

`extensions/` (extension registry + `claude-code` UI contributions) sits
outside the layer ladder: it is imported by app and feature code through the
registry contract and is not importable *by* the layers it composes into.

### Module map

```text
src/
├── App.tsx                 # auth gate → SessionFirstShell (authenticated) or LoginPage
├── main.tsx                # entry, initExtensions(), toaster
├── types.ts                # shared root type barrel
├── app/                    # app layer — shell (see app/public.ts)
│   ├── SessionFirstShell.tsx        # the one authenticated shell
│   ├── SessionFirstWorkspace/Sidebar/Main/Terminal/SpatialLayout…
│   ├── SessionDrawer.tsx, TerminalWell.tsx, shellStyles.ts
│   ├── useSessionFirstShellState.ts # shell state composer
│   ├── patterns/            # SessionHeader, SessionListHeader, AppToolHeader, …
│   ├── app-spatial/         # mobile 3-page pager (Sessions ← Terminal → Workspace)
│   ├── workspace/           # WorkspaceShell + tools/{files,session,agent,envFiles,claudeCode}
│   ├── fixture/             # deterministic screens for /fixture visual tests
│   ├── useAppConnection.ts / useDashboard.ts / useDashboardFilter.ts /
│   │   useDashboardModals.ts / useProbePolling.ts / useRealtimeUpdates.ts /
│   │   useVisibilityReconnect.ts / useDeepLinkRestore.ts /
│   │   useSessionFirst{Attach,DeepLink,MobileNav}.ts
│   └── LoginPage.tsx
├── features/                # one dir per capability (README.md = ownership map)
│   ├── terminal/            # capability plugin, viewport, hooks, state/, capsule/
│   ├── explorer/            # extensible file-tree framework
│   ├── files/               # file RPC + browser/viewer UI
│   ├── sessions/            # list/details, CRUD dialogs, AttachDialog, domainState model
│   ├── agents/              # workspace agent page, AgentContext, data hooks
│   ├── env/                 # env capability plugin + manager UI/dialogs
│   ├── commands/            # quick-command capability + presets
│   ├── server/              # server capability + ServerInfoMenu
│   └── claude-code/         # Claude Code capability plugin
├── core/terminal-runtime/   # React-free runtime: controller, transports, input, xterm
├── runtime/                 # SessionRuntime registry + attach state machines
├── services/                # services/socket WebSocketService + plugins, attachPrefs, deepLinkAttach
├── shared/hooks/            # generic hooks importable by every layer (useWebSocket,
│                            #   useMediaQuery, useAddressPlan, useDialogReset)
├── components/ui/           # shadcn/ui primitives + wrappers (shared; added via CLI)
├── lib/                     # pure helpers (cn, format, encoding, session-first-free utils)
├── atoms/                   # shared jotai atoms (connection, session, probe)
├── extensions/              # registry + extension contributions
└── markdown/, test/         # markdown pipeline, vitest setup
```

## Feature layout & ownership

Each feature mirrors the same skeleton (see `features/{sessions,agents}/README.md`
for the exemplars and `features/files/README.md` for the original):

```text
features/<feature>/
├── <Feature>Plugin.ts   # class implements CapabilityPlugin; generation-tagged
│                        #   install(connection) — StrictMode-safe
├── types.ts             # wire request/response types
├── index.ts             # re-exports + `export const xxxApi = new XPlugin()`
│                        #   (module singleton; FilesPlugin is a per-runtime factory)
├── components/          # feature UI (+ __tests__/integration/)
├── hooks/               # feature hooks (+ tests)
├── model/               # pure domain model, if any
└── README.md            # ownership, module map, state ownership, cross-feature deps
```

Cross-feature imports are allowed through the peer's public surface and are
recorded in each README — e.g. `agents → sessions` (`model/domainState`
channel vocabulary, `ConnectionStatus`), `sessions → env`
(`EnvFileMultiSelect`), `terminal → commands` (presets/`useQuickCommands`).

### State ownership

Rules follow #649 (per-feature READMEs hold the detailed table):

- transient / short-lived UI state → component state or a feature hook
- capability state shared across components → feature `model/`/`hooks/` (per
  mount; session-list state is deliberately **not** hoisted to a global atom)
- transport / connection / terminal lifecycle → core (`core/terminal-runtime`,
  `services/socket`) and shared atoms (`atoms/`)
- current page, layout, selected workspace → app layer (`app/`)

### Extension points

- **Capability plugins** (wire APIs): each feature's `*Api` singleton is
  registered centrally in `app/useAppConnection.ts` (`SERVER_CAPABILITIES`)
  and installed on every `WebSocketService` connection.
- **`extensions/registry`**: UI slots (e.g. `agent-detail`) contributed by
  extensions such as claude-code; consumed by feature components.
- **Workspace tools**: `app/workspace/tools/` registers the tool set for a
  session workspace; features contribute descriptors (types in
  `app/workspace/toolTypes.ts`).
- **Fixture screens**: `app/fixture/` powers the `/fixture*` routes used by
  e2e visual baselines.

## Shell history (why there is one shell)

The v2 (session-first) information architecture is the product target
(`docs/design/information-architecture.md`, `docs/design/migration.md`). The
predecessor Dashboard shell — agents-grid-first, with its own terminal
layouts and agent/session preview dialogs — was deleted in **#655** (Phase 5)
and the default flipped to `SessionFirstShell`; the `nession_session_first`
localStorage flag was removed. No new parallel shell should be introduced;
session-first patterns are canonical (name-collision policy: legacy copies
are deleted, not kept in coexistence).

## Quality gates

- ESLint: `nession/no-reverse-imports` (layer direction, see mapping above);
  `no-primitive-tokens`, `no-cross-experience-token`, `no-capsule-magic-metrics`
  (capsule path), `no-sf-overlay-vars` (app/ shell path).
- Vitest unit + integration projects (config in `web/vite.config.ts`),
  coverage thresholds lines 80 / functions 72 / branches 65 / statements 78.
- Playwright e2e lives in repo-root `e2e/` (not under `web/`) and drives the
  session-first shell.
