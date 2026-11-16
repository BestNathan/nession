# Claude Transcript Raw Records (`#3726`)

Status: current architecture for the Claude Code Workspace's **Transcripts**
surface. Supersedes `#1234`'s semantic-projection ownership for that surface;
the historical projection remains as a compatibility path.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `crates/nession-claude-code` | Discover the Session's authorized primary/subagent transcripts; read physical JSONL lines in source order; resource-scoped byte-offset cursors; bounded pages; partial-tail safety; bounded full-record lookup. It does **not** classify `user`/`assistant`/`system`, parse nested message content, infer reasoning or pair tool calls with results. |
| `web/src/capabilities/claude-code` | Decode raw lines with one Claude-specific adapter (`model/transcriptRecord.ts`); render every record as one timeline row; provide per-row native detail and an independent Raw inspector. |
| `claude-code.messages` | The Conversation surface. Unchanged; it still reads the Rust canonical projection. |
| `claude-code.transcript-items` | Legacy semantic Transcript projection (`#1234`). Advertised and answered for clients built before the `#3726` migration; the current Web Transcript view does not call it. |

## Record transport

Two Protocol Units carry the new surface:

- `claude-code.transcript-records` — one page of raw records for an explicitly
  named transcript. Each `records[]` entry corresponds to exactly one physical
  JSONL line: `record_ref`, byte `offset`, `size_bytes`, and the original `raw`
  text when the page can carry it. Unknown types, malformed lines and blank
  understanding do not remove a line.
- `claude-code.transcript-record` — one record's complete text in bounded
  chunks. Used for a line too large for a page, which appears in the page as a
  placeholder with no `raw` rather than a truncated line.

Both references are opaque and resource-scoped. They encode the transcript
identity, byte offset and a generation fingerprint of the file's first line. A
cursor from another transcript, or from before the file was replaced, is
refused (`stale_cursor` / `stale_generation`) without returning bytes. No
filesystem path travels on the wire.

Bounds: one record may travel inline up to `RECORD_INLINE_CEILING` (64 KiB); a
page carries at most `PAGE_INLINE_BUDGET` (256 KiB) inline across records; a
record lookup chunk is at most `CHUNK_CEILING` (256 KiB). A transcript ending
mid-record reports `partial_tail` and withholds the unfinished line.

## Frontend rendering

One source line is one visible row. A row's native detail — text, thinking,
`tool_use`, `tool_result`, attachment fields, system/metadata facts — is
disclosure inside that row; it never merges or consumes another line. Unknown
records render a generic row titled with their own upstream `type`/`subtype`,
and malformed lines render a generic row with their original text preview. No
row carries a parser-status badge.

Every row independently offers **Raw**, which opens the complete JSON tree for
valid JSON and the complete original text for every record, with copy. On Web
the Raw inspector is a bounded overlay pane, so it does not permanently shrink
the timeline; on App it lives inside the pushed record depth, which owns the one
Back.

## Compatibility and migration

The Web Transcript view was migrated in the same change that added the raw
units. `claude-code.transcript-items` remains advertised so an already-loaded
Web client keeps a working binding; it is not a second owner of the new path and
must not grow new behavior. Removing it is a later deliberate migration after a
consumer audit confirms no deployed or non-Web caller depends on it.

## Verification

- `crates/nession-claude-code/src/records.rs` — page order/completeness,
  oversize placeholders, chunked reassembly, generation/cursor safety,
  partial-tail withholding.
- `crates/nession-claude-code/src/agent.rs` — wire-level raw handler tests,
  foreign-reference refusal, no content/path on errors.
- `web/src/capabilities/claude-code/model/transcriptRecord.ts` — decoder
  tests: unknown/malformed types, multi-block rows, unpaired tool result.
- `web/.../hooks/useTranscriptRecords.ts` — paging, polling preservation,
  stale cursor handling.
- `e2e/tests/browser/transcript-geometry.spec.ts` — record-row completeness and
  bounded Raw wrapping.
