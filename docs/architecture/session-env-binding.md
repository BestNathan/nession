# Session Environment Binding

Status: current architecture for #170 Phase A + B.

A Session owns exactly one **Environment Binding**. Client attach/detach owns
transport, control and view; it does not own or mutate the binding. This
document is the canonical explanation of the model, the three runtime layers,
the durable Agent state, and the shell adapter. The executable owners are named
at each point; do not restate their rules here.

## Model

```text
Session
  └── Environment Binding
        desired:       ordered EnvFileRef[] + desired revision
        materialized:  ordered profile content hashes for that revision
        observed:      Agent-applied revision, managed keys, convergence status
```

- **Desired** is user intent. The Server persists it in
  `session_env_bindings` (`crates/nession-server/src/env/binding.rs`), keyed by
  `agent_id:session_name`.
- **Materialized** is the content the Server resolved for a revision. A
  profile edit does not change it; only an explicit `reapply` or a binding
  replacement advances the revision.
- **Observed** is what the Agent actually applied to tmux and to the Session's
  shell adapter. It is reported on every set and rebuilt after an Agent
  reconnect (`server.agent.session-env-binding`); it is not Server authority.

An empty binding is a valid state: desired revision 0, no profiles, no overlay.

## Create-time selection (#3649)

`server.session.create` carries an optional `env_selection_mode` that states
whether the request's `env_files` are an explicit replacement or an inheritance
request:

| Mode | Meaning |
|---|---|
| absent | Legacy: non-empty `env_files` replaces; empty `env_files` inherits the named Project's defaults |
| `inherit` | Resolve the Project's ordered `session_defaults.env_profile_ids`; an explicit `env_files` selection is refused |
| `replace` | Use `env_files` exactly, including `[]` — the explicit "No environment" choice |

Project defaults are Server ENV references. Resolution, snapshot capture and
validation happen at create time through the same `resolve_snapshots` path; an
unsupported mode, an `inherit` without a Project, or a reference the ENV
Library no longer contains refuses the create. There is no fallback to an empty
or different environment.

The resolved selection becomes the Session-owned desired binding only after the
create succeeds (or on the documented ambiguous-create recovery). The Project
declaration is not consulted again: editing defaults later affects future
Sessions only, and an existing Session changes only through its own binding
`set` / `reapply` units.

## Protocol units

| Unit | Owner | Semantics |
|---|---|---|
| `server.session.env.binding.get` | Server | desired + observed state |
| `server.session.env.binding.set` | Server | replace the whole ordered selection; `expected_revision` is a durable compare-and-swap |
| `server.session.env.binding.reapply` | Server | re-resolve desired profiles at a new revision; `expected_revision` is a durable compare-and-swap |
| `agent.session.env.binding.set` | Agent | materialize one revision (profiles + snapshots) |
| `agent.session.env.binding.get` | Agent | observed state for one Session |
| `server.agent.session-env-binding` | Agent → Server | one-way reconnect report of observed state |

`server.session.env.apply|unset` remain as compatibility adapters for the
shipped Web client. They translate to a whole-binding replacement in
`ConnectionHandler::set_session_binding`; they are not a second authority.
Attach carries no environment for canonical clients. A pre-#170 client that
still sends `env_snapshots` on attach is translated, explicitly and with a
warning, into a binding replacement before the attach — never into an
attach-owned overlay.

## Revision compare-and-swap

`set` and `reapply` accept an optional `expected_revision`. When present, the
Server applies it as a **durable compare-and-swap** in the database write
(`Database::compare_and_swap_session_env_binding`), not as a preflight read: a
concurrent Web or MCP writer that advanced the row first makes the write a
no-op. The loser receives `success: false` with `refusal:
"revision_conflict"` (and a sentence naming the expected and current
revisions), **nothing is persisted, and no `agent.session.env.binding.set` is
dispatched**. There is deliberately no `force`, `ignore_conflict` or
automatic retry; the caller re-reads with `get` and decides.

