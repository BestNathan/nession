# Protocol Architecture

How Nession's protocol is organised, who owns what, and where new code goes
(#678). Product design truth lives in [`docs/design/`](../design/README.md);
this document describes the protocol layer's vocabulary and rules.

## The model

Nession does not have one protocol version. It has a set of independently
evolving **Protocol Units**:

```text
Consumer ──▶ Contract ──▶ Provider ──▶ Generation
```

| Term | Means | Lives in |
|---|---|---|
| **Protocol Unit** | One independently evolving, consumer-visible protocol semantic — `git.status`, `session.attach` | its owner's `protocol/` |
| **Contract Version** | The wire/semantic version of that unit | the unit's contract |
| **Provider** | Who implements it | a crate (`nession-git`, `nession-agent`, …) |
| **Consumer** | Who depends on it | Web, CLI, Server, MCP |
| **Generation** | A provider's implementation lineage under one contract version | the provider's `runtime/` |
| **Protocol Kernel** | The stable mechanism: identity, envelope, descriptor, manifest, resolution | `crates/nession-protocol` |
| **Protocol Manifest** | What a runtime actually offers, derived from what it composed | runtime output |

### Two evolution speeds

```text
Unit   evolves by succession.   New versions are added beside old ones.
Kernel evolves by convergence.  Its shape settles, because everything depends on it.
```

A bug fix, a race fix, a performance change: same contract version, new
generation. A renamed field, a changed unit, a new required field, changed error
semantics: new contract version. Collapsing those two into one number is how a
bug fix starts looking like a breaking change.

### Identity is not the message type

`git.status` is the protocol. `extension.git.status` is the transport projection
of one of its contracts. They are separately nameable so a transport rename can
be told apart from a semantic change — only one of those is a breaking event,
and today both would look like "the string changed".

Message types therefore live on the contract as data, never as the only
definition of a protocol.

## Ownership and the dependency rule

```text
Protocol Unit  ──▶  Protocol Kernel
Protocol Kernel ──✗──▶ concrete Protocol Unit
```

This is enforced, not documented-and-hoped:

- `crates/nession-protocol`'s `Cargo.toml` has no path to `nession-common`,
  `nession-agent`, `nession-server`, `nession-git`, `nession-claude-code`, MCP or
  Web. A resolver that cannot name a concrete provider cannot depend on one.
- A concrete provider owns its DTOs, operation identity, contract metadata,
  compatibility adapters and fixtures. The kernel does not centrally own
  extension DTOs — the crate that *implements* a contract is the only one that
  can answer "what changed?" when it moves.
- The Server's generic relay depends on **no** concrete provider crate. It
  routes by manifest, not by knowing a payload schema.

### What is not a Protocol Unit

- **Product Capability** — a user-visible thing with a presence state (Files,
  Git, Claude Code in the Web UI). It *consumes* contracts; it is not one.
- **Transport Plugin** — a client-side adapter with no presence. Also not a
  contract.
- **Transport mechanism** — TLS, framing, serialisation. These are kernel, and
  they do not get generations.

Three concepts, three names. A sentence where "capability" could mean any of
them is a sentence to rewrite.

## Directory layout

### The kernel

```text
crates/nession-protocol/src/
├── lib.rs
└── kernel/
    ├── mod.rs
    ├── identity.rs     ProtocolId, ContractVersion
    ├── envelope.rs     the one Message envelope
    ├── descriptor.rs   what a unit declares about itself
    ├── manifest.rs     what a runtime actually offers
    ├── resolver.rs     requirements ∩ manifest
    └── error.rs        what resolution can refuse
```

### Core contracts

The units Nession itself owns live under `contracts/` — one module per family,
one file per contract version:

```text
crates/nession-protocol/src/contracts/
├── agent/v1.rs       agent.register, agent.heartbeat, agent.address.update
├── session/v1.rs     session.create, session.attach, session.env.apply
├── env/v1.rs         env.{list,get,write,delete} at both ends
├── commands/v1.rs    commands.{list,add,remove,update}
└── server/v1.rs      server.info
```

The family is the segment the protocol id names: `client.session.attach`
belongs to `session`, `server.env.list` to `env`. Placement is then a lookup
rather than a judgement, which is what keeps the directory from decaying into a
`misc/`. A cross-family reference is normal and expected — an attach response
carries env snapshots — and it is an ordinary `use` that the compiler checks.

A family becomes a version *directory* when it holds a second version; a `v1/`
directory holding the only version is structure without content. So each family
is a directory today (it will grow one day) and each version is a single file —
the same rule as the provider layout below, applied to the units Nession owns.

A contract's tests live beside it, in `contracts/<family>/tests.rs`. A contract
whose tests sit in a shared file two directories up is one that can change
without its tests being read.

`contracts/` is not a central DTO repository, and the distinction is the whole
point of the ownership rule: `nession-protocol` owns the units *Nession itself*
serves, and a concrete provider owns its own. What makes them different is not
who reads them but who can answer "what changed?" — for `session.attach` that
is Nession, for `git.diff` it is `nession-git`.

### A provider

```text
crates/nession-git/src/
├── protocol/
│   ├── status/
│   │   └── v1.rs      typed request/response + descriptor
│   └── diff/
│       └── v1.rs
├── runtime/           the provider implementation
└── agent.rs           the erased dispatch boundary
```

Typed at the contract boundary; erased only at the dispatcher boundary. The
outermost `handle_command(command: &str, payload: Value) -> Value` stays — it is
how a registry dispatches without knowing every type. What changes is that the
`Value` is decoded into a typed request **once, at the boundary**, and never
carried through the provider as the contract.

## How to evolve a Protocol Unit

### Add a Protocol Unit

1. Choose the canonical id: lowercase segments joined by `.`, at least two
   segments (`unit.operation`), no underscores. `git.status`, `claude-code.read`.
   The `protocol://` prefix is a display convention and is rejected by
   `ProtocolId::new`.
2. Write the contract **where its provider lives** — a typed request, a typed
   response, and a `ProtocolDescriptor` naming the owner and the contract
   versions. For an extension that is the provider's crate
   (`nession-git/src/protocol/<unit>/v1.rs`); for a unit Nession itself serves
   it is `nession-protocol/src/contracts/<family>/v1.rs`. What does **not** go
   in `nession-protocol` is another crate's DTOs — see "What this crate is not"
   in `lib.rs`, and the ownership test below.
3. Declare the wire message types on the contract. They are the transport
   projection and may differ from the id.
4. Register the provider at the composition root. The manifest is derived from
   what is composed — nothing advertises a contract no runtime serves.

### Publish a new Contract Version

Upgrade the version when a consumer-observable thing changes: a new **required**
field, a removed or renamed field, a changed type or unit, changed defaults,
changed error semantics, a new enum value that breaks an old consumer, or a
permission change that alters observable behaviour.

Do **not** upgrade for a bug fix, an internal refactor, a new optional field
whose absence preserves the old meaning, or a new response field consumers
already tolerate.

Add the new contract **beside** the old one: a new `v2.rs` next to `v1.rs`,
both listed in the family's `mod.rs`. Never edit a shipped version in place to
express a new one — that is the "optional fields and serde defaults instead of
versions" failure, and it makes the old wire shape unrepresentable.

A family whose versions diverge — `session.create/v2` while `session.attach`
is still v1 — promotes its version files to directories, `session/v1/` and
`session/v2/`, so a version is one addressable thing rather than a suffix
scattered across a file. Until then the files stay files.

### Provide a legacy adapter

A peer with no manifest is a **Legacy Peer**, not a peer that supports
everything. Only contracts with an explicit, evidence-backed adapter are served
to it:

```text
git.status/v1
  legacy_wire    = extension.git.status
  legacy_payload = flat
```

Everything else answers `protocol_not_advertised`. It is forbidden to guess a
payload shape from a software version, to downgrade unconditionally when a
manifest is missing, or to silently fall back semantically.

### Resolve as a consumer

A consumer declares what it can read, per unit, and resolves that against each
target's manifest. Both halves exist and the Rust one is
`nession-protocol`'s `select_version`:

```text
Consumer Requirements  ∩  Provider Manifest  →  the contract version to use
```

The Web's copy is `web/src/platform/protocol/` — `resolveContract`,
`addressedPayload`, and the per-connection `ProtocolDirectory` that
`product/agent` fills from `client.agents.list`. A capability declares its
requirements next to the wire strings it already owns
(`capabilities/git/GitPlugin.ts`), because the versions and the DTOs it reads
them with are the same fact written twice, and today only a comment keeps them
in step — `### Generate consumer types` is what removes the comment.

Four rules, each of which is a way this goes wrong quietly:

- **Per target, never per connection.** The Web reaches several agents through
  one server, and one agent's versions say nothing about another's. Resolving
  once and reusing it is the failure the design names outright.
- **Highest common version**, not the target's newest. A consumer speaking v1
  talking to a target offering v1 and v3 lands on v1.
- **Versions are not contiguous.** `[1, 3]` is a legitimate answer set.
- **Naming no version is not a refusal.** A target with no manifest is a Legacy
  Peer and is addressed exactly as it was before any of this existed. A
  consumer that *knows* it shares no version with the target must refuse
  locally: sending nothing would be relayed as a Legacy Peer request and put a
  v1-shaped payload in front of a v2-only target. The server's check is a second
  boundary against a stale manifest, not the first one.

A refusal names both sides, on the client exactly as on the server:
`` `agent-a` offers `git.status` at [v2], which this client cannot read ``.

### Generate consumer types

Rust contracts are the source of truth. Generated TS carries the DTOs, the
protocol id constants, the operation request/response map and manifest metadata.
Generated output is deterministic, committed, never hand-edited, and CI
regenerates and diffs it so drift fails the build.

Product Capability UI state stays hand-written — only real wire contracts are
generated.

### Retire a contract

1. Mark the descriptor `Lifecycle::Deprecated`. It stays advertised: if it
   stopped being served at the moment you told consumers to migrate, their
   migration would start with an outage.
2. Move consumers. Watch the manifest to see which providers still offer it.
3. Mark it `Lifecycle::Retired`. It leaves every manifest and stops being
   served. **Keep the descriptor** — a retired id that disappears is an id that
   comes back meaning something else.

## Where the rules are enforced

| Rule | Enforced by |
|---|---|
| Kernel depends on no unit | `crates/nession-protocol/Cargo.toml` |
| A core contract cannot reach a concrete provider either | the same file — `contracts/` sits inside that crate, so the rule covers it without a second mechanism |
| Ids are canonical | `ProtocolId::new`, `#[serde(try_from)]` on the way in too |
| One contract per version; one version per wire type | `ProtocolDescriptor::validate` |
| Manifest lists only what was composed | `ProtocolManifest::from_descriptors` |
| Retired units are not advertised | the same function |
| Highest common version, not newest | `select_version` |
| Compatibility is never read from a software version | the resolver takes no version; pinned by a test |
| A unit with no common version does not kill the connection | `ProtocolError::is_unit_scoped` |
| Two providers cannot claim one wire type or one protocol | `ExtensionRegistry::new` → `RegistryError`, naming both claimants |
| An extension that declares nothing is a composition mistake | the same function |
| What is routed is what is advertised | the routes are *derived* from the descriptors — there is no second list |
| A router can name a protocol without knowing any provider | `ContractSupport.wire` — the projection is declared by the provider, not derived by the router |
| A target is never asked for a wire type it does not carry | the Server's extension relay, gated on the target's manifest |
| A peer without a manifest still works | the same gate, skipped when there is no manifest — a Legacy Peer, not a peer that said no |
| A consumer resolves per target, not per connection | `ProtocolDirectory` is keyed by agent id and replaced wholesale by each agent-list snapshot |
| A consumer never sends a version it cannot read | `addressedPayload` refuses locally — the server's gate cannot catch this case, because a caller that names nothing is relayed as a Legacy Peer |
| Every path that learns an agent list publishes it | `AgentsPlugin.listAgents` and the `agents.changed` push, both calling one `publishProtocols` |
| The agent list carries the same fields on every path | `server/agent_view.rs` — one builder, because the two hand-built ones had already drifted |

### Why the manifest carries the wire projection

The Server relays `extension.git.status` without knowing what `git` is. To gate
that relay it must answer "does this peer carry this message?", and it cannot
turn the wire string into the protocol id `git.status` on its own — there is no
universal rule: the registry's own strip-the-namespace transform yields
`claude_code.read` where the id is `claude-code.read`. So the mapping is
**declared** by the provider that owns it and travels in the manifest.

A manifest whose `wire` is absent — a peer predating the field — answers *no* to
every wire query. That is the safe direction: **has not said** is not **said
yes**, and the relay gate is skipped entirely for such a peer rather than
refusing on its silence.

### Where a target's support is served

`client.agents.list` carries each agent's manifest as `protocols`, `null` for a
peer that advertised none. It is served from the list rather than a query of its
own because that is already the discover-agents call — a consumer resolving per
target gets every manifest without a second round trip per agent. The CLI's
`agents list` reads the same field and prints `legacy` rather than `0 units` for
a peer without one, because those two resolve differently.

### What "derived" buys over "checked"

The design lists *provider advertises no handler* and *handler exists but not
advertised* as startup failures. Both are failures only while the advertised set
and the routed set are two lists. `ExtensionRegistry` builds its routing table
**from** the descriptors, so the two sets are one set and neither state is
constructible. That is a stronger guarantee than detecting either after the
fact — and it is why `AgentExtension` declares descriptors rather than the
`message_types()` it used to, which nothing tied to the provider's own dispatch.

## Related

- `#678` — the requirement this document implements.
- `#565` — shared `nession-mcp`, which consumes the same contracts rather than
  copying Nession DTOs.
- [`docs/architecture/web.md`](web.md) — the Web layer model this mirrors on the
  client side.
