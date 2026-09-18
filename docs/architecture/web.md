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
| **capabilities** | What can be discovered, activated or contributed? | Files, Env, Commands, Claude Code, Git… as vertical slices (`Plugin.ts`, `types.ts`, `components/`, `contribution.tsx`) | `capabilities/<name>/` |
| **platform** | How does the machinery work? | transport, runtime, attach, persistence — and framework-level code with no product semantics (the Explorer file-tree framework, the Server plugin) | `platform/<domain>/` |
| **shared** | What is generic and product-agnostic? | generic hooks, pure helpers, the markdown pipeline | `shared/` |
| **components/ui** | What is a generic UI primitive? | shadcn primitives and wrappers — never Nession semantics | `components/ui/` |

**"Capability" means one thing here: the Product Capability** — discoverable,
activatable, with a presence state, met by a user in the UI (Files, Env,
Commands, Claude Code). The wire-protocol adapters on `WebSocketService` used to
be called `CapabilityPlugin` too; they are now `TransportPlugin`
(`services/socket/types.ts`), because they have no presence, are never
activated, and are invisible to the user. Any sentence where "capability" could
mean either is a sentence to rewrite.

### Dependency direction

```text
app  ──────────────▶ product | capabilities | platform | extensions | shared | components/ui
product  ──────────▶ capabilities | platform | extensions | shared | components/ui
capabilities  ─────▶ platform | shared | components/ui
platform  ──────────▶ shared | components/ui
shared  ───────────▶ components/ui
components/ui  ────▶ —
```

`product → capabilities` is **one-way**, and that is measured rather than
assumed. Six real value imports go that way — the Terminal capsule surfaces the
quick-command capability, the Session attach dialog offers env files — and none
come back. PRINCIPLE #3 is what says the direction is right: "capabilities
should naturally gain presence when they become relevant to the current
context" describes a capability appearing *inside* a product context, not a
product appearing inside a capability. If a capability ever needs a Product
Pattern, that is the same decision `extensions ↔ capabilities` already records,
and it should be made then rather than pre-granted here.

Same-layer imports are allowed; anything against the arrows above is a reverse
import and a lint error (`nession/no-reverse-imports`,
`web/eslint-plugin-nession/rules/no-reverse-imports.js`).

