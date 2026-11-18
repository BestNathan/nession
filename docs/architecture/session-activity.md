# Session Activity ownership

Status: **delivered on `staging` for #3800 (P0) and #3802 (Shell)**. Claude
(#3801) and the Server/Web/App projection (#3804) are downstream issues; this
document owns the domain contract they consume.

Session Activity answers one question — **is this Session's work happening
right now?** — and deliberately not any other:

```text
Session activity (capability-reported)
├── working
├── idle
└── unknown
   attention (orthogonal): input_required
```

It is a fourth, independent state dimension. `session.status` (lifecycle),
Agent connectivity and client attachment are not inputs to it and are never
rewritten by it. `docs/design/product-model.md` owns that product boundary.

## Authority

One Agent owns the answer. A capability provider interprets **its own**
workload; the Agent's `SessionActivityCoordinator` resolves Pane ownership,
fences stale observations and aggregates the Session; Server and UI only
consume the Agent's projection. `SessionWatcher` supplies verified tmux facts
and refreshes the coordinator — it is not a second activity oracle.

The contract lives in `crates/nession-common/src/session_activity.rs`
(`ActivityState`, `ActivityLevel`, `SessionActivityProvider`,
`ActivityReporter`). The runtime owner is
`crates/nession-agent/src/session/activity/`.

## Ownership is semantic, not a priority

A probe returning `Some(level)` claims the Pane's current workload; `None`
says "not mine"; an error says "I cannot establish ownership". The coordinator
resolves claims with two rules:

1. **A specialized claim is authoritative before a generic Shell claim.** A
   specialized provider that owns the workload but cannot determine its
   business state reports `Some(Unknown)` — that is still ownership, so generic
   foreground-process evidence cannot turn the Pane `working` in its place. An
   unresolved specialized probe blocks the generic claim for the same reason.
2. **Two claims of the same class are an ambiguity, not a race.** The Pane is
   `unknown`; registration order, provider order and "last writer" are not
   tie-breakers.

A changed foreground workload retires the previous owner and its observations
*before* new claims are read. The same-named tmux Session recreated with a new
`@nession_instance_id` starts with no Activity at all.

## Fencing and ordering

The authority key is (`agent_id`, durable `session_instance_id`, tmux
`pane_id`, owner generation). Every event report carries the generation of the
context it was observed under and is refused once ownership or the workload
has changed. Per `(Pane, capability)` the provider's own `source_generation`
orders levels: higher wins, equal is a duplicate, lower is out of order. A
report is a level, not a durable event stream.

The coordinator keeps at most one level per `(incarnation, Pane, capability)`,
so state is bounded by the observed tmux inventory and the composed providers.
Probes run sequentially outside the state lock; enqueue/report paths never
wait on a probe.

## Aggregation

For one Session incarnation, over every actually observed Pane:

- any Pane `working` ⇒ Session `working`;
- else any Pane `unknown` (including one with no owner) ⇒ Session `unknown`;
- else every observed Pane `idle` ⇒ Session `idle`;
- no observable Pane ⇒ `unknown`, projected as *unknown*, never `idle`.

`attention: input_required` is aggregated independently and only surfaced
while the Session is working. It is not a fourth state and is not inferred
from silence.

## Runtime refresh

`SessionWatcher` asks the coordinator to reconcile only after a **successful**
tmux enumeration, from `list_sessions` plus `list_panes`:

- a failed enumeration is not an empty inventory and keeps the previous
  Activity snapshot;
- Sessions without a durable instance id are skipped rather than fenced with
  an invented identity;
- a Session absent from the verified inventory is retired, so its Activity
  disappears with the Pane.

The Pane row carries `#{pane_current_command}` as foreground evidence
(`nession-tmux::PaneSummary::pane_current_command`). That field is a fact, not
an activity classifier.

## Shell provider (#3802)

`session::activity::shell::ShellActivityProvider` is the Agent's one generic
Shell claimant. It answers from the **Pane root's process groups**
(`session::process_discovery::process_groups`, one bounded `/proc` stat read on
Linux or one `PROC_PIDTBSDINFO` call on macOS):

| Evidence | Level |
|---|---|
| root's own group == terminal foreground group, command is a known shell | `idle` |
| the two groups differ, command is a known shell | `working` |
| command is not a shell | `working` (the foreground process *is* the work) |
| command is a specialized CLI (`claude`, `codex`, `qwen`) | `None` — yield |
| groups unavailable, no Pane root, or no command | `None` → `unknown` |

This makes a silent `sleep`, a pipeline, an interactive TUI, a `bash -c` child
named `bash`, `fg` and SIGINT behave correctly without a single timing
heuristic: the foreground group, not output volume, decides. A backgrounded
`&` job leaves the shell's group in the foreground, so it is `idle`, as the
issue requires. A builtin runs in the shell's own group and is not fabricated
into a foreground job. A non-shell foreground command remains `working` even
when the group read fails, because the command itself is foreground evidence.

The yield list prevents a Shell `working` claim for an agent CLI on an Agent
that does not compose that capability's adapter; with no specialized provider
the Pane is `unknown`, which is truthful. It is **not** a second Claude status
engine — the Claude provider (#3801) must still verify its own workload.

Linux and macOS share the contract. A host where the read is unavailable
reports `unknown`; macOS runtime accuracy is not claimed from Linux tests.
The provider is composed by `runtime::compose_activity_providers` beside the
Extension providers, so the composition is one explicit list.

## Explicit non-goals (P0/#3802)

- No wire type, Server projection or Web/App indicator (#3804).
- No real Claude/Codex status reader (#3801, reusing #3779).
- No shell prompt hook or OSC 133 integration; the process-group fallback is
  the current detector.
- No background-job, CPU, output-volume or attachment-based inference.
- No durable activity history and no new persistent store.
