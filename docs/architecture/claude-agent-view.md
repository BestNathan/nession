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

## Four distinct answers

| Result | Meaning |
|---|---|
| `Supported { sessions }` | The CLI answered `agents --json` with records this build can read. The reported version is recorded for diagnostics, not used as an admission gate. |
| `Unsupported { reason }` | The CLI exists but rejects `agents --json` (for example, an older CLI without the command). |
| `CannotObserve { reason }` | The CLI runs but this build cannot truthfully read the answer (failed/timed-out run, malformed output). |
| `Absent` | No `claude` executable was found. |

None of the non-`Supported` answers is ever presented as `idle`, and
`CannotObserve` is not `Absent`: "I could not ask" and "there is no Claude" are
different claims.

## CLI compatibility is observed, not pre-gated

The probe **attempts** `claude agents --json` on every installed CLI and lets
the answer decide:

* any version that prints the shaped records is interpreted normally — a newer
  or older version is not refused merely because it is absent from a list;
* an older CLI that does not offer the command is `Unsupported`, carrying the
  CLI's own refusal;
* a failed, timed-out or unparseable answer is `CannotObserve`.

The captured `2.1.326` output remains the fixture that documents the shape
(interactive `waiting`/`busy`/`idle`, background `blocked`); it is evidence, not
a runtime allowlist. Additive CLI changes are tolerated because unknown fields
are ignored; an incompatible shape fails closed as `CannotObserve` rather than
being guessed. The e2e runtime can install and select the CLI version under
test (`agentCliVersions` / `NESSION_AGENT_CLI_VERSIONS`), and records the
requested/resolved version in `runtime.json`.

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

## Reading conversations and transcripts

Three read Tools expose the **existing** Protocol Units; they add no second
discovery, selection, pagination or raw-record parser:

| Tool | Unit |
|---|---|
| `nession_claude_list_conversations` | `claude-code.conversations` |
| `nession_claude_get_conversation` | `claude-code.messages` |
| `nession_claude_get_transcript` | `claude-code.transcript-records` / `claude-code.transcript-record` |

`crates/nession-claude-code/src/conversation_reader.rs` is the seam: it sends a
typed request to the same `ClaudeCodeAgentExtension::handle_command` the
Agent's Protocol routing uses and deserializes the Unit's typed reply. Each Tool
advertises the Unit's own response type as its `outputSchema`, so the MCP
surface cannot drift from the conversation UI's contract.

* **Explicit identity only.** The list is the answer; nothing is auto-opened.
  `get_conversation` reads exactly its `conversation_id` and answers
  `not_found` for an unknown one rather than substituting the binding or the
  newest transcript.
* **Canonical paging.** `next_cursor` and `limit` are the Unit's opaque/bounded
  values, passed through unchanged. Without a cursor the newest page is
  returned — the bounded latest observation. Continued progress observation is
  the same read again; there is no Tool-owned forward cursor and no result
  object.
* **Raw records as recorded.** A transcript page carries one record per
  physical JSONL line, including unknown and non-JSON types, with
  `partial_tail` for an unfinished line. A record too large for a page is a
  `record_ref` placeholder, resolvable through the same Tool for a bounded
  chunk; it is never truncated or dropped.
* **No path exposure.** Transcript and record identity are opaque Unit strings;
  the output contracts contain no transcript path. `cwd` is the Unit's own
  Session-scoped display fact, not a transcript location.
* **Same Agent truth.** The Agent composes the reader over the same tmux
  Session manager the MCP endpoint serves. Every Tool refuses a foreign
  `agent_id` or a `session_id` that is not `agent_id:session_name` before any
  read.

## Not this module

* No new Hook state, no hook-maintained activity store and no expanded plugin
  surface. The existing SessionStart/SessionEnd binding hook remains the
  compatibility identity path until a verified replacement is proven.
* No transcript parsing, cursor or path semantics. Those belong to the existing
  conversation/transcript readers.
* No Nession Session-ownership decision. The Agent's process discovery remains
  the authority for "is this PID in this Session".
