# Web Frontend Architecture

Final module map and rules after the layering migration (#649 / #655).
Product design truth lives in [`docs/design/`](../design/README.md); this
document describes how the code is organised and where new code goes.

## Architecture vocabulary

The model answers **what a module means in Nession**, not how it is built
(#801). It is the design system's own vocabulary — Product Model, Pattern,
Experience, Capability — expressed as directories, so that product semantics,
the design system, the source layout and the lint gate all use one language.

| Layer | Answers | Owns | Physical home |
|---|---|---|---|
| **app** | How does Nession compose its experience? | shell, composition root, bootstrap/router/auth, chrome, and the per-experience composition (`app/experiences/{web,app}/`) | `app/` |
| **product** | What is a Nession product concept? | Session, Terminal, Workspace, Agent, and the **Product Patterns** the design system names | `product/<concept>/` |
| **capabilities** | What can be discovered, activated or contributed? | Files, Env, Commands, Claude Code, Git… as vertical slices (`api/ model/ components/ contribution.ts`) | `capabilities/<name>/` |
| **platform** | How does transport / runtime / attach work? | React-free terminal runtime, session-runtime ownership, socket, attach, persistence | `platform/<domain>/` |
| **shared** | What is generic and product-agnostic? | generic hooks, pure helpers, the markdown pipeline | `shared/` |
| **components/ui** | What is a generic UI primitive? | shadcn primitives and wrappers — never Nession semantics | `components/ui/` |

### Dependency direction

```text
app  ──────────────▶ product | capabilities | platform | shared | components/ui
product  ──────────▶ extensions | platform | shared | components/ui
capabilities  ─────▶ product | platform | shared | components/ui
platform  ──────────▶ shared | components/ui
shared  ───────────▶ components/ui
components/ui  ────▶ —
```

Same-layer imports are allowed; anything against the arrows above is a reverse
import and a lint error (`nession/no-reverse-imports`,
`web/eslint-plugin-nession/rules/no-reverse-imports.js`).

Two constraints that are *not* expressible as a direction and stay prose:
PRINCIPLE #5 — a capability may contribute views and state but must not define
global structure, so `capabilities/*` reaches the shell only through a
contribution contract (`app/workspace/capabilities.ts` +
`viewBindings.ts`), never by importing `app/` internals. And `platform` is
React-free where it already is (`core/terminal-runtime`); that property is not
something the layer rule can enforce.

### Current layout → target owner

The vocabulary above is the target. This table is the migration state, and it is
the honest answer to "where does this go today" until the row moves.

| Today | Target owner | Phase |
|---|---|---|
| `app/` shell, composition, chrome | `app/` | — (stays) |
| `app/experiences/app/` — App experience: spatial shell, gestures, page index | **done** | 2 |
| `app/experiences/web/` — Web experience: the frame, list column vs overlay | **done** | 2 |
| `app/workspace/` | `app/` | 2 |
| `app/patterns/` — canonical patterns | `product/<concept>/patterns/` | **3 (started)** |
| `app/patterns/` — app chrome (`SidebarRail`, `AppToolHeader`, …) | `app/` chrome | 3 |
| `product/session/` — the Session concept (model, state, UI, hooks) | **done** | 3 |
| `product/agent/` — the Agent concept | **done** | 3 |
| `product/terminal/` — the Terminal concept, incl. the capsule subsystem | **done** | 3 |
| `features/server` | **undecided** — see below | 3 |
| `features/capabilities` | `product/capability/` | 4 |
| `features/{files,env,commands,claude-code}` | `capabilities/<name>/` | 4 |
| `features/explorer` | undecided — a reusable framework, not a capability | 5 |
| `extensions/` | `capabilities/*/contribution.ts` + a registry | 4 |
| `core/`, `runtime/`, `services/` | `platform/<domain>/` | 5 |
| `atoms/` | follows its owner (`product/*/state`, `platform/*/state`) | 5 |
| `lib/` — generic | `shared/lib/` | 5 |
| `lib/` — owner-specific (`auth`, `hashRouterUrl`, `envParser`, `languageIdToCodeMirror`, `resolveAutoP2pUrl`) | that owner | 5 |
| `markdown/` | `shared/` (already the rule's model) | 5 |
| `components/ui/`, `shared/`, `test/` | unchanged | — |

### How the migration is allowed to proceed

An extraction is only possible while the module it needs has already moved, and
`product → features` is forbidden. So a pattern cannot be lifted out of its
feature on its own: the Session patterns need
`features/sessions/model/domainState`, and moving them alone would leave each
one importing the place it just left.

There are exactly two ways out, and this is the decision:

- **Move a concept whole** — `features/sessions` → `product/session` in one
  change. Granular but honest; the rule never loosens.
- **Allow it temporarily** — let `features` and the new layers import each other
  until `features/` is empty.

**Taking both, in that order.** Concepts move whole for as long as that is
possible — `product/session` moved whole, all 26 files at once. It stopped being
possible the first time a concept that has already moved was needed by one that
has not: `features/agents` imports the Session concept, so once `sessions`
became `product/session`, `agents` was reaching up out of a layer below it.

So `features` now has the **transitional allowance in both directions** — see
`MIGRATION_FROM` / `MIGRATION_INTO` in the rule. It is deliberately narrow: it
opens `features ↔ product` and nothing else, so `components/ui` reaching into a
feature is still an error and so is `shared → features`. It is removed when
`features/` no longer exists (Phase 7), at which point the two constants go and
the layers are related by the table alone.

Two other rules decide the ambiguous cases, both from #801's principles:

- **State follows ownership, not state-management technology.** "It is a Jotai
  atom" is not an architectural boundary; a Session atom belongs to the Session
  owner.
- **A helper that can name its owner does not belong in generic `lib/`.** If the
  answer to "which product / capability / platform owner is this?" is anything
  other than "none", it goes there.

### Naming collisions found while surveying (unresolved)

- Two different components are both called `ConnectionStatus`.
  `features/sessions/components/ConnectionStatus.tsx` is the canonical pattern —
  it implements the three independent dimensions
  (`patterns/connection-status.md`: Agent / Workspace Location connectivity,
  Session lifecycle, this-client attachment).
  `app/patterns/ConnectionStatus.tsx` is a single-dimension client badge used
  only by `LoginPage`. The canonical owner is the former; the latter needs a
  name that says what it is.
- `features/capabilities/` (the product capability lifecycle:
  `discovery` / `presence` / `registry` / `model` / `facts`) is **absent from
  both module maps** — this one and `web/CLAUDE.md`. It is not a feature; it is
  the generic capability model, and it belongs to `product/capability/`.
- **`features/server` has no obvious owner.** The Product Model's concepts are
  Workspace, Workspace Location, Session, Terminal, Agent — Server is not among
  them, and its tree groups Server under "infrastructure / context" rather than
  under product or capability. It is three files (`ServerPlugin`,
  `ServerInfoMenu`, `index`), imported only by `app/`, so it moves whenever the
  answer arrives; picking one now would be guessing at the product model.
- **`product → extensions` is a real edge, not a leak.** Moving `AgentDetail`
  into `product/agent/` surfaced it: the pattern renders the `agent-detail`
  slot through the registry. That is PRINCIPLE #5 working — Nession owns the
  structure, the contribution fills a hole in it — so the registry is treated as
  a contract the product layer may call, distinct from reaching into a
  capability's internals. Phase 4 inherits the distinction when `extensions/`
  becomes `capabilities/*/contribution.ts`.

### `extensions/` today

`extensions/` (extension registry + `claude-code` UI contributions) sits outside
the ladder: it is imported by app and feature code through the registry contract
and composes the feature it extends. The rule models it as a rung of its own
(`extensions`) rather than folding it into `features`, so that
`extensions → features` is allowed while `platform → extensions` stays
forbidden. The mutual `features ↔ extensions` allowance is deliberate. Phase 4
absorbs it into `capabilities/*/contribution.ts`.

`markdown/` is `shared`. Its consumers are `features/files` *and*
`lib/languageId`, and a `shared` module importing it pins it to the bottom rung.
The resulting `markdown ↔ lib` cycle is deliberate — both files document it;
general language detection needs markdown's ranked signals, and markdown cannot
host the general extension/basename tables without importing them back.

> Every directory under `web/src/` is either mapped in the rule's
> `LEGACY_TO_LAYER` or listed in `NON_LAYER_DIRS` with a reason, and a fixture
> asserts that against the real directory listing. An unclassified directory
> resolves to `unknown`, which the rule skips — so it would look covered while
> going unchecked in both directions (#793).

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
│   ├── workspace/           # WorkspaceShell, capabilities.ts, viewBindings.ts,
│   │                        #   workspaceContext.ts, views/{files,session,agent,env,claudeCode}
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
├── services/                # socket/ (WebSocketService, MessageRouter, clientId) +
│                            #   attachPrefs, sessionAttachProfile, deepLinkAttach, addressSelection
│                            #   — capability plugins live in features/, not here
├── shared/hooks/            # generic hooks importable by every layer (useWebSocket,
│                            #   useMediaQuery, useAddressPlan, useDialogReset)
├── components/ui/           # shadcn/ui primitives + wrappers (shared; added via CLI)
├── lib/                     # pure helpers (cn, format, encoding, session-first-free utils)
├── atoms/                   # shared jotai atoms (connection, session, probe)
├── extensions/              # registry + extension contributions (own rung)
├── markdown/                # markdown pipeline (shared)
└── test/                    # vitest setup + shared mocks (not a layer)
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
- **Workspace capabilities**: `app/workspace/capabilities.ts` registers what the
  Workspace can show and when each is available; `app/workspace/viewBindings.ts`
  registers how each is drawn (`app/workspace/views/`). A capability's name and
  state come from its provider, never from its view — see
  `docs/design/workspace.md`, "Contribution model".
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
