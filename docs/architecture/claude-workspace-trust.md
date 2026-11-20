# Claude Code Workspace Trust for Nession Sessions (`#4073`)

Status: current architecture for preparing Claude Code's first-run Workspace
Trust before an unattended `claude.enter`.

Nession creates a Session in a directory it was explicitly asked to use, then
enters Claude Code through `nession_claude_enter`. Claude Code stops on its
Workspace Trust dialog the first time it opens an untrusted directory, which
blocks an unattended `session.create → claude.enter → claude.submit` flow. This
document owns how that one dialog's acceptance is prepared from the Session's
own facts.

## Ownership

| Fact | Owner |
| --- | --- |
| Session working directory, `HOME`, `CLAUDE_CONFIG_DIR` | the Agent host (`SessionContext`) |
| Trust key, state-file choice, merge and atomic write | `nession-claude-code::workspace_trust` |
| Creation-time preparation point (warning on failure) | the Agent's injected `SessionCreatedHook` seam; `nession-agent::claude_workspace_trust` is the production implementation, composed only by `runtime.rs` |
| Enter-time safety net (refusal on failure) | `nession_claude_enter` Tool |
| Upstream storage shape | Claude Code's global configuration, pinned below |

The Agent never gains a generic "Claude settings" field, and Nession keeps no
second trust registry. The only durable trust record is the one Claude itself
reads.

## Upstream shape

Claude Code stores the answer per project in its global configuration file:

```json
{
  "projects": {
    "<project key>": {
      "hasTrustDialogAccepted": true
    }
  }
}
```

- **File**: `<home>/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json` when the
  Session sets a config directory. This is the same state file the Claude Code
  MCP view resolves (`docs/architecture/claude-code-mcp.md`), owned by
  `mcp::config::resolve_roots`.
- **Project key**: the project directory Claude resolves from the launch cwd —
  the repository root for a Git working tree, the main working copy for a
  linked worktree, and the working directory outside Git. This is Claude's
  project identity, shared with Auto Memory
  (`docs/architecture/claude-code-memory.md`); `workspace_trust` reuses
  `memory::repository_identity` rather than inventing a second walk.
- **Canonical spelling**: paths are canonicalised before keying, and the key
  string is NFC-normalised, matching the state-file matching rule the MCP view
  already documents.
- **Entry preservation**: a project entry also holds `allowedTools`,
  `mcpServers`, `enabledMcpjsonServers` and `disabledMcpjsonServers`. The
  writer changes only `hasTrustDialogAccepted`.

**Pinned evidence.** The field and entry shape were verified against the Claude
Code **2.1.329** binary (the project-entry reader and its writer merge the same
boolean into the existing entry), and the state-file location against the
repository's measured **2.1.325** layout. The Agent image pins **2.1.323**.
There is no runtime version allowlist: instead, a state file whose top-level
document, `projects` member or project entry is not the expected JSON type is
refused rather than overwritten. Whether the *running* external CLI still
renders the dialog is observed by a separate staging smoke; the deterministic
SCs do not claim it.

## Resolution

```text
SessionContext
  -> resolve_roots          live cwd, HOME, CLAUDE_CONFIG_DIR, state file
  -> canonical cwd
  -> repository_identity    nearest Git root, or main working copy for a worktree,
                            or the cwd outside Git
  -> canonical project root -> projects[<key>].hasTrustDialogAccepted = true
```

The cwd is re-resolved on **every** preparation. Creation-time preparation is
convenience; it is never authority. A Session that moved is prepared for the
directory it is in now.

## Authorization boundary

Only a directory the host resolved as this Session's live working directory can
be trusted. There is no path argument on any wire, no MCP tool that names a
trust path, and no caller-provided root.

Refused, with a specific reason:

- the host cannot observe the cwd, `HOME`, `CLAUDE_CONFIG_DIR` or the state
  file (unavailable);
- a value is not an absolute directory (invalid);
- the resolved root is the Claude home or one of its ancestors — Claude records
  home-directory trust for one session only, and trusting an ancestor would
  blanket-trust every directory beneath it (unauthorized);
- the state file is not valid JSON, or its `projects`/entry shape is not what
  Claude reads (malformed);
- the state file exists but cannot be read (unreadable);
- the merged document cannot be written (write failed).

A Claude process inside a **verified Nession Sandbox execution** runs under a
different filesystem and user-config identity than the host observes. The host
cannot verify the in-sandbox directory or config file, so `nession_claude_enter`
refuses a launch there instead of preparing trust for a root Claude will not
read.

## Durability and concurrency

- The existing document is read under an exclusive advisory `flock` on a
  sidecar `<state file>.nession-trust.lock`, merged, and replaced with a
  same-directory temporary file plus `rename`. An interrupted write leaves the
  original untouched; no partial JSON is ever visible.
- Existing permission bits are preserved; a newly created state file is
  `0600`. The sidecar lock file is left in place — deleting it would break
  mutual exclusion between Agents sharing one Claude home.
- Preparation is idempotent: an entry already `true` is left alone, and a second
  preparation returns `changed: false`.

A crashing or concurrent **Claude** process does not take the Nession lock.
Claude's own writer is outside this boundary; the lock serialises Nession
writers, which is what the multiple-Sessions-per-home case needs.

## Lifecycle

- Creation-time preparation runs after the Session exists with its environment
  binding, through the Agent's `SessionCreatedHook` seam. The runtime composes
  the Claude hook once and shares it by the P2P listener (direct
  `agent.session.create`, the MCP `nession_agent_create_session` tool) and the
  central-server connection (Server-relayed and Project-created creates), so
  every entrypoint prepares identically. A directly constructed `AgentServer`
  (tests) has no hook and writes nothing external. Failure becomes a non-fatal
  create warning; non-Claude consumers see the same Session either way.
- Enter-time preparation runs before any `claude.enter` launch. Failure is a
  `refused` outcome with the reason — never a launch followed by a claimed
  `entered`.
- Agent/container restarts retain trust because it lives in Claude's file.
- Killing a Session never removes trust: other Claude sessions may use the same
  directory.

## Not this design

- no simulated TUI keypresses, no trust environment variable;
- no tool-permission mode, MCP approval, authentication, policy-hook or sandbox
  bypass — only the trust dialog's acceptance;
- no blanket allowlist, no machine-wide scan of `projects`, no Nession trust
  store.