Two constraints that are *not* expressible as a direction and stay prose:
PRINCIPLE #5 — a capability may contribute views and state but must not define
global structure, so `capabilities/*` reaches the shell only through a
contribution contract (`app/workspace/capabilities.ts` +
`viewBindings.ts`), never by importing `app/` internals. And `platform/terminal-runtime`
is React-free; that is a property of the module, not of `platform`, and the
layer rule cannot enforce either.

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
| `product/capability/` — the generic capability lifecycle (discovery, presence, registry, model, facts) | **done** | 4 |
| `capabilities/{files,env,commands,claude-code}/` — the four contributable capabilities | **done** | 4 |
| `platform/server/` — the Server transport plugin + its menu | **done** | 3 |
| `platform/explorer/` — the file-tree framework | **done** | 5 |
| `app/workspace/views/claudeCodeView.tsx` — the Claude Code view binding | **done** | 4 |
| `extensions/claude-code/` — the retired UI-section registration | **deleted** | 4 |
| `app/workspace/views/` — the other four Web/App layouts | **split into the experiences** — `experiences/{web,app}/workspaceViews.tsx` | **done (finishes 2)** |
| `app/workspace/AppToolScroll.tsx` — App scroll chrome | `app/experiences/app/AppToolScroll.tsx` | **done (finishes 2)** |
| `core/terminal-runtime/` — the React-free terminal runtime | `platform/terminal-runtime/` | **done** | 5 |
| `runtime/` — SessionRuntime + the attach machinery | `platform/{session-runtime,attach}/` | **done** | 5 |
| `services/` | `platform/{socket,attach}/` | 5 |
| `atoms/` | follows its owner (`product/*/state`, `platform/*/state`) | 5 |
| `lib/` — generic | `shared/lib/` | 5 |
| `lib/` — owner-specific (`auth`, `hashRouterUrl`, `envParser`, `languageIdToCodeMirror`, `resolveAutoP2pUrl`) | that owner | 5 |
| `markdown/` | `shared/` (already the rule's model) | 5 |
| `components/ui/`, `shared/`, `test/` | unchanged | — |

### How the migration was allowed to proceed

Kept as a record because the decision was not obvious and the next layout change
will face the same shape.

An extraction is only possible while the module it needs has already moved, and
`product → features` was forbidden. So a pattern could not be lifted out of its
feature on its own: the Session patterns need the Session model, and moving them
alone would leave each one importing the place it just left.

Two ways out, taken in this order:

1. **Move the concept whole**, which `product/session` did — all 26 files at once,
   granular but honest, the rule never loosening.
2. **Allow it temporarily**, which became necessary the first time an
   already-moved concept was needed by one that had not moved: `features/agents`
   imports the Session concept, so the moment `sessions` became
   `product/session`, `agents` was reaching up out of a layer below it.

The allowance opened exactly one pair of directions (`features ↔ product`, later
`↔ capabilities`), so everything else about `features` stayed enforced —
`components/ui → features` remained an error, and so did `shared → features`.

**It is gone now.** `features/` is empty and deleted, so `MIGRATION_FROM` /
`MIGRATION_INTO` were removed in the same change that emptied it, and the layers
are related by the table alone. A rule that protects nothing is worse than no
rule: it reads as coverage.

Two other rules decide the ambiguous cases, both from #801's principles:

- **State follows ownership, not state-management technology.** "It is a Jotai
  atom" is not an architectural boundary; a Session atom belongs to the Session
  owner.
- **A helper that can name its owner does not belong in generic `lib/`.** If the
  answer to "which product / capability / platform owner is this?" is anything
  other than "none", it goes there.

### Naming collisions found while surveying (unresolved)

- Two different components are both called `ConnectionStatus`.
  `product/session/components/ConnectionStatus.tsx` is the canonical pattern —
  it implements the three independent dimensions
  (`patterns/connection-status.md`: Agent / Workspace Location connectivity,
  Session lifecycle, this-client attachment).
  `app/patterns/ConnectionStatus.tsx` is a single-dimension client badge used
  only by `LoginPage`. The canonical owner is the former; the latter needs a
  name that says what it is.
- **Resolved:** the generic capability lifecycle (`discovery` / `presence` /
  `registry` / `model` / `facts`) used to sit at `features/capabilities/` while
  appearing in neither module map. It was never a feature — it is the model every
  capability is described by — and it now lives at `product/capability/`, which
  is also why it is singular: it is the capability *model*, not a capability.
- **Decided: `Server` and `Explorer` are `platform/`.** Neither was placed by
  #801, and the reasoning is worth keeping because both were tempting to file
  somewhere they do not belong.
  - *Server* is the thing you connect **to** — the same family as socket and
    attach — and it is not a contextual capability: you do not "activate
    Server". The Product Model's concepts (Workspace, Workspace Location,
    Session, Terminal, Agent) do not include it, which is the signal that it is
    machinery rather than meaning.
  - *Explorer* is a file-tree framework carrying no Nession product semantics.
    Not `product` (no product meaning), not `capabilities` (nothing to discover
    or activate), not `shared` (#801 scopes shared to hooks + lib), and — the
    tempting one — **not** `capabilities/files/explorer`. Burying it there
    would have made the next capability that wants a tree violate the rule that
    capabilities reach each other only through public contracts. A reusable
    framework in one capability's internals creates the next violation.

  Widening `platform` to admit a UI framework is deliberate: #801's §7
  convergence list says where `platform` will *come from*, not the whole of what
  it may hold, and "React-free" is a property of `platform/terminal-runtime` rather
  than a precondition for the layer.
- **`product → extensions` is a real edge, not a leak.** Moving `AgentDetail`
  into `product/agent/` surfaced it: the pattern renders the `agent-detail`
  slot through the registry. That is PRINCIPLE #5 working — Nession owns the
  structure, the contribution fills a hole in it — so the registry is treated as
  a contract the product layer may call, distinct from reaching into a
  capability's internals. Phase 4 kept the distinction: the registry is the
  generic mechanism, a capability's contribution is a separate thing that now
  lives with its capability (see `extensions/` below).

### `extensions/` — a mechanism with no content

`extensions/` now holds only `registry.ts` and `types.ts`: the generic slot
mechanism. It sits outside the ladder as a rung of its own, so that
`extensions → capabilities` is allowed while `platform → extensions` stays
forbidden.

Its one registered extension, `extensions/claude-code/`, was **deleted** in
Phase 4. It declared `slots: {}` and contributed nothing: the 2026-09-06
claude-code-workspace spec removed its AgentDetail section and its
terminal-header tab, moving Claude Code to a Workspace tool, and the empty
registration outlived the removal. A directory that exists to register an
extension which contributes nothing is the same failure as a rule that protects
nothing — it reads as coverage. Nothing was lost: `renderSlot` returned `[]`
before the deletion and returns `[]` after.

**The mechanism itself stays.** `docs/design/design-system/patterns/agent-detail.md`
sanctions it — "Extensions may contribute diagnostic data or actions for this
detail view" — so it is a designed extension point that currently has no
contributor, which is a different thing from a dead one. That also means Phase 4
did *not* absorb `extensions/` into `capabilities/*/contribution.ts` as this
document previously predicted: the slot registry is a generic mechanism, not a
capability's contribution, and the two are not the same thing. Where the
registry ends up is still open — it is framework-level code with no product
semantics, which is the `platform` definition, but its slot props name `Agent`,
a Product Model concept, so the move is not free and is not made here.

Claude Code's own contribution — its presence state and its Workspace view —
does live with the capability, at `capabilities/claude-code/contribution.tsx`.

`markdown/` is `shared`. Its consumers are `capabilities/files` *and*
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
│   ├── experiences/         # per-experience composition
│   │   ├── web/             #   SessionFirstWebLayout + workspaceViews
│   │   └── app/             #   spatial shell, gestures, AppToolScroll, workspaceViews
│   ├── workspace/           # WorkspaceShell, capabilities.ts, viewBindings.ts,
│   │                        #   workspaceContext.ts, presentation.ts
│   ├── fixture/             # deterministic screens for /fixture visual tests
│   ├── useAppConnection.ts / useDashboard.ts / useDashboardFilter.ts /
│   │   useDashboardModals.ts / useProbePolling.ts / useRealtimeUpdates.ts /
│   │   useVisibilityReconnect.ts / useDeepLinkRestore.ts /
│   │   useSessionFirst{Attach,DeepLink,MobileNav}.ts
│   └── LoginPage.tsx
├── product/                 # Nession product concepts + their Product Patterns
│   ├── session/             # the Session concept: model, state, UI, hooks
│   ├── agent/               # the Agent concept + AgentDetail pattern
│   ├── terminal/            # the Terminal concept, incl. capsule/
│   └── capability/          # the generic capability model (singular: the model,
│                            #   not a capability): discovery, presence, registry, facts
├── capabilities/            # discoverable / activatable capabilities, vertical slices
│   ├── files/               # file RPC + browser/viewer UI (+ adapters/)
│   ├── env/                 # env capability + manager UI/dialogs
│   ├── commands/            # quick-command capability + presets
│   └── claude-code/         # transport, UI, and contribution.tsx (presence + view)
├── platform/                # transport, runtime, attach — and framework-level code
│   ├── server/              # the Server transport plugin + its menu
│   ├── explorer/            # the file-tree framework (no Nession product semantics)
│   ├── terminal-runtime/    # React-free runtime: controller, transports, input, xterm
│   ├── session-runtime/     # SessionRuntime + its registry (acquire/release leases)
│   └── attach/              # attach state machine, controller, address policy,
│                            #   relay connection, attach prefs/profile
├── services/                # socket/ (WebSocketService, MessageRouter, clientId)
│                            #   — still the `core` layer until Phase 5 finishes it;
│                            #   capability plugins live in capabilities/, not here
├── shared/hooks/            # generic hooks importable by every layer (useWebSocket,
│                            #   useMediaQuery, useAddressPlan, useDialogReset)
├── components/ui/           # shadcn/ui primitives + wrappers (shared; added via CLI)
├── lib/                     # pure helpers (cn, format, encoding, session-first-free utils)
├── atoms/                   # shared jotai atoms (connection, session, probe)
├── extensions/              # the generic UI-slot registry (no contributor today)
├── markdown/                # markdown pipeline (shared)
└── test/                    # vitest setup + shared mocks (not a layer)
```

## Capability layout & ownership

A capability is a vertical slice (`capabilities/files/README.md` is the
original, and the closest thing to an exemplar):

```text
capabilities/<name>/
├── <Name>Plugin.ts      # class implements TransportPlugin; generation-tagged
│                        #   install(connection) — StrictMode-safe
├── types.ts             # wire request/response types
├── index.ts             # the public surface
├── contribution.tsx     # presence state + the view it contributes, if it has one
├── components/          # capability UI (+ __tests__/integration/)
├── hooks/               # capability hooks (+ tests)
├── model/               # pure domain model, if any
└── README.md            # ownership, module map, state ownership, cross-capability deps
```

Claude Code is the reference for the whole slice: transport, wire types, UI,
presence state and its Workspace view are all in `capabilities/claude-code/`,
and the app layer only registers what the contribution hands it.

**A capability keeps its view only when it draws the same one in both
experiences.** Claude Code does, so its `contribution.tsx` supplies a whole
binding. The other four do not — every one of them is drawn differently by Web
and App — so their layouts belong to the experiences
(`experiences/{web,app}/workspaceViews.tsx`) and `viewBindings.ts` pairs the two
halves up. The deciding fact is not taste: `FilesAppLayout` and the App scroll
chrome import `AppBackButton`/`AppToolScroll` from the app layer, so a
capability owning them would be a reverse import, and pushing App chrome down
into `components/ui` would put experience geometry in a layer that is meant to
be product-agnostic. `#801` §6's sketch describes the Claude Code case; this is
the case it does not cover, and the acceptance criterion settles it — "Web/App
差异主要通过 Experience Composition 表达".

For the same reason the web/app pairs used to be written side by side in one
file as a `{ web, app }` object whose two halves were the same element with and
without a wrapper. Expressing that as composition — each experience owning its
own file — is what stops it from becoming a flag on a shared component.

The singleton convention differs where a cycle would otherwise close: `envApi`
and the others are declared in `index.ts`, while `claudeCodeApi` is declared in
`ClaudeCodePlugin.ts`, because `index` re-exports the contribution, the
contribution imports the component, and the component needs the singleton.
Declaring it in the barrel would close that into a cycle.

Cross-capability imports go through the peer's public surface and are recorded
in each README — e.g. `files → explorer` (the file-tree framework),
`env → session` (`EnvFileMultiSelect`), `terminal → commands`
(presets/`useQuickCommands`).

### State ownership

Rules follow #649 (the owner's README holds the detailed table):

- transient / short-lived UI state → component state or an owner hook
- capability state shared across components → capability `model/`/`hooks/` (per
  mount; session-list state is deliberately **not** hoisted to a global atom)
- transport / connection / terminal lifecycle → `platform/terminal-runtime`,
  `platform/<domain>`, `services/socket` (still the `core` layer until Phase 5
  finishes) and `atoms/`
- current page, layout, selected workspace → app layer (`app/`)

### Extension points

- **Transport plugins** (wire APIs): each owner's `*Api` singleton is registered
  centrally in `app/useAppConnection.ts` (`SERVER_PLUGINS`) and installed on
  every `WebSocketService` connection. Renamed from `CapabilityPlugin` in #801:
  one word was carrying both this and Product Capability, and the two share
  nothing — a transport plugin has no presence, is never activated, and is
  invisible to the user.
- **`extensions/registry`**: UI slots (e.g. `agent-detail`, `terminal-header`)
  that an extension may contribute into a product pattern. The mechanism is
  live but has **no contributor today** — Claude Code's sections were retired
  when it became a Workspace tool, and its empty registration was deleted with
  them. Adding one means adding `extensions/<name>/index.ts`, which the
  registry discovers by glob.
- **Capability contributions**: a capability declares its presence state in its
  own `contribution.tsx`, and its Workspace view too *when the two experiences
  draw it the same way* (`capabilities/claude-code/` is the reference). The app
  layer registers what it receives: `app/workspace/capabilities.ts` for
  presence, `app/workspace/viewBindings.ts` for views. A capability's name and
  state come from its provider, never from its view — see
  `docs/design/workspace.md`, "Contribution model".
- **Experience views**: when Web and App draw a capability differently, the
  layouts belong to the experiences —
  `app/experiences/{web,app}/workspaceViews.tsx`, keyed by capability id, with
  `viewBindings.ts` supplying the icon and pairing the halves. Moving a
  capability's view *out* of here and into the capability is only correct if
  both experiences would render the same thing.
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
