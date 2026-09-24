# Claude Code conversation capability (#1005) — implementation plan

> **Status:** stage A in progress. Read the measured format section before writing
> any parser; it is the difference between normalizing real records and guessing.

**Goal:** a Nession Session running Claude Code can show that Session's conversation,
read-only, without ever showing a transcript that is not provably the right one.

**Upstream constraints:** `VISION.md` (preserve the user's working context),
`PRINCIPLE.md` (start from the work; progressive disclosure). #1005's own Product
alignment section already checks both.

---

## Measured transcript format (2026-09-25, tmux 3.6b host, Claude Code current)

Measured from a real transcript, not from documentation. Record shapes by
`type`, over one transcript:

**Conversation records** — these are messages:

| type | n | role | `message.content` |
|---|---|---|---|
| `assistant` | 2793 | `assistant` | list of blocks |
| `user` | 1169 | `user` | list of blocks, **or a plain string** |

Block types inside `message.content`:

| block | n | keys |
|---|---|---|
| `tool_use` | 1099 | `id`, `input`, `name`, `type` |
| `tool_result` | 1098 | `content`, `is_error`, `tool_use_id`, `type` |
| `thinking` | 1075 | `signature`, `thinking`, `type` |
| `text` | 619 (assistant) / 9 (user) | `text`, `type` |

**Bookkeeping records — NOT messages.** These must not become chat items
(criterion 4). Observed types: `attachment` (1916), `atis-latch`, `worktree-state`,
`last-prompt`, `mode`, `permission-mode`, `relocated`, `pr-link`, `ai-title`,
`file-history-delta`, `file-history-snapshot`, `queue-operation`, `system`.

**Two consequences that shape the design:**

1. **Tool traffic dominates.** 1099 tool_use + 1098 tool_result against 619
   assistant text blocks. A view that renders one row per record is a tool log,
   not a conversation. Tool items must be collapsed by default and paired
   (`tool_use.id` ↔ `tool_result.tool_use_id`).
2. **The type list is open.** 13 non-message types exist today and upstream adds
   more. Unknown types degrade to "skipped", never to a parse failure
   (constraint 7, criterion 6).

Also present and load-bearing for identity: `sessionId`, `session_id`, `cwd`,
`gitBranch`, `uuid`, `parentUuid`, `timestamp`, `isSidechain`, `version`.

`isSidechain: true` marks subagent records — edge case "v1 不应错误地把 subagent
transcript 当主 conversation", so the main view filters them out.

## Stage plan

Each stage is independently shippable and independently testable.

- **A — contract + reader.** `claude-code.conversation` v1 (new Protocol Unit, not
  an expansion of `read` v1), plus the transcript reader that normalizes to it.
  Cursor/paged, append-safe, boundary-validated, unknown records degraded.
- **B — session context boundary.** Give the extension the Nession session's cwd
  and binding without `nession-claude-code -> nession-agent` (a forbidden reverse
  dependency). `SessionManager::get_session_cwd()` already exists on the agent side.
- **C — Claude plugin + hook binding.** Agent-owned local marketplace + a
  `nession-agent` integration plugin; `SessionStart`/`SessionEnd` hooks carry
  `session_id` / `transcript_path` / `cwd`; `NESSON_SESSION_ID` gates it so the
  plugin is a no-op outside Nession Sessions. Idempotent reconciliation via
  Claude's own plugin CLI — never hand-editing its registry JSON.
- **D — Web Workspace view.** Conversation List is the stable entry; auto-open only
  on an exact binding; no mtime fallback (constraint 1).

## Constraints that are easy to violate accidentally

- The reader must **not** `read_to_string()` the whole transcript (the existing
  `claude-code.read` does, with a 1 MB ceiling — criterion 5 needs more than that).
- Paths: canonicalize, then verify against the Claude data root. Web never submits
  a path (criterion 7).
- Transcript bodies must never reach a log or the server DB (criterion 11).
- A partial trailing line is normal, not corruption (criterion 6).
