# CLI connection profiles

A **Profile** is a persistent client connection context for the remote CLI
(`agents`/`sessions`): a named Server endpoint plus the credential policy for
reaching it (#4682). It is deliberately **not** an Agent, Project, Session or
release, and it does not require a running local daemon.

This document is the canonical public contract for the profile surface, the
connection resolution matrix and the credential boundary. The executable
owners are `crates/nession-cli/src/profile/` (storage),
`crates/nession-cli/src/connection/mod.rs` (the one resolver) and
`crates/nession-cli/src/commands/profile/` (leaf handlers).

## Evolution of #2267

#2267 established that remote commands never read a **daemon** config: an
Agent's outbound `server_url` is not where the CLI is pointed, and a daemon
credential is a different direction. That boundary is preserved. #4682 adds an
**independent, installation-owned client store** and a **one-time, endpoint-only
import** of an explicitly configured Agent `server_url`. Daemon credentials
(`auth_token`, `agent_token`) are never copied, derived or sent by a client
profile. The former "no config file source" invariant is now: *the remote chain
never borrows daemon configuration or credentials; the client store is a
separate owner*.

## Storage and ownership

```text
<installation home>/                 # NESSION_HOME or ~/.nession
  client-config.toml                 # profile metadata (0600, no secrets)
  client-config.lock                 # advisory mutation lock
  client-credentials/                # private file fallback (0700)
    <profile>.toml                   # one endpoint-bound credential (0600)
```

`client-config.toml` is typed and validated on every load and write:

```text
schema_version = 1
current_profile = "home"
[profiles.home]
server_url = "wss://nession.example.internal/ws"
credential_ref = "home"              # present iff a credential is stored
credential_backend = "file"          # "file" or "keychain"; paired with the ref
[profiles.local]
server_url = "ws://127.0.0.1:8080"
no_auth = true                       # explicit no-auth; exclusive with a ref
```

- `schema_version` other than `1`, unknown fields, malformed TOML, an invalid
  URL/name, a dangling `current_profile` or a ref/backend mismatch are refused
  **without mutation**. A corrupt store is never overwritten.
- Profile names: 1–64 characters, starting with a letter or digit, then
  letters, digits, `_` or `-`.
- Endpoints: `ws`/`wss` URLs with a host, **no userinfo, query or fragment**
  (those are common secret carriers; a profile endpoint is a bare target).
- `credential_ref` must equal the profile's own name: a reference is scoped to
  one profile and its canonical endpoint.
- Mutations hold an exclusive `flock`, reload under the lock, edit one entry,
  revalidate the whole file and publish with an atomic 0600 rename. Concurrent
  updates preserve unrelated entries; concurrent first-use bootstrap converges
  on one store.
- The store, lock and credential directory are **installation-owned**: upgrades
  retain them in place and release archives never receive a copy (see
  [cli-release-versioning.md](cli-release-versioning.md)).

## Command grammar

```text
nession profile list | current | show <name> | use <name> | test [<name>]
nession profile add <name> --server-url <url> [--no-auth]
nession profile set <name> [--server-url <url>] [--no-auth]
nession profile remove <name> [--force]
nession profile import-agent [--name <name>] [--config <path>]
nession profile credential set <name> [--stdin]
nession profile credential clear <name>
nession --profile <name> agents|sessions …
NESSION_PROFILE=<name>
```

- `add`/`set` consume the global `--server-url` as the endpoint to store. **No
  profile leaf accepts `--auth-token`**: credentials are set through
  `profile credential set` only.
- `list`/`current`/`show` are offline, masked inspections; they make zero
  connections and display the selection and its source, never fabricated
  health.
- The first `add`/`import-agent` selects the profile when no current exists;
  later adds/imports never change an existing selection. `use` is the explicit
  selection command and changes only the client selection.
- A duplicate `add`/`import-agent` fails without overwrite; `set` is the
  documented replacement operation.
- `set --server-url` that changes the canonical endpoint **invalidates** the
  bound credential (its owned, unreferenced bytes are deleted) unless
  `--no-auth` is given. `--no-auth` alone also deletes the bound credential.
- `remove` of the current profile requires `--force` and clears the selection;
  it never silently selects another remote target. Only owned, unreferenced
  credentials are deleted.
- `test` performs a bounded (10s) real connection/authentication against the
  named (or current) profile and reports success, auth denial, connection
  failure or timeout with sanitized diagnostics. It never changes the
  selection and never falls back to another profile/Server.
- Daemon lifecycle (`agent start`/`restart`), local-only commands and the
  profile management leaves **reject** `--profile` rather than ignore it;
  profile resolution never runs on the daemon path.

## Credentials

The credential store is independent from profile metadata:

- **OS credential store preferred** (macOS Keychain, Windows Credential
  Manager, Linux Secret Service), under service `nession-cli`, account =
  profile name. **Private file fallback** (`client-credentials/<name>.toml`,
  0600 in a 0700 directory) when no OS store is available.
  `NESSION_CREDENTIAL_STORE=file|keychain|auto` selects explicitly; `auto`
  probes the OS store and notes the fallback on credential commands.
- **No silent downgrade.** The backend holding a credential is recorded in the
  profile metadata. Reading a credential whose recorded backend is unavailable
  is a hard error, never a quiet read of another store; an access failure is
  always surfaced. Loose permissions on the fallback file/directory are
  refused.
- `credential set` reads a masked terminal prompt, or one line of stdin with
  `--stdin`. The secret never travels as argv, and never appears in the profile
  TOML, output, logs, errors, backups or diagnostic receipts. Re-running `set`
  rotates; `clear` deletes the bytes and returns the profile to the unset
  state. An empty credential is refused — explicit no-auth is `set --no-auth`.
- A credential record binds the secret to the profile's **canonical endpoint**
  (shared address normalization: case, default ports, trailing slash). A
  mismatch at resolution refuses the connection.
- The existing `--auth-token` remains compatible with its documented argv risk;
  it deliberately binds to this invocation's resolved target.

## Bootstrap and migration

Only when **no explicit target/profile/env target and no client store exists**,
the first eligible remote command may initialize a default profile (`agent`)
from a **valid, explicitly configured** Agent `server_url` at the canonical
Agent config path:

- **Endpoint only.** `auth_token`/`agent_token` are never copied or derived.
  The imported profile starts with an unset credential; the command refuses
  with setup guidance rather than sending a daemon or ambient secret.
- **Absent config** → the legacy loopback remains permitted, with an actionable
  setup hint on failure. **Invalid/unreadable config** → an actionable error,
  no silent fallback and no bogus profile from `AgentConfig` defaults. A config
  without an explicit `server_url` key is not an import source.
- An existing store with **no selection** requires explicit selection
  (`profile use`); bootstrap does not run again. A **corrupt** store is never
  overwritten; explicit `--server-url` commands keep a safe stateless path that
  does not consume the store.
- Bootstrap is idempotent under concurrent first invocations. Explicit
  flags/env never persist automatically. Later Agent changes never overwrite
  the client selection or credentials (no continuous sync).
- `import-agent` is the explicit form, with `--name` and `--config` for a
  custom Agent config; a missing/invalid source fails closed.

## Connection resolution matrix

One `ConnectionContext` resolver (`connection/mod.rs`) resolves **target and
credential as a pair** for every `agents`/`sessions` leaf and `profile test`.

Target precedence (highest first):

| # | Source | Notes |
| --- | --- | --- |
| 1 | `--server-url` | stateless; never reads the client store |
| 2 | `--profile` | overrides ambient URL variables; must exist |
| 3 | `NESSION_SERVER_URL` | canonical env |
| 4 | `NENSION_SERVER_URL` | legacy alias |
| 5 | `NESSION_PROFILE` | must exist |
| 6 | persisted current profile | store exists; no selection → explicit-selection error |
| 7 | first-use Agent endpoint bootstrap | only when no store exists |
| 8 | `ws://127.0.0.1:8080` | legacy loopback default |

`--server-url` + `--profile` together is **rejected as ambiguous** (the
documented exception to precedence). A missing/invalid explicitly named
profile fails closed.

Credential policy per resolved target:

| Target source | Credential sent |
| --- | --- |
| `--server-url`, env URL, loopback | `--auth-token` if given, else ambient token (`NESSION_AUTH_TOKEN` then `NENSION_AUTH_TOKEN`), else empty (legacy flows; token-only env backward compatible) |
| named/current/imported profile | `--auth-token` if given (deliberate per-invocation binding); else an ambient token **only when an accompanying ambient URL is the same canonical endpoint**; else the profile's endpoint-bound credential or explicit no-auth |

- An ambient token is **never** silently applied to a selected named profile or
  imported endpoint without a matching explicit target context.
- A profile with an **unset** credential refuses with setup guidance (no dial).
- An explicit empty `--auth-token ""` (or empty env token) is a deliberate
  no-auth override for that invocation.
- Unsafe ambiguous combinations are rejected with actionable diagnostics;
  there is no retry against another profile/Server.
- `agent start`/`restart` keep the existing flag/env > daemon-file override
  behavior; profile resolution never runs there.

On connection failure the CLI names the selected profile (if any), the
sanitized endpoint (userinfo stripped), the target source, the credential
policy and the actionable next command — never the credential.

## Release continuity and archived versions

Profile metadata and credentials are **live installation-owned state**.
Upgrade, failed upgrade and archive-only install preserve selection, bytes and
credential references; the snapshot owner recognizes them and never copies them
into an archive (no secret duplication, no selection reset).

Archived command dispatch rebinds `NESSION_HOME` to the version home. The
installation client context is distinct from that archived daemon state:

- A **profile-aware** archive advertises `nession-client-profile-v1` through the
  hidden `--client-profile-contract` probe. The dispatcher hands it
  `NESSION_CLIENT_HOME=<installation home>`; the archive consumes the client
  context **read-only** after schema validation. Every client mutation
  (`add`/`use`/`set`/`remove`/`import-agent`/`credential …`) and bootstrap is
  refused on a dispatched archive.
- An **unsupported** archive keeps legacy explicit URL/env behavior. The
  dispatcher refuses, with actionable version/explicit-target guidance: any
  `profile` command, a `--profile` flag, `NESSION_PROFILE`, or an implicit
  invocation while a live client store exists. It never silently reinterprets a
  selected profile as localhost.
- An unknown client-store schema is refused read-only, never guessed or
  overwritten. Credentials are never duplicated into release archives, and
  daemon lifecycle/state ownership gates are unchanged.

## Implementation owners

- `crates/nession-cli/src/profile/{mod,store,credential}.rs` — schema,
  persistence, credential backends.
- `crates/nession-cli/src/connection/mod.rs` — the one target/credential
  resolver and failure diagnostics.
- `crates/nession-cli/src/args.rs`, `commands/mod.rs`, `commands/profile/` —
  surface, applicability and leaf handlers.
- `crates/nession-cli/src/versions/mod.rs`, `update/{mod,snapshot,transaction}.rs`
  — dispatch compatibility and installation-owned retention.
- `crates/nession-common/src/paths.rs` — client-context path helpers.