An absent `expected_revision` keeps the legacy unconditional replacement used
by the `apply`/`unset` adapters and by older Web payloads. First-party Web
calls send the revision they last read, so a stale tab is refused rather than
silently overwriting another writer. A conflict is a refusal of intent, not a
materialization failure: `binding` is absent from that reply, while an Agent
failure after a committed revision still returns the resulting desired state.

## Runtime layers

Three layers, deliberately not conflated:

1. **Creation (Layer A).** `SessionManager::create_session_with_binding`
   resolves the ordered snapshots, merges the overlay, and passes the effective
   environment to `tmux new-session -e`. The initial shell process starts with
   it. The Server-connected and P2P create paths both call this function.
2. **Future panes/windows (Layer B).** `EnvManager::apply_binding` writes the
   overlay with `tmux set-environment`; keys the binding stops managing are
   restored to their captured base value or unset with
   `tmux set-environment -u`.
3. **The already-running interactive shell (Layer C).** A Session-local shell
   adapter sources a generated overlay at its next prompt. It does not use
   `send-keys`, does not eval the whole tmux environment, and does not edit the
   user's global rc files.

The tmux Session environment is shared by the Session and is the initial
environment for processes created later. It is never presented as evidence
that an already-running process changed.

## Session-addressed operations (#4080)

A Nession Session is based on its Agent's runtime. The Agent environment is the
legitimate inherited baseline; the Session's binding overlays explicit values.
An Agent-owned capability that executes an operation **on behalf of a Session**
resolves values in that order:

```text
explicit Session override (a key this binding manages)
  → inherited Agent environment
  → absent
```

The executable boundary is
`nession_common::session_env::SessionEnvironment`, implemented once by the Agent
in `crates/nession-agent/src/session_env.rs`. Its read side is
`EnvManager::session_overrides`, which returns only the keys the binding
manages and tmux currently holds. A key the Session merely inherited is
deliberately absent: it is not a Session override, so a provider can put every
Session candidate ahead of every Agent candidate without mistaking an inherited
value for an explicit one.

Consumers:

- **GitHub credential.** The client is selected per Session-addressed request:
  `Session.GITHUB_TOKEN → Session.GH_TOKEN → Agent.GITHUB_TOKEN → Agent.GH_TOKEN`
  → not authenticated. The transport and cache are reused, but the cache key
  carries the effective credential's fingerprint (never the token), so two
  Sessions with different tokens share neither identity nor data. The GitHub
  transport is credential-free at Agent composition.
- **Git children.** `GitCmd` applies the Session's explicit overrides on top of
  the inherited Agent environment. Nession's fixed rules still win: the
  repository-variable scrubs (`GIT_DIR`, `GIT_WORK_TREE`, …) and the forced
  prompt/locale policy are applied after the overrides.
- **Claude MCP CLI/probe.** These children already read the Session's observed
  `HOME`, `CLAUDE_CONFIG_DIR` and `PATH` from its tmux environment and inherit
  the Agent for everything else. Deliberate host-global discovery (the Agent's
  own `~/.claude` for global configuration) remains Agent-scoped.

Failure and edge semantics:

- A binding record that cannot be read or a tmux read that fails is reported
  explicitly (`client_unavailable` / `session_environment_unavailable` with a
  value-free message). It is **never** collapsed into "no override", which
  would silently select an Agent credential the Session replaced.
- An explicitly bound empty value is a Session value: a credential treats it as
  "no credential" and does not fall through to another alias or the Agent.
- Removing a key from the binding restores the captured baseline, so the Agent
  value applies again. A managed key that tmux no longer holds has no explicit
  value and likewise falls back to the Agent.
- These reads follow the observed materialization: a `set`/`reapply` affects
  the next request; no Agent restart is involved.
- No environment value is ever logged, returned in a protocol response, or
  placed in a cache key. Errors name the failing record/key and the Session
  only.

Agent-originated, non-Session operations (Agent configuration, tmux
orchestration, EROFS image build/cache, Server/MCP service authentication, CLI
self-update) continue to use the Agent's own environment; no Session scope is
invented for them. Session creation inheritance (Layer A) and tmux environment
materialization are unchanged.

