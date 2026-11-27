---
title: "Claude conversation identity resolution"
description: "Reported identity outranks inferred cwd: how a Nession Session discovers its Claude conversations and current binding across resume and cwd drift (#4664)"
topic: engineering
categories: ["agent","architecture","protocol","session","identity","ownership"]
status: verified
created_at: 2026-11-27T15:20:00Z
updated_at: 2026-11-27T15:20:00Z
sources: ["https://github.com/BestNathan/nession/issues/4664","https://github.com/BestNathan/nession/blob/235f63293b799dfc0d3f35a1938241780a090dc1/crates/nession-claude-code/src/resolution.rs","https://github.com/BestNathan/nession/blob/235f63293b799dfc0d3f35a1938241780a090dc1/crates/nession-claude-code/src/conversation.rs"]
---

# Claude conversation identity resolution

## Decision

A Nession Session's Claude conversations are resolved by **reported identity,
not directory coincidence** (#4664, design D1–D7). One owner —
`nession_claude_code::resolution` — serves every read unit (`conversations`,
`messages`, `transcripts`, `transcript-items`, `transcript-records`,
`transcript-record`):

- **Identity is the join key.** `claude_session_id` joins the hook-reported
  binding, the lifecycle history, the host's verified agent-view observation,
  and the transcript on disk. Strict cwd matching (#1005 decision 7) still
  governs *unreported candidates*: no parent, git-root or subdirectory
  matching, no cross-directory leakage.
- **Reported evidence outranks inferred cwd for the session's own
  conversation.** The list is the union of strict-cwd candidates and the
  conversations the session instance has reports for, deduped by identity,
  newest-first. An item's `cwd` is the transcript's own recorded cwd and may
  differ from the pane's — display metadata, never a scope key.
- **Binding validity is identity + lifecycle, not cwd membership.** The
  current conversation is the freshest reported evidence: the live verified
  observation (the running CLI's own `claude agents --json` self-report,
  surfaced from the Session Activity adapter's existing TTL cache — no new CLI
  probe in the read path), then the latest hook lifecycle report, then the
  history's last report. A report that resolves to no readable transcript is
  not a binding; nothing is invented for it.
- **Transcript resolution reconciles the claimed path.** A resumed
  conversation keeps its historical file while its recorded cwd drifts, and
  the hook's `transcript_path` can name a file that does not exist. Resolution
  uses the claimed path when it is inside the projects tree and its head
  records the reported `sessionId`; otherwise it locates `<id>.jsonl` across
  project directories and verifies the head identity. Reads stay inside the
  projects tree discovery already scans.
- **The lifecycle log is append-only and instance-fenced.** The hook keeps
  truncating the current-binding file exactly as before and additionally
  appends every event payload to a per-instance history file via `tee` (still
  parse-free). Sessions created before the log keep the truncate-only behavior
  byte-for-byte. The #2974 instance fence applies to both files: a recreated
  same-name Session inherits neither.
- **The two surfaces cannot diverge.** Whenever the control path verifies a
  conversation for a Session, the conversation list includes it and reports it
  as the binding (SC-10). The control path keeps process/activity/enter/submit
  authority unchanged.

## Context and evidence

Measured 2026-11-27 on `agent-fba281f7…:bbc-devparams`: `nession_claude_status`
reported `running/idle/verified` with conversation `d5bbf26b…`, while
`nession_claude_list_conversations` returned `ready` with an empty list and no
binding. The transcript (27 MB, live) recorded three cwds over its life
(worktree root ×1753, worktree `bbc/` ×1526, main-repo `bbc` ×568); its
head-window first cwd was the main repo while the tmux pane stayed at the
worktree. The resume hook's binding claimed a transcript path under the drifted
cwd's project directory — a file that did not exist.

The pre-#4664 architecture had three brittle joints: the read units gated on
strict head-cwd equality; `bound_conversation` intersected the reported binding
with that cwd-scoped list and matched by transcript-path equality; the control
path was independent of both. A persistent Bash-tool `cd` or a resume that
restores a drifted cwd (and rewrites the transcript head) broke the assumed
pane-cwd == claude-cwd identity, hiding a verified running conversation from
the capability view.

The regression fixtures mirror the measured resume payload shape (head cwd ≠
pane cwd; claimed path absent; `source: resume`). Proof is deterministic at PR
head: crate unit tests plus the protocol Gates (SCN-01, `verification:scoped`).

## Related knowledge

- [Session Activity ownership](session-activity-ownership.md) — the Claude
  Activity adapter whose verified-observation cache the resolution owner reads.
- [Claude Code MCP configuration and Nession onboarding](claude-code-mcp-configuration-and-nession-onboarding.md)
  — the same capability's MCP configuration surface.
- [Session metadata and display identity ownership](session-metadata-and-display-identity-ownership.md)
  — the tmux-instance fence pattern the binding and history files share.

## Limits / when to revisit

- A transcript that merely passed through the cwd, or drifted without ever
  being reported by this session instance, is still not listed — strict
  candidate scope is deliberate.
- History is per tmux Session instance; a recreated session starts empty even
  if the user resumes the same conversation (the resume hook re-reports it).
- The verified-identity answer is bounded by the Activity adapter's cache TTL;
  between polls the lifecycle binding carries currency.
- Hook propagation relies on the measured in-place reload of the
  directory-marketplace plugin at session start; a Claude Code change to
  plugin caching would revisit this.
- Revisit if Claude Code changes the transcript head layout, the hook payload
  contract, or the `agents --json` self-report shape.
