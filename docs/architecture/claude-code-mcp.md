# Claude Code MCP Integration (`#3600`)

Status: current architecture for the Claude Code Workspace's MCP resource view.

This is a **Claude-client integration**, not a second Nession MCP server. It
reads and writes Claude Code's own MCP configuration in the context of the
current Nession Session, and it registers the Nession MCP endpoint into Claude
through Claude's own CLI. The Nession MCP access layer remains owned by
[mcp.md](mcp.md); this document owns the client-side boundary.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `crates/nession-claude-code` | Resolve the Session's Claude context; typed inventory/detail/discovery/mutation/connect units; the `claude mcp` argument-vector adapter; redaction and conflict fingerprints |
| `crates/nession-server` | `server.mcp.endpoint`: whether this Server mounted `/mcp`, at which path, and which credential model applies |
| `crates/nession-mcp` | The Nession MCP endpoint, its Tool catalog and inbound authentication; no knowledge of Claude configuration |
| Web `capabilities/claude-code` | The MCP tab inside the existing Claude Code Workspace; list/detail, explicit discovery, local/project editing and Connect |
| #3251 | The canonical non-project/user-level AI resource manager. The Claude view reports user-scope entries read-only and never offers a competing global mutation owner |

No Agent picker is introduced. Every operation binds to the current Session's
Agent, OS user, effective Claude config directory and cwd.

## Session context

The Agent host supplies the Session's `cwd`, `HOME`, `CLAUDE_CONFIG_DIR` and
individual environment variables from the Session's own tmux environment. The
Agent daemon's process environment is never used to answer "which user's Claude
configuration is this". An unobservable fact resolves the view to `unavailable`
rather than to a default.

File layout:

| Scope | File |
| --- | --- |
| local | `<config>/.claude.json` → `projects[<canonical cwd>].mcpServers` |
| user | `<config>/.claude.json` → `mcpServers` |
| project | `<cwd>/.mcp.json` |
| managed | the platform's `managed-mcp.json` |

`<config>` is the Session's `CLAUDE_CONFIG_DIR` when set, and the state file
moves with it (`<config>/.claude.json`); otherwise it is `<home>/.claude.json`.
The local project key is matched against both the raw and canonicalized cwd,
NFC-normalized, because tmux reports the shell's logical path while Claude keys
by the canonical one.

## Scope precedence and states

Claude's precedence is applied whole-entry: managed (exclusive) > local >
project > user > plugin/connectors. Entries are never field-merged across
scopes.

- `effective` means "highest-precedence definition of this name", not "loaded".
- `shadowed_by` names the scope that wins a collision.
- `blocked` explains why a configured entry will not load: exclusive managed
  control, a settings rejection, an unsupported transport or an invalid name.
- `approval` distinguishes local/user (not required), managed (approved),
  project (pending/approved/rejected from the state file's
  `enabledMcpjsonServers`/`disabledMcpjsonServers`) and unknown when the source
  could not be read.
- `load_state` is always `unknown`: configuration does not prove that a running
  Claude session loaded an entry.

Plugin-provided servers and claude.ai connectors are reported as unsupported
sources. They are not omitted silently, so an empty list is never mistaken for
"this user has no servers".

## Protocol units

| Unit | Semantics |
| --- | --- |
| `claude-code.mcp-servers` | Session-scoped inventory, source statuses, precedence, host endpoint facts |
| `claude-code.mcp-server` | One named entry; optional bounded `initialize`/`tools/list` discovery |
| `claude-code.mcp-mutate` | Add/update/remove one local or project definition through the Claude CLI |
| `claude-code.mcp-connect` | Fail-closed preflight and confirmation for the Nession entry |
| `server.mcp.endpoint` | The Server's own mounted path/enabled/auth model |

All are versioned contracts in the Protocol Kernel and generated for the Web.
The request shapes carry `session_id`; routing adds `agent_id` at the transport
boundary, exactly as the other Claude units do.

## Discovery is explicit and bounded

Opening the MCP tab reads files only. It does not run `claude mcp list` or
`claude mcp get` (both perform health checks), start a stdio process, or call
`tools/list`.

`claude-code.mcp-server` performs discovery only when `probe: true`:

