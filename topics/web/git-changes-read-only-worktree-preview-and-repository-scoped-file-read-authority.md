---
title: "Git Changes read-only worktree preview and repository-scoped file read authority"
description: "A Git Changes row without a diff opens its actual worktree content through a Session/repository-bound git.preview read; text and media share one authorized boundary and one shared file-content presentation owner, never git.diff, the broad Files reader or a guessed empty diff"
topic: web
categories: ["git", "files", "media", "presentation", "protocol", "safety", "read-only", "ownership", "web"]
status: verified
created_at: 2026-11-06T09:03:13Z
updated_at: 2026-11-11T18:25:00Z
sources: ["https://github.com/BestNathan/nession/issues/2838", "https://github.com/BestNathan/nession/pull/2846", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/crates/nession-git/src/protocol/preview/v1.rs", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/crates/nession-git/src/runtime/preview.rs", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/crates/nession-git/src/runtime/status.rs", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/web/src/capabilities/git/hooks/useGitSelection.ts", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/web/src/capabilities/git/components/GitFilePreviewView.tsx", "https://github.com/BestNathan/nession/blob/eb29231c5ab94205b2e8a0c8cefc30287be65c60/e2e/tests/browser/fixture-git.spec.ts", "https://github.com/BestNathan/nession/issues/2876", "https://github.com/BestNathan/nession/pull/2909", "https://github.com/BestNathan/nession/blob/abeebc119fde48de10befb24a596fa8d8a97fed2/crates/nession-git/src/protocol/preview/v1.rs", "https://github.com/BestNathan/nession/blob/abeebc119fde48de10befb24a596fa8d8a97fed2/crates/nession-git/src/runtime/preview.rs", "https://github.com/BestNathan/nession/blob/abeebc119fde48de10befb24a596fa8d8a97fed2/web/src/capabilities/git/hooks/useGitSelection.ts", "https://github.com/BestNathan/nession/blob/abeebc119fde48de10befb24a596fa8d8a97fed2/web/src/capabilities/git/components/GitFilePreviewView.tsx", "https://github.com/BestNathan/nession/blob/abeebc119fde48de10befb24a596fa8d8a97fed2/web/src/shared/file-viewer/FileContentViewer.tsx", "https://github.com/BestNathan/nession/blob/abeebc119fde48de10befb24a596fa8d8a97fed2/web/src/shared/file-viewer/presentation.ts"]
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

## One presentation owner, plus authorized media (#2876)

Text and media no longer have separate renderers in Git Changes. An untracked
or unmerged row opens the shared `shared/file-viewer/FileContentViewer`:
read-only CodeMirror with line numbers and language highlighting for text, the
same Markdown/JSON/JSONL Preview/Raw leaves as Files, and the same
image/video/audio/PDF leaves for authorized media. `resolveFilePresentation`
is the one format policy. Git keeps the path/status header and the bounded-read
messages; Files keeps its edit/save lifecycle. The shared viewer performs no
capability, provider or transport I/O.

`platform/editor` remains the CodeMirror primitive. The Web layer rule forbids
`shared -> platform`, so each consumer supplies that editor component to the
shared viewer; the shared owner still decides when source is shown.

For a recognized media path, `git.preview` accepts `want: media`. That answer
adds a `media` payload (`content_base64`, sniffed `mime_type`, `complete`) and a
`too_large` state. It is complete bounded bytes (8 MiB) or a typed refusal; a
truncated prefix is never returned as media. The extension is only a request
hint: the Agent sniffs the bytes and refuses a family mismatch (for example a
`.png` containing PDF bytes) or a non-media path. Text and media run through the
same authorized read and identity checks below.

The Web consumer owns the Blob URL. A new selection, Session change, late
answer or unmount revokes it; a stale media answer is dropped rather than
displayed.

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

The one-megabyte text cap is a preview bound, not a file-size promise. Media
has a separate complete-byte bound (8 MiB); exceeding it is `too_large`, never
a truncated payload that a viewer could mistake for a playable file. A truncated
text answer reports the exact omitted byte count, drops only an incomplete
UTF-8 suffix at the cap and never presents a prefix as complete. NUL bytes or
invalid UTF-8 classify the file as binary with no text; the byte size remains
available. The response does not confuse an empty file, a binary file, a
missing path and an unavailable read.

## Client selection and stale answers

The Web list renders every status row as an opener, then hands the authorized
content to the shared presentation owner described above. `useGitSelection`
selects the operation from the row kind, asks for media only when the path is a
media hint, and guards each response by Agent, Session, request generation,
path and mode. A newer selection or Session change drops a
late answer. A Terminal focus handoff carries only a path; it waits until the
status rows can say which kind that path is, then asks the matching operation.
An unknown path stays unselected rather than guessing a diff.

The preview stays inside the existing Git Workspace/Peek navigation. It adds
no Files browser, editor, stage, merge or write control.

## Evidence

- Requirement: [#2838](https://github.com/BestNathan/nession/issues/2838);
  implementation PR [#2846](https://github.com/BestNathan/nession/pull/2846).
- Shared presentation and bounded media:
  [#2876](https://github.com/BestNathan/nession/issues/2876), implementation PR
  [#2909](https://github.com/BestNathan/nession/pull/2909). Its browser Cases
  cover CodeMirror text, structured Preview/Raw, real image/video/audio/PDF
  bytes and the desktop/phone geometry; its runtime Case runs the real
  `nession-git` media/authorization tests and the Web stale-answer/Blob tests.
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
Agent-owned input and is called out in its evidence. Text binary classification
is the NUL/invalid-UTF-8 heuristic over the bounded bytes, not MIME detection;
media classification sniffs a fixed family set and refuses unknown bytes.
Hard links inside the repository and files visible through the Session's own
mount namespace are not separated further. Media is a complete bounded read,
not a streaming/range transport, so a clip or document over the 8 MiB bound is
`too_large`; PDF rendering is the browser's embedded viewer. Revisit if Git
preview starts serving paths outside a Session's worktree, if a second writer
can mutate the worktree without triggering status invalidation, if large media
needs seek/range streaming, or if a real sandbox policy needs to replace the
Session/mount visibility assumption.

### Related knowledge

- [Git capability local repository and read-only GitHub hosting context ownership](git-capability-local-repository-and-read-only-github-hosting-context-ownership.md) — the hosting provider layered over the same Session repository; its GitHub reads never become local Git authority.
- [Files capability identity, creation context and safe mutation ownership](files-capability-identity-creation-context-and-safe-mutation-ownership.md) — the source-scoped Files boundary; its browse root is deliberately not reused as Git preview authority.
- [Nession Sandbox policy and execution isolation architecture](../engineering/nession-sandbox-policy-and-execution-isolation-architecture.md) — Sandbox policy ownership and why the Agent file root is not an isolation guarantee.
