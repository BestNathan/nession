# Claude Code Auto Memory resolution

> Upstream: [`#2689`](https://github.com/BestNathan/nession/issues/2689) ·
> [`docs/design/information-architecture.md`](../design/information-architecture.md)

Nession shows the Auto Memory of the **current Session's repository** inside the
Claude Code capability. This document owns how that repository and directory
are resolved; it is not a Memory product and not a machine-wide inventory.

## Ownership

| Fact | Owner |
|---|---|
| Session working directory | the agent host (`SessionContext::session_cwd`) |
| Session Claude Code environment (overrides) | the agent host (`SessionContext::session_claude_config`), read from the Session's tmux environment |
| Repository identity, project key, effective memory directory | `nession-claude-code::memory` |
| Safe, bounded file reads | `nession-claude-code::agent::read_within` (shared with `claude-code.read`) |
| Wire contracts | `claude-code.memory`, `claude-code.memory-read` (v1) |

The provider never calls the git capability. `git.root` answers the *current
work tree*, which for a linked worktree is the worktree's own root; Claude keys
memory by the **main working copy**, so two worktrees of one repository share.
It is also a `git`-process operation, while Claude's own resolver is a
filesystem walk that works without git installed. The provider therefore mirrors
Claude's walk from the Session cwd, which is still derived from the Session's
authoritative context and creates no second repository selection.

## Resolution

```text
current Session
  -> authoritative cwd                         (host)
  -> nearest ancestor with .git, or the cwd    (walk)
      -> a linked worktree's main working copy (via .git file + commondir)
  -> Session's observed Claude Code environment (tmux)
  -> effective config dir / projects root
  -> sanitized project key
  -> <projects root>/<key>/memory
```

### Repository identity

A `.git` directory means the working root is the identity. A `.git` **file**
whose `gitdir` points under `<common>/worktrees/<name>` is a linked worktree:
`commondir` resolves to the main git directory, and the identity is that
directory's parent. The upstream back-pointer check (`<gitdir>/gitdir` names the
worktree's own `.git`) is part of the test, so a relocated or malformed pointer
falls back to the working root instead of inventing a shared identity.

A submodule's `.git` file has no `commondir`; its identity stays the submodule
root. Outside Git, the Session cwd is the project root, which is Claude Code's
documented fallback.

### Project key

Mirrors Claude Code 2.1.318:

- NFC-normalise the identity path;
- replace every UTF-16 code unit outside `[A-Za-z0-9]` with `-`;
- when the result exceeds 200 units, keep the first 200 and append `-` plus
  `Math.abs(javaStringHash(original)).toString(36)`.

The upstream rules are pinned by a fixture (`tests/fixtures/long_project_key.txt`)
computed from Claude Code itself, so a "cleaner" Rust hash cannot silently
diverge.

### Effective location

The Session's tmux environment is observed for `HOME`, `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_PROJECT_DIR_NAME`, `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` and
`CLAUDE_CODE_REMOTE_MEMORY_DIR`. Unset is observed as unset; a variable the host
cannot ask about makes the whole configuration unverifiable.

- `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` wins and names the memory directory.
- Otherwise the config dir is `CLAUDE_CONFIG_DIR` or `<HOME>/.claude`.
- `CLAUDE_CODE_REMOTE_MEMORY_DIR` replaces the projects root; the key is the
  sanitized path.
- `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the key only with a custom config
  directory, and only when it passes upstream's grammar. An invalid name is
  ignored, as Claude does.
- `autoMemoryDirectory` is **not honoured**. Its effective value depends on
  settings precedence (policy, `--settings`, local, project, user) and, for a
  repository-supplied file, on workspace trust — neither of which the agent can
  verify. Any readable settings file that sets it produces
  `unsupported_override`, never the default directory.
- Machine policy sources are checked as well (managed-settings plus drop-ins).
  Tests use a thread-local root so a developer's machine policy cannot reach a
  test.

## States

| State | Meaning |
|---|---|
| `ready` | resolved; `files` lists Markdown, `MEMORY.md` first |
| `unavailable` | the host cannot name the Session or its cwd |
| `no_memory` | resolved, but the memory directory does not exist yet |
| `disabled` | a readable settings file sets `autoMemoryEnabled: false` |
| `unsupported_override` | the effective location depends on an unverifiable override |
| `error` | a filesystem read the resolution depends on failed |

`no_memory` and `error` carry the disclosure paths they did resolve.
`unsupported_override` carries the reason and never a guessed directory.

## Read boundary

`claude-code.memory-read` names a Session, the `memory_directory` its caller last
saw, and a **relative** path. The expected directory is compared with the
directory re-resolved for this request and is never joined as a read path; a
mismatch is `stale_memory`, which opens nothing. This is what stops a Session
that changes repository between the list and the read from returning the new
repository's file under the old list. The rest of the read rejects absolute
paths, `..`, and non-`.md` extensions, canonicalises before checking
containment, refuses symlinks that leave the root, caps files at 1 MiB and
chunks at 100 KiB, and shares the implementation with `claude-code.read`.
Discovery lists only the resolved directory: symlinks are skipped, recursion is
depth-bounded, and a truncated listing says so.

## Client staleness

The Web hook guards every answer with the Session key, a snapshot generation
and a read generation. Every read carries the snapshot's directory, so the
provider can refuse a repository that moved between the two operations. A
snapshot that reports a different memory directory invalidates in-flight reads,
so a Session that changes repository cannot display a page from the old one.
Entering the Memory view re-reads the snapshot; nothing is fetched while the
view is not active.

## Not part of this design

- no global scan of `~/.claude/projects`, no repository picker;
- no writes, synchronisation, index store, or separate Memory application;
- no substitution of another repository's memory when identity is unresolved.