## Create failure and retry (#2812)

Creation is one multi-step operation owned by `SessionManager`; the durable
binding is one of its steps, not a transaction of its own. Once
`new-session` has created the Session, a failure or timeout in any later step
— including `record_created_binding` — removes that Session and the binding
state the attempt wrote before the original error is returned. A retry of the
same name therefore starts from an absent Session. A same-named Session that
existed before the create is never removed.

The executable contract, the per-name creation serialization, and the
ambiguous-cancellation ownership token live on
`SessionManager::create_session`; this section states only the binding
consequence.

## Managed-key baseline

For every key the binding manages, the Agent records what tmux held before
Nession managed it:

```text
MODE      -> Some("default")
API_TOKEN -> None
```

On replacement:

- a still-managed key gets the new overlay value;
- a removed key with `Some(value)` is restored to that value;
- a removed key with `None` is unset.

The baseline is captured before the first mutation of a revision, so a read
failure aborts the apply rather than recording a value nobody observed.

The durable record is part of that proof. A `binding.json` that exists but
cannot be read or parsed is never treated as a new Session: the apply fails
before the first tmux read or mutation, the record and the generated overlay
are left exactly as found, and the error is bounded — it names the failing
durable record, never a key or a value. The observed status is `error` with no
claimed revision or managed keys, not an absent binding. A missing
`binding.json` beside surviving materialization files (`env-runtime.sh`,
`revision`, `shell-revision`) is the same damaged state. Only a state
directory with neither the record nor those artifacts is verified first use,
and only there may a new baseline be captured. Repairing the record restores
the original baseline path without a second state owner.

## Reserved keys

Environment profiles cannot control runtime-critical keys. The policy lives in
`reserved_key_reason` (`crates/nession-agent/src/tmux/env.rs`) and is applied
where the overlay is merged, so every path shares it. A collision is warned
about in the operation's reply and the base value wins.

## Durable Agent state and secrets

Each Session has a directory under `<agent>/env-bindings/<session>/`
(mode `0700`; files mode `0600`):

```text
binding.json       observed revision, materialized profiles, managed baseline
env-runtime.sh     the shell overlay (exports/unsets for managed keys only)
revision           the revision the overlay represents
shell-revision     the revision the interactive shell last reported applying
```

**This is a plaintext copy of the overlay and of any baseline value the binding
overrides, and it can therefore contain secrets.** It exists so that removing a
binding restores `MODE=default` rather than silently unsetting it, including
across an Agent restart. The files are scoped to the Agent's own state
directory and never travel on the wire. Do not add another durable copy of
profile content without updating this owner.

## Shell bootstrap

The shell an adapter targets is resolved from tmux's `default-shell` first,
then the Agent process's `SHELL`, then the passwd login shell for the Agent's
uid. The passwd fallback matters in container images that set neither: the
adapter is resolved before `new-session` starts a tmux server, so the
pre-session query cannot answer even though tmux resolves the passwd shell a
moment later. Do not treat the pre-session tmux answer as the only authority.

Only `bash` and `zsh` have adapters in this phase. Both are Session-local:

- **bash** is launched as `bash --rcfile <session>/shell/bash/bashrc -i`. The
  generated rcfile sources `/etc/profile` and the user's normal profile chain,
  then installs a `PROMPT_COMMAND` hook. The user's `~/.bashrc` is never edited
  (and, matching a login shell, is not sourced unless the profile sources it).
- **zsh** selects the adapter through `ZDOTDIR`. Wrapper `.zshenv`, `.zprofile`,
  `.zshrc`, `.zlogin` and `.zlogout` source the user's own files (using
  `$HOME`, or a validated custom `ZDOTDIR` preserved as
  `NESSION_RUNTIME_USER_ZDOTDIR`) and install a `precmd` hook in `.zshrc`.

The hook compares the revision file with the shell's last applied revision,
sources `env-runtime.sh` only when they differ, and writes `shell-revision`.
Because it runs at a prompt boundary, a foreground TUI receives no input and
no synchronization.

