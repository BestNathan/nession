---
title: "Git Changes read-only worktree preview and repository-scoped file read authority"
description: "A Git Changes row without a diff opens its actual worktree bytes through a separate Session/repository-bound git.preview read, never through git.diff, the broad Files reader or a guessed empty diff"
topic: web
categories: ["git", "files", "protocol", "safety", "read-only", "ownership", "web"]
status: verified
created_at: 2026-11-06T09:03:13Z
updated_at: 2026-11-06T09:03:13Z
sources: ["https://github.com/BestNathan/nession/issues/2838", "https://github.com/BestNathan/nession/pull/2846", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/crates/nession-git/src/protocol/preview/v1.rs", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/crates/nession-git/src/runtime/preview.rs", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/crates/nession-git/src/runtime/status.rs", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/web/src/capabilities/git/hooks/useGitSelection.ts", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/web/src/capabilities/git/components/GitFilePreviewView.tsx", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/e2e/tests/browser/fixture-git.spec.ts"]
---

# Git Changes read-only worktree preview and repository-scoped file read authority

## Decision

A changed worktree file is readable in Git Changes whether or not Git has a
diff for it. The selected **Git row kind chooses the operation**:

- a tracked staged/unstaged change opens the existing bounded `HEAD → worktree`
  diff when one is obtainable;
- an untracked regular file opens a read-only file preview labelled
  **Untracked · File preview (no Git baseline)**;
- an unmerged/conflicted file opens its current worktree bytes labelled
  **Unresolved conflict · File preview**, or an explicit missing/changed state.

The client never turns an empty diff into a preview. `git.diff` keeps its
meaning, and the broad Agent Files reader is not an authority for this path:
that reader's root is a browse root, not the Session's repository identity.

## One typed operation, not a widened diff

`git.preview` is a separate Git protocol unit with an `expected` row kind
(`untracked` or `unmerged`). Its answer is a typed file snapshot with one of
`ready`, `missing`, `denied`, `changed` or `unsupported`, plus binary, size,
truncation and exact omitted-byte fields. The kind is a hint for the request,
not an authority: the Agent re-reads status before and after the file read and
refuses a path that is no longer in the selected group.

A conflicted path is emitted **once**, in `unmerged`. `status.rs` no longer
copies it into `modified`, so the listing and the Signal projection cannot show
the same resource twice.

## Read authority and race boundary

The read is bound to the Session the Agent already resolved:

1. Resolve the Session working directory through the existing Session resolver,
   then the repository root through `git rev-parse --show-toplevel`.
2. Accept only a repository-relative path: no absolute path, no `..`, no NUL
   and no alternate repository target.
3. Canonicalize the root and record its directory identity. Open the root and
   every parent with `O_NOFOLLOW`; open the final entry with `O_NOFOLLOW` and
   `O_NONBLOCK`, then reject anything that is not a regular file. A symlink
   (including a parent swapped in during the read) is refused, never followed.
4. Read at most 1 MiB + 1 within five seconds, then compare the opened handle's
   size/mtime, the path's current dev/inode and the root's current dev/inode
   before returning bytes. The selected status group is checked again.
5. Any mismatch is `changed`; a missing path, denied open and non-regular entry
   stay distinct. No bytes are returned for a state that is not `ready`.

Opening directories by descriptor prevents a lexical `starts_with` check from
standing in for containment. No Git command in this path is mutating; `GitCmd`
remains the single subprocess owner.

## Bounded text and explicit states

The one-megabyte cap is a preview bound, not a file-size promise. A truncated
text answer reports the exact omitted byte count, drops only an incomplete
UTF-8 suffix at the cap and never presents a prefix as complete. NUL bytes or
invalid UTF-8 classify the file as binary with no text; the byte size remains
available. The response does not confuse an empty file, a binary file, a
missing path and an unavailable read.

## Client selection and stale answers

The Web list renders every status row as an opener. `useGitSelection` selects
the operation from the row kind, and guards each response by Agent, Session,
request generation, path and mode. A newer selection or Session change drops a
late answer. A Terminal focus handoff carries only a path; it waits until the
status rows can say which kind that path is, then asks the matching operation.
An unknown path stays unselected rather than guessing a diff.

The preview stays inside the existing Git Workspace/Peek navigation. It adds
no Files browser, editor, stage, merge or write control.

## Evidence

- Requirement: [#2838](https://github.com/BestNathan/nession/issues/2838);
  implementation PR [#2846](https://github.com/BestNathan/nession/pull/2846).
- Implementation commit: `eb29231c5ab94205b2e8a0c8cefc30287be65c60`.
- Source-aligned pre-merge Cases: SC-01 untracked content and phone
  recoverability, SC-02 one conflict row and actual bytes/missing state, SC-03
  retained tracked diff plus explicit fallbacks, SC-05 bounded provider reads
  and stale-response isolation, SC-06 focus/scroll/Capsule/read-only shell.
  SC-04 is an Agent review of the Session/repository binding and negative tests.
- `e2e/tests/browser/fixture-git.spec.ts` and the `preview-states` fixture cover
  text, conflict markers, binary, truncation, missing, changed and unsupported
  symlink rows at desktop and phone widths.

## Limits / when to revisit

The SC-05 runtime Case exercises the real provider/consumer boundary but not a
live tmux Session view; Session→workdir resolution remains the unchanged
Agent-owned input and is called out in its evidence. Binary classification is
the NUL/invalid-UTF-8 heuristic over the bounded bytes, not MIME detection.
Hard links inside the repository and files visible through the Session's own
mount namespace are not separated further. Revisit if Git preview starts
serving paths outside a Session's worktree, if a second writer can mutate the
worktree without triggering status invalidation, or if a real sandbox policy
needs to replace the Session/mount visibility assumption.

### Related knowledge

- [Files capability identity, creation context and safe mutation ownership](files-capability-identity-creation-context-and-safe-mutation-ownership.md) — the source-scoped Files boundary; its browse root is deliberately not reused as Git preview authority.
- [Nession Sandbox policy and execution isolation architecture](../engineering/nession-sandbox-policy-and-execution-isolation-architecture.md) — Sandbox policy ownership and why the Agent file root is not an isolation guarantee.