- HTTP/SSE: a bounded `initialize` + advertised `tools/list`/`resources/list`/
  `prompts/list`; no redirects, no `tools/call`, a 10 s per-request deadline and
  a 1 MiB body bound.
- stdio: additionally requires `allow_stdio: true`; the process is started with
  the entry's command/args/env, bounded, and always stopped.
- WebSocket discovery is unsupported.
- `headersHelper` and OAuth are refused: executing an arbitrary helper or
  taking over an OAuth flow is outside this view's contract.
- `${VAR}` / `${VAR:-default}` references are expanded from the Session's
  observed environment. A missing variable is reported by name; the literal
  reference is never sent as a credential.

A successful probe is attributed to the endpoint and the Agent that performed
it. It never asserts that a running Claude session loaded those Tools.

## Mutation

Writes use `claude mcp add-json` / `claude mcp remove` as an argument vector.
The adapter does not write `~/.claude.json` directly, and there is no shell
string construction.

- The CLI is version-gated (`>= 2.0.0`); missing, unparsable or older is
  unsupported, with no fallback to file editing.
- The CLI runs as the Session user with the Session's `HOME`,
  `CLAUDE_CONFIG_DIR`, `PATH` and cwd.
- `add-json` refuses an existing name, so an update is remove + add. The
  original raw entry is retained and restored if the add fails.
- Fields this view does not model (`timeout`, `alwaysLoad`, `oauth`) are
  preserved by merging into the existing raw entry.
- Secret values are never read back. An update sends `value: null` to keep an
  existing env/header value, and `replace_*` flags to remove values the caller
  explicitly dropped.
- An optional non-secret fingerprint detects external concurrent edits. A
  mismatch is a conflict, not an overwrite.
- A project write requires `confirm_project_write`.
- Success is the re-read of the mutated scope; a zero CLI exit alone is not
  treated as the answer. A running Claude session is not reloaded —
  `reload_required` says so.

## Connect Nession

`claude-code.mcp-connect` runs the same preflight twice: once for the UI
(`confirm: false`) and again immediately before a confirmed write.

Prerequisites, all fail-closed:

1. an actual endpoint for the chosen hosting mode — the Agent's own mounted
   endpoint, or the Server's `server.mcp.endpoint` path combined with the
   origin of the Agent's configured `server_url` (the address the Claude
   process on this host can reach);
2. MCP enabled on that host;
3. `NESSON_MCP_TOKEN` present in the Session's environment;
4. that credential accepted by a bounded MCP handshake against the endpoint;
5. a supported Claude CLI;
6. project-write confirmation when the scope is project;
7. a resolved name collision, if any.

The written entry is one HTTP server whose header is
`Authorization: Bearer ${NESSON_MCP_TOKEN}`. The token's value is read from the
Session only to verify the endpoint and never appears in the protocol, a
project `.mcp.json`, a log or a CLI argument. A missing prerequisite produces
`blocked`; the operation does not enable MCP, mint a token or configure the
endpoint as a side effect. A matching existing entry is `already_configured`
(idempotent); a different one requires explicit conflict confirmation and is
replaced with the same rollback as an update.

The Session environment is the credential binding boundary. Provisioning
`NESSON_MCP_TOKEN` is done through the Session environment binding; the view
does not export or copy an endpoint token on the user's behalf. For the Server
embedded host the value is the Server's `auth_token`; for the Agent embedded
host it is the Agent token that endpoint verifies.

## UI ownership

The MCP tab lives inside the existing Claude Code Workspace
(`Conversations | Transcripts | Memory | MCP | Configuration`). It reuses the
`ResourceDetail` / `ConfigurationForm` / `OperationSurface` recipes and the
existing Web dialog / App full-height operation primitive. The Experience host
keeps its geometry and one App Back. Scope selection lives inside MCP, and a
Session switch unmounts pending dialogs so a write cannot target the previous
Session.

## Not provided

- No second Nession MCP server or a hard-coded Tool catalog in the Claude UI.
- No automatic `tools/call`, endpoint enablement, token minting/export or OAuth
  takeover.
- No machine-wide scan, Agent picker or user-level mutation owner.
- No claim that configured equals loaded.