Any other shell degrades explicitly: Layers A and B still materialize, and the
observed status is `unsupported_shell` rather than a claim that the current
shell converged.

### Original zsh configuration provenance (#4605)

The Agent that composes a Session may itself have been launched from a Nession
Session's shell, so its inherited `ZDOTDIR` can name a *generated adapter*
rather than user configuration. `EnvManager::resolve_zsh_user_configuration`
is the one owner that interprets it, once at the canonical producer
(create and repair):

- An unset or empty `ZDOTDIR` uses the generated wrapper's runtime `$HOME`
  fallback — the target shell's home, not the Agent service's.
- A nonempty value is canonicalized (symlinks resolved) and checked against the
  Agent's configured state root (`<agent>/env-bindings`) and the generated
  adapter shape (`<root>/<session>/shell/zsh`, identified by the
  `.nession-adapter` marker or the generated `.zshenv` header that legacy
  adapters also carry). A path that names a managed adapter is never a user
  baseline, whether it was inherited directly or through a symlink alias.
- For managed provenance the producer recovers a validated original directory
  from the owning Session's durable `binding.json` (`zdotdir_origin`), then
  from an inherited `NESSION_RUNTIME_USER_ZDOTDIR` / legacy
  `NESSON_USER_ZDOTDIR` marker. A recovered directory must be absolute and
  non-managed. When neither source validates, the Session falls back to its
  own `$HOME` and reports the degradation; it never guesses a custom directory
  or follows a managed path.
- A legitimate absolute custom `ZDOTDIR` is preserved. A relative one is
  refused (it cannot name a stable directory) and degrades to `$HOME`.

The validated directory is delivered as `NESSION_RUNTIME_USER_ZDOTDIR` and
recorded in the Session's `binding.json`, so a later repair and a Session
launched from this one recover the same origin instead of the adapter path.

At create time the inherited Agent environment is sanitized at the same
boundary: a `ZDOTDIR` that names a managed adapter, and both user-marker names,
are stripped before the Session baseline is composed. Legitimate custom
`ZDOTDIR`, ordinary user variables, `NESSION_MCP_TOKEN` and other Agent-scoped
settings are preserved; the existing `NESSION_RUNTIME_*` / `NESSON_*` prefix
policy still owns the rest. The generated wrapper template never interpolates
environment values into diagnostics.

Generated zsh wrappers add two defenses in the shell itself:

- a **non-exported per-phase reentrancy guard**, so one process cannot source a
  phase twice, while a legitimate nested zsh process (a fresh process) still
  initializes once per applicable phase;
- **managed-target rejection**: a target directory carrying the adapter marker
  or the generated `.zshenv` header is refused, and the Session `$HOME` is used
  instead. One bounded, value-free line identifies the refusal in an
  interactive process; non-interactive shells stay silent.

### Repair and operator recovery

`apply_binding` repairs a recorded Session's generated zsh adapter and owned
tmux shell controls (`ZDOTDIR`, the user marker and the adapter's runtime /
revision paths) before materializing a revision.
`EnvManager::repair_recorded_zsh_adapters` performs the same repair once at
Agent startup for recorded Sessions that still exist; a tmux that cannot
answer skips that pass rather than guessing. Repairs are atomic and idempotent,
rewrite only recognized generated artifacts, and leave profiles, revisions,
baselines, instance identities, the tmux global environment and other Sessions
untouched. A converged adapter writes nothing and reports nothing.

An already-running shell keeps the wrapper functions it loaded at startup; a
new shell or pane is what picks up a repaired adapter. The binding apply reply
says this explicitly when a repair changed something. A `binding.json` that
cannot be read or parsed remains fail-closed as described above; repair never
treats it as a new Session.

Operator recovery: open a new shell or pane in the affected Session, or restart
the Agent so the startup repair runs — do not edit generated adapter files. A
temporary child shell may set an absolute, validated
`NESSION_RUNTIME_USER_ZDOTDIR` to the user's real configuration directory
without changing the durable binding.

## Observed status

