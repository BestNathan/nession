# Git capability: local repository and read-only GitHub hosting context

Status: current for #1290 v1.

The Git capability is **one product capability** with two providers. It owns the
local repository and the hosting-provider context for that same repository; it
does not compete with Work, and GitHub is not a second top-level capability.

```text
Git capability
  ├─ Local Repository
  │    GitPlugin → git.* units → nession-git → GitCmd → git
  └─ GitHub hosting context
       githubApi → github.* units → nession-github → typed read-only client
                                  → Agent-owned GitHub credential
```

## Ownership

- **`nession-git`** stays GitHub-agnostic. `GitCmd` is the only place a `git`
  process is spawned; it also exposes the repository context the hosting
  resolver consumes (work-tree root, current branch, upstream, configured
  remotes). There is no second Git subprocess path.
- **`nession-github`** owns GitHub host identity, remote URL parsing, the typed
  read client, authentication availability, API normalization, budgets and
  failure codes. It does not spawn git, touch tmux, or import Web/Workspace
  concepts.
- **`nession-agent`** owns the Session's live working directory. It injects a
  `WorkdirResolver` into both providers; the client never names a path.
- **`nession-server`** only relays typed calls and enforces caller/Session
  routing. It holds no GitHub credential and does not interpret GitHub APIs.
- **Web** presents both providers under `web/src/capabilities/git/`. The
  transport plugin `github` is not a Product Capability: there is no GitHub
  Capsule item and no global GitHub surface.

## Repository identity

```text
Authorized Agent+Session → live cwd → GitCmd repository context
  → branch / upstream / remotes → selected GitHub remote
  → { host, owner, repo, remote_name, branch? }
```

Remote selection: the current branch's upstream remote if it is a valid GitHub
remote → `origin` if valid → the sole valid GitHub remote → otherwise a typed
`ambiguous_remote`/`no_github_remote` answer. A Web-selected remote is a
`remote_name` discovered by the Agent; the Agent re-resolves it on every
request. A missing/changed selection is ambiguous again rather than silently
falling back.

Supported remote forms are HTTPS and SSH, including scp-style
`git@host:owner/repo.git`. Credentials embedded in a URL are recognized and
stripped; no credential-bearing URL enters a DTO, cache key, display, log or
diagnostic. Only `github.com` is API-authorized in v1; any other host is a typed
`host_not_allowed` answer even though its host remains part of the identity.

## Read-only API

The client implements fixed GET operations only; Web cannot supply a host,
owner, repository, path, endpoint or query parameter.

| Unit | Answer |
|---|---|
| `github.repository` | selected identity, discovered remote choices, branch, authentication availability |
| `github.issues` | bounded Issue summaries with open/closed/all filter and opaque continuation |
| `github.issue-detail` | one selected Issue's full Markdown body, metadata and canonical source URL |
| `github.pull-requests` | bounded PR summaries and the exact current-branch relation |
| `github.pull-request-detail` | one selected PR's body, head/base identity and source URL |
| `github.workflows` | bounded workflows and their latest run, scoped repository-wide or to the current branch |

PR association is identity-checked: selected repository owner/repo, PR head
repository owner/repo, and `head.ref` must all match the current branch.
Branch-name similarity is not a match. Actions run scope is explicit; a
repository-wide success is never presented as a branch success.

Details are lazy: a list response never fetches full bodies for its rows.
Issue/PR lists filter GitHub's PR-shaped Issue records inside the provider.
Comments, changed files, reviews and workflow jobs/logs are native GitHub
depth candidates, not part of this v1.

## Authentication and packaging

The Agent constructs the client from its own environment. A token is read from
`GITHUB_TOKEN`, falling back to `GH_TOKEN`. An absent/empty token is **not a
startup failure**: `github.repository` reports `authenticated: false` and API
reads answer `not_authenticated`. No anonymous fallback is attempted for a
private repository, and SSH authority is never treated as REST authority.

v1 uses a typed Rust HTTP client (`reqwest`, rustls) rather than the `gh`
executable. Therefore the **`gh` binary is not a runtime requirement** and the
Agent Dockerfiles need no change for it. A supported Agent runtime needs:

- `git` for the existing local capability (already packaged);
- outbound HTTPS to `api.github.com`;
- a host-appropriate `GITHUB_TOKEN`/`GH_TOKEN` when GitHub reads are wanted.

CI having `gh` is not evidence about the Agent runtime. An Agent without a
token reports the honest unavailable state above. Enterprise API hosts, proxy
support and per-host credentials are explicit future work.

## Budgets, caching and freshness

- Each request has a 10 s ceiling, a 512 KiB response ceiling, bounded page
  sizes (1–50 rows; 20 by default) and an explicit `next_cursor`.
- Workflows fetch the visible workflow page plus one bounded runs page; latest
  runs are grouped by workflow id. There is no per-workflow N+1 query.
- No interval polling. A depth reads on entry, explicit Refresh, or filter/page
  change; hidden depths are unmounted.
- A short-lived (15 s), bounded (128-entry), auth-scoped in-memory cache dedups
  identical reads and in-flight requests. Its key includes Session, resolved
  remote/repository/branch, auth fingerprint, operation and parameters. It is
  never persisted and never shared across identities. Explicit Refresh bypasses
  the cache read.
- Every authoritative request re-resolves the live Session repository. A move
  to another cwd/repository/remote/branch changes the key; the Web additionally
  guards generation and request order so an older reply cannot overwrite the
  current identity.

## Failures

Typed codes: `not_a_repository`, `no_github_remote`, `ambiguous_remote`,
`host_not_allowed`, `client_unavailable`, `not_authenticated`, `access_denied`,
`not_found`, `rate_limited`, `network_unavailable`, `timeout`, `api_error`,
`malformed_response`.

The UI explains the scoped cause, keeps Local Repository available, and offers
a user-triggered retry. Rate-limit answers carry `retry_after_seconds` when
GitHub provides it. A 3xx redirect is refused rather than followed with
credentials.
Empty, missing, unauthenticated, denied and rate-limited are distinct states.

## Presentation

`GitWorkspace` groups **Repository** (Changes/History/Branches/Worktrees) and
**GitHub** (Issues/Pull Requests/Actions) without flattening them into seven
peer tabs. Selecting Git through the Workspace capsule opens Git Workspace
directly; the legacy Terminal Git Peek is not registered. The shared Peek
machinery remains for other capabilities.

On wide surfaces the summary list and the full-body reader scroll independently,
with an optional Focus-reading control that collapses the list. On narrow/App
surfaces the list is level one and the selected detail is a full-width pushed
view whose Back restores filtering, search, scroll and selection. Markdown is
rendered through the shared sanitizer; the only outbound control is a validated
GitHub source link. No create/edit/comment/review/merge/dispatch control exists.
