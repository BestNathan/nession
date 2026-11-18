# Claude Agent View Observation (`#3779`)

## Source of truth

Claude's live activity is observed **on demand** from the official
`claude agents --json` command, run in the affected Nession Session's own cwd
and environment. It is never derived from a lifecycle-hook-maintained busy/idle
store, never from `~/.claude/jobs/state.json`, and never from transcript
recency. A transcript records what happened; Agent view reports what the CLI
observes now.

`crates/nession-claude-code/src/agent_view.rs` owns this contract:

* it parses the command's JSON into typed interactive activity
  (`busy|waiting|idle`, with `waitingFor`) and background state
  (`working|blocked|done|failed|stopped`), preserving unknown strings verbatim;
* a missing `sessionId` is `None` — never inferred from cwd, process name or the
  newest transcript;
* process identity is **not** decided here. Whether a reported `pid` belongs to
  the specific Nession Session is the Agent's existing process-discovery query,
  which the host performs before presenting a state as verified.

## Five distinct answers

| Result | Meaning |
|---|---|
| `Supported { sessions }` | The exact CLI version is verified and the records parsed. |
| `Unsupported { reason }` | The CLI exists but rejects `agents --json`. |
| `CannotObserve { reason }` | The CLI runs but this build cannot truthfully read the answer (unverified version, failed/timed-out run, malformed output). |
| `Absent` | No `claude` executable was found. |

None of the non-`Supported` answers is ever presented as `idle`, and
`CannotObserve` is not `Absent`: "I could not ask" and "there is no Claude" are
different claims.

## Version matrix

The matrix is exact, not a wildcard:

| CLI version | Evidence | Status |
|---|---|---|
| `2.1.326` | Captured `agents --json` output on 2026-11-18 (interactive `waiting`/`busy`/`idle`, background `blocked`), pinned by the module fixtures | Verified |

Any other version is `Unverified` and yields `CannotObserve` until a capture
and its fixtures are added. Older or vendor-fork CLIs therefore cannot be
silently interpreted with the verified shape.

## Control: enter and submit

`nession_claude_enter` selects a conversation explicitly:

* `mode: new` chooses a fresh UUID **before** launch (shell path:
  `claude --session-id <uuid>`) or uses in-process `/clear` only when Claude is
  verifiably idle. A preexisting Claude is never overwritten.
* `mode: resume` requires an explicit `conversation_id` (shell:
  `claude --resume <id>`, in-process: `/resume <id>`); it never means "the
  newest".
* Busy, waiting or unknown activity is refused. Enter and submit share one
  write lock per Agent, so two calls cannot be concurrent writers to one
  transcript.
* The result is `entered` only after the resulting conversation id is verified;
  otherwise `pending` with a read-back instruction. Nothing is reported as
  entered on a guess.

`nession_claude_submit` requires the verified idle conversation and the
caller's expected `conversation_id` (a stale mismatch refuses). It sends one
literal prompt line and answers `input_sent` with the verified actual id. That
is a **delivery** phase, not an execution result: there is no operation id, no
result object and no `get_result`. An unconfirmed send is `unknown` and must be
read back through the conversation readers before retrying.

## Not this module

* No new Hook state, no hook-maintained activity store and no expanded plugin
  surface. The existing SessionStart/SessionEnd binding hook remains the
  compatibility identity path until a verified replacement is proven.
* No transcript parsing, cursor or path semantics. Those belong to the existing
  conversation/transcript readers.
* No Nession Session-ownership decision. The Agent's process discovery remains
  the authority for "is this PID in this Session".