`in_sync`, `pending_shell`, `unsupported_shell`, `error` (and the transient
`applying` vocabulary) are reported by the Agent. `pending_shell` means the
materialized revision is on tmux and waiting for the shell's next prompt;
`unsupported_shell` means this Session has no adapter; `error` carries the
tmux failure. A child process already running when the binding changes keeps
its original environment — this is the honest contract.

When the Agent cannot be asked for the observed half, the state carries an
`error` naming that failed observation alongside the desired side (and the
last cached observed state, when there is one). No `in_sync` or other
convergence status is synthesized from the desired revision alone.

## Reconnect and migration

- An Agent restart or reconnect reports every recorded observed state; the
  Server ignores names absent from its Session registry. The Server's observed
  cache is rebuilt from that report or from a live `binding.get`.
- A Server restart loses only the observed cache. Desired bindings are durable
  and are read back from the database.
- A Session that predates the binding model has no recorded state: desired is
  empty and no profile identity is guessed from matching variables. A binding
  first applied to such a Session snapshots the current tmux environment as its
  baseline; its already-running shell has no adapter, so its status is
  `unsupported_shell` until a new Session is created with one.

## Verification

- `crates/nession-agent/src/tmux/env.rs` unit tests: ordered last-wins merge,
  reserved-key refusal, baseline restore/unset through a fake tmux, real
  bash/zsh prompt convergence with user configuration preserved, and the
  original-zsh provenance rules (custom directory preserved, managed adapter,
  symlink alias and injected marker refused, durable/inherited origin recovery,
  inherited-environment sanitization) (#4605).
- The same module exercises real zsh processes (`zsh_contamination_*`) and real
  tmux Sessions A/B (`zsh_session_isolation_*`) for cross-Session
  contamination, wrapper reentrancy, nested shells, repair, restart repair and
  idempotence. The merged staging Cases for #4605 run those tests on the
  approved macOS runner with private sockets, disposable homes and bounded
  waits.
- `crates/nession-agent/src/tmux/manager.rs` `binding_create_tests`: the
  initial shell sees the binding.
- `crates/nession-agent/src/tmux/manager.rs` `create_recovery_tests`: a
  post-create size or binding failure and a timeout remove the Session and
  leave the name retryable; a pre-existing same-named Session survives; a
  healthy create still records the geometry, the durable binding, and a
  discoverable Session.
- `crates/nession-server/src/server/handler/tests/server_session_env_binding_v1.rs`:
  replace-whole semantics, phase preservation, desired survival on Agent
  failure, reapply content resolution, legacy unset without re-reading the
  removed file, Session-scoped query, reconnect report filtering, and the
  revision compare-and-swap (a stale writer is refused with no durable change
  and no Agent dispatch; concurrent store writers have exactly one winner).
- `crates/nession-agent/src/extension.rs` and the protocol Gates: the manifest
  advertises the units it serves and the generated bindings do not drift.

## Runtime environment namespace

Nession-owned control/integration variables in new Sessions use the canonical
`NESSION_RUNTIME_*` prefix. Session ENV Profiles cannot override it. The
legacy `NESSON_*` prefix remains reserved during migration, to prevent a
Profile from forging a surviving Session's old runtime identity. User-provided
`NESSION_MCP_TOKEN` and other non-runtime `NESSION_*` keys remain bindable.

Old tmux Sessions keep their already-injected `NESSON_*` variables and
pre-existing Bash/zsh adapter files. The Agent accepts the old instance
marker as read-only compatibility input and reuses the same per-Session
overlay/revision file paths for subsequent ENV Binding reapplication. A new
Session does not inherit either the old or the new internal environment
namespace from the Agent daemon; MCP credentials require explicit Session
binding. Neither running shells nor already-running Claude subprocesses
receive a retroactive OS environment change.

`ZDOTDIR` and both user-marker names (`NESSION_RUNTIME_USER_ZDOTDIR`, legacy
`NESSON_USER_ZDOTDIR`) are per-Session shell controls (see *Original zsh
configuration provenance*): they are reserved against Profiles, stripped from
an inherited baseline when they name a managed adapter, and repaired only
within their owning Session.
