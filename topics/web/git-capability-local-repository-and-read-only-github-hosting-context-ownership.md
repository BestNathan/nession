---
title: "Git capability local repository and read-only GitHub hosting context ownership"
description: "One Git capability with two providers: nession-git stays the sole GitCmd and local-repository owner, nession-github owns typed read-only GitHub identity/client/auth/failures, and the Workspace groups Repository and GitHub without a second capability or Git Peek"
topic: web
categories: ["git", "github", "architecture", "ownership", "protocol", "security", "read-only", "web"]
status: verified
created_at: 2026-11-11T18:25:00Z
updated_at: 2026-11-11T18:25:00Z
sources: ["https://github.com/BestNathan/nession/issues/1290", "https://github.com/BestNathan/nession/pull/3317", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/docs/architecture/git-capability.md", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/crates/nession-github/src/runtime/client.rs", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/crates/nession-github/src/runtime/remote.rs", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/crates/nession-github/src/agent.rs", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/crates/nession-git/src/runtime/context.rs", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/web/src/capabilities/git/components/GitWorkspace.tsx", "https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/web/src/capabilities/git/components/GithubHostingView.tsx"]
---

# Git capability local repository and read-only GitHub hosting context ownership

## Decision

Git is **one product capability** with two providers. Local repository state and
GitHub hosting state are distinct authorities, but they share the Workspace
surface, the Session identity and the authorized working directory.

```text
Git capability
  ├─ Local Repository
  │    GitPlugin → git.* → nession-git → GitCmd → git
  └─ GitHub hosting context
       githubApi → github.* → nession-github → typed read-only GitHub API
```

- **`nession-git` stays GitHub-agnostic.** `GitCmd` remains the only place a
  Git process is spawned. It also exposes the active work-tree root, branch,
  upstream and configured remotes through that same chokepoint, so hosting
  resolution adds no second subprocess path.
- **`nession-github` owns hosting identity and the read client.** It parses
  HTTPS/SSH/scp remote forms (stripping URL credentials), selects the branch
  upstream → `origin` → sole GitHub remote, and talks to a fixed GitHub GET
  surface. It does not spawn git, touch tmux, or own Web/product presentation.
- **The Agent owns Session authorization and live cwd.** Both providers receive
  the same `WorkdirResolver`; a client names a Session and, optionally, an
  Agent-discovered `remote_name`. Owner, repository, host and path are never
  client-selected.
- **The Server only relays.** It holds no GitHub credential and does not
  interpret GitHub APIs.
- **Web presents both providers under `web/src/capabilities/git/`.** `github`
  is a transport plugin, not a Product Capability: no GitHub Capsule item and no
  global GitHub application.

## Read-only GitHub v1

Six independently versioned units answer the hosting questions:

| Unit | Authority |
|---|---|
| `github.repository` | resolved identity, discovered remote choices, branch, auth availability |
| `github.issues` | bounded Issue summaries, open/closed/all, opaque continuation |
| `github.issue-detail` | one selected Issue's full Markdown body and source URL |
| `github.pull-requests` | bounded PR summaries and exact current-branch relation |
| `github.pull-request-detail` | one selected PR's body, head/base and source URL |
| `github.workflows` | bounded workflows and latest run, repository or current-branch scope |

The IDs use hyphens because the Protocol Kernel's `ProtocolId` grammar rejects
underscores; the Rust modules retain the Issue's historical names.

Details are lazy: a list never fetches full bodies for its rows. PR association
requires the selected repository owner/repo, the head repository owner/repo and
`head.ref` to equal the current branch — a similar branch name is not a match.
Actions distinguish repository-wide from current-branch runs; another branch's
success is never presented as the current branch's success. v1 does not read
Issue comments, PR files/reviews or workflow jobs/logs.

## Authentication, failures and bounds

The Agent reads `GITHUB_TOKEN` (falling back to `GH_TOKEN`). Missing credentials
are an honest `authenticated: false` / `not_authenticated` state, not a startup
failure and never an anonymous private-repository fallback. SSH access does not
imply REST authority. v1 authorizes only `github.com`; other hosts remain in the
identity but return `host_not_allowed`.

The typed client has a fixed GET operation set, a 10 s request ceiling, 512 KiB
response cap, page sizes 1–50 with explicit `next_cursor`, redirect refusal and
bounded request scope. It reports `not_a_repository`, `no_github_remote`,
`ambiguous_remote`, `host_not_allowed`, `client_unavailable`,
`not_authenticated`, `access_denied`, `not_found`, `rate_limited`,
`network_unavailable`, `timeout`, `api_error` and `malformed_response` as
distinct outcomes. Error messages do not carry tokens or response bodies.

A 15 s, 128-entry in-memory cache dedups identical reads and in-flight requests.
Its key includes Session, resolved remote/repository/branch, auth fingerprint,
operation and parameters; it is never persisted or shared across identities,
and an explicit Refresh bypasses the cache read. Every authoritative request
re-resolves the live Session repository, so a cwd/remote/branch change cannot
reuse the old identity.

## Presentation

The Git Workspace groups **Repository** (Changes/History/Branches/Worktrees) and
**GitHub** (Issues/Pull Requests/Actions); it does not flatten them into seven
peer tabs. The legacy Terminal Git Peek is not registered; selecting the Git
Workspace entry opens the Workspace directly, while the shared Peek machinery
remains for other capabilities.

On wide surfaces the summary list and the Markdown reader scroll independently;
Focus reading collapses the list while preserving selection. On narrow/App
surfaces the list is level one and the detail is a full-width pushed view whose
Back restores filter, search and selection. Markdown goes through the shared
sanitizer; the only outbound control is a validated GitHub source link. No
create/edit/comment/review/merge/dispatch control exists.

## Evidence and limits

Implementation is [#1290](https://github.com/BestNathan/nession/issues/1290),
PR [#3317](https://github.com/BestNathan/nession/pull/3317), merged to staging
at `37b6af7ebf81c805c9274e007b9de1b11fdc8851`. The canonical architecture is
[`docs/architecture/git-capability.md`](https://github.com/BestNathan/nession/blob/37b6af7ebf81c805c9274e007b9de1b11fdc8851/docs/architecture/git-capability.md).
Fifteen pre-merge Cases at PR head `42c1a3868` (run 43074536797) cover
parser/policy, typed client parsing and limits, the Web grouping/lazy
reader/state guards and the absence of mutation controls; the browser Case at
merged staging `37b6af7e` (run 43076290435) covers desktop split/Focus and
mobile push/Back, together with the SC-11/SC-13/SC-22/SC-25 security and
isolation criteria. E2E run 43074536856 passed the new
`git-github-context` spec and the `fixture-git`, `fixture-visual` and
`fixture-visual-app` regressions.

The client was proven against a local HTTP fixture server, not a live GitHub
account. Enterprise identity/auth, proxy support, comments, PR files/reviews and
workflow jobs/logs are future work.

## Related knowledge

- [Git Changes read-only worktree preview and repository-scoped file read authority](git-changes-read-only-worktree-preview-and-repository-scoped-file-read-authority.md)
  owns the local Git Changes read boundary this capability keeps underneath the
  hosting context.
- [Unified overlay and operation surface system](unified-overlay-and-operation-surface-system.md)
  owns the overlay roles and Workspace surface idioms the GitHub depth does not
  replace.
