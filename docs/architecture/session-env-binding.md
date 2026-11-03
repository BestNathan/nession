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

## Protocol units

| Unit | Owner | Semantics |
|---|---|---|
| `server.session.env.binding.get` | Server | desired + observed state |
| `server.session.env.binding.set` | Server | replace the whole ordered selection |
| `server.session.env.binding.reapply` | Server | re-resolve desired profiles at a new revision |
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

Only `bash` and `zsh` have adapters in this phase. Both are Session-local:

- **bash** is launched as `bash --rcfile <session>/shell/bash/bashrc -i`. The
  generated rcfile sources `/etc/profile` and the user's normal profile chain,
  then installs a `PROMPT_COMMAND` hook. The user's `~/.bashrc` is never edited
  (and, matching a login shell, is not sourced unless the profile sources it).
- **zsh** selects the adapter through `ZDOTDIR`. Wrapper `.zshenv`, `.zprofile`,
  `.zshrc`, `.zlogin` and `.zlogout` source the user's own files (using
  `$HOME`, or an explicitly configured `ZDOTDIR` preserved as
  `NESSON_USER_ZDOTDIR`) and install a `precmd` hook in `.zshrc`.

The hook compares the revision file with the shell's last applied revision,
sources `env-runtime.sh` only when they differ, and writes `shell-revision`.
Because it runs at a prompt boundary, a foreground TUI receives no input and
no synchronization.

Any other shell degrades explicitly: Layers A and B still materialize, and the
observed status is `unsupported_shell` rather than a claim that the current
shell converged.

## Observed status

`in_sync`, `pending_shell`, `unsupported_shell`, `error` (and the transient
`applying` vocabulary) are reported by the Agent. `pending_shell` means the
materialized revision is on tmux and waiting for the shell's next prompt;
`unsupported_shell` means this Session has no adapter; `error` carries the
tmux failure. A child process already running when the binding changes keeps
its original environment — this is the honest contract.

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
  reserved-key refusal, baseline restore/unset through a fake tmux, and real
  bash/zsh prompt convergence with user configuration preserved.
- `crates/nession-agent/src/tmux/manager.rs` `binding_create_tests`: the
  initial shell sees the binding.
- `crates/nession-server/src/server/handler/tests/server_session_env_binding_v1.rs`:
  replace-whole semantics, phase preservation, desired survival on Agent
  failure, reapply content resolution, legacy unset without re-reading the
  removed file, Session-scoped query, and reconnect report filtering.
- `crates/nession-agent/src/extension.rs` and the protocol Gates: the manifest
  advertises the units it serves and the generated bindings do not drift.
