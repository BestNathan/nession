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
| **Protocol Unit** | One independently evolving, consumer-visible protocol semantic — `git.status`, `session.attach` | the owner's `protocol/`, or `contracts/` when the owner is Nession itself |
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

### Identity and the message type

`git.status` is the protocol. Its contract also declares the message types it
travels as — and since `#912` those are the same string, because the wire *is*
the id. The two remain separately *modelled* so a transport rename can be told
apart from a semantic change: only one of those is a breaking event, and
otherwise both would look like "the string changed".

That the separation is currently unexercised is a fact about today's units, not
a licence to collapse the fields — `protocol-identity.md` records why it is
kept, and it is what would let one unit answer on a second wire without a second
identity.

Message types therefore live on the contract as data, never as the only
definition of a protocol.

### One wire per operation

**A request and its reply share the same wire name.** They are told apart by the
envelope's `id`, never by `msg_type`: a caller holds the id it sent and treats
the message carrying it as its answer. Everything else — a request that is still
in flight, a notification, a message whose requester has given up — is routed by
name as before.

`<unit>.<operation>.response` was the previous spelling, and it is gone. It made
every operation two names that had to agree, and the second one bought nothing:
the Web's router has always keyed its pending map by `id`
(`platform/socket/MessageRouter.ts`), so `msg_type` was never what correlated a
reply there. The CLI matched `msg_type` against the reply's name, which is the
one place the suffix was load-bearing — it correlates by `id` now, in the same
change as the wire names.

Two consequences worth knowing:

- **Pending wins.** When a message arrives whose `id` is in the caller's pending
  map it *is* the reply, whatever else subscribes to that name. This is not an
  accident of one implementation: `MessageRouter.handleIncoming` returns as soon
  as it has correlated, so a reply never reaches subscribers. The edge case is a
  reply that arrives *after* its request timed out — its id is no longer pending,
  so it fans out to subscribers as an unsolicited message of that name.
- **A one-way unit is one wire, not half of two.** A unit whose answer is a
  message of its own (`agent.keepalive.ping` → `keepalive.pong`) has
  `response: None`: the reply slot names a *shape under this unit's wire*, so it
  is the wrong place to describe a different message.

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

- **Notification** — a reply to something the other end sent, on a wire of its
  own. The one that looks most like a unit; see below.
- **Product Capability** — a user-visible thing with a presence state (Files,
  Git, Claude Code in the Web UI). It *consumes* contracts; it is not one.
- **Transport Plugin** — a client-side adapter with no presence. Also not a
  contract.
- **Transport mechanism** — TLS, framing, serialisation. These are kernel, and
  they do not get generations.

Four concepts, four names. A sentence where "capability" could mean any of them
is a sentence to rewrite.

#### A notification is not a unit

The other three are things *around* the protocol. A notification is *inside* it —
it has a wire, a payload type and a sender — which is why it is the one that gets
mistaken for a unit. The test is one question:

> **Does anything dispatch it?** A unit is something a dispatcher answers. A
> notification is a reply to a message *you* sent: no route table has an arm for
> it, and nothing can ask for it.

`server.agent.heartbeat` is a unit — the server's route table has an arm for it,
and it answers. Its acknowledgement arrives on `server.heartbeat.ack`, for which
no route table has an arm; the agent logs it in the plain match beside its
dispatcher. So the heartbeat is a unit, the ack is not, and the catalog gives the
heartbeat `response: None`: its acknowledgement travels on a wire of its own
rather than under the heartbeat's, so there is no wire for a response shape to
attach to.

Advertising the ack instead would **claim an offer that does not exist** — the
manifest is a statement of what you can be asked for, and nobody can ask for an
acknowledgement.

Two consequences, worth knowing before going to look for a unit to add:

- **The wire is still declared.** A notification's wire appears as a `pub const`
  beside the dispatcher that handles it, which is how the gate learns it exists.
  It is not in a route table because no route table can describe it.
- **Its payload type is carried by no unit**, so `just codegen` never emits it.
  That is correct when the receiving peer is not the Web — the heartbeat's ack
  goes to an agent, which is Rust — and worth a second look when it is, because a
  shape no unit carries gets no generated binding.

The same rule, shortened to the test alone, is on the `Unit` type in
`crates/nession-protocol-codegen/src/catalog.rs` — which is where someone arrives
when the schema reports that a unit has no `response`.

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

The family is the segment the protocol id names: `server.session.attach`
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
├── protocol/          the contract: typed request/response + wire shape
│   ├── status/
│   │   └── v1.rs      request, ok-payload, descriptor, and every type it carries
│   └── diff/
│       └── v1.rs
├── runtime/           the implementation: what answers those contracts
│   ├── cmd.rs         the one place a `git` process is spawned
│   ├── security.rs    the input boundary
│   └── status.rs …    the parsers, and the `impl` blocks for the shapes
├── agent.rs           the erased dispatch boundary
└── lib.rs
```

The split is load-bearing rather than tidy. `protocol/` is what a consumer
codes against and what a version bump changes; `runtime/` is what may be
rewritten freely under the same contract version — which is the "two evolution
speeds" distinction above, made visible in the tree instead of stated only in
prose.

**Every type on the wire is a type in `protocol/`, including the payloads.**
That was not true until `#678` Phase 5 needed it: the requests and ok-wrappers
were typed, but their payloads (`RepoStatus`, `Branches`, `History`, …) were the
*parser's* types, living under `runtime/`. Nothing enforced the rule, so nothing
noticed — until a generator asked "what shape is this contract?" and the answer
was in the implementation half. `runtime/` now imports those shapes instead of
declaring them, and keeps only what it does with them.

The `impl` blocks stayed in `runtime/` on purpose. A shape is what the wire
carries; `RepoStatus::is_clean()` is a question someone asks *about* one.

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
   projection, and since `#912` the wire **is** the id — a unit whose id is not
   also a wire is one no peer can call. The kernel still models the two
   separately, because that separation is what makes a transport rename a
   non-event rather than a semantic change; it is simply not exercised today.
   `protocol-identity.md` owns the rule and the one boundary it has.
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

### A peer with no manifest is refused

`#678` is a **breaking upgrade**, and this is where that is decided. An agent
that advertises no manifest does not connect.

The alternative — a legacy adapter, with each contract declaring an old wire
shape and a downgrade rule — was designed and is deliberately not built. It
would be machinery for serving peers that will never exist here, and every part
of it is a place where a wrong guess is invisible: a relay that went through an
adapter looks exactly like a relay that did not need one. Refusing cannot be
wrong quietly.

Two things follow, and they are the whole mechanism:

- **Registration refuses.** `agent.register` without a `protocol_manifest` is
  answered `status: "rejected"` and the agent's connect fails. The field stays
  `Option` on the wire so this is a *clear rejection* rather than a parse error —
  an old agent's payload deserializes, and the answer says why.
- **The relay refuses.** A target the registry holds *no* manifest for is not
  relayed to. Registration already turns those away, so reaching this means a
  **straggler**: one that registered before the server was upgraded and has not
  reconnected since. It answers `contract_not_supported`, which is a
  unit-scoped refusal that leaves the connection and every other unit alone.

So the vocabulary changes with it. There is no **Legacy Peer** — a peer whose
answer is unknown — because there is no state in which the server has to
proceed without one. The only two states are *has a manifest* and *has not
reconnected*.

### What is refused, and what is not

The same section has to be read together with the one above, because "refuse"
means two different scopes:

| Situation | Scope | Answer |
|---|---|---|
| No manifest at `agent.register` | connection | rejected; the agent never comes up |
| No manifest in the registry (straggler) | unit | `contract_not_supported` on each call; the socket stays |
| Manifest present, unit not advertised | unit | `contract_not_supported`; the socket stays |
| Manifest present, named version not offered | unit | `contract_not_supported`, naming both sides |

Only the first is a connection-level answer, and it is the only one that is
about the *peer* rather than about a *call*. The rest are the design's
"a unit with no common version disables that unit and does not take the
connection with it", which is why a target that simply lacks one extension still
serves every other one.

### Resolve as a consumer

A consumer declares what it can read, per unit, and resolves that against each
target's manifest. Both halves exist and the Rust one is
`nession-protocol`'s `select_version`:

```text
Consumer Requirements  ∩  Provider Manifest  →  the contract version to use
```

The Web's copy is `web/src/platform/protocol/` — `resolveContract`,
`addressedPayload`, and the per-connection `ProtocolDirectory` that
`product/agent` fills from `server.agent.list`. A capability declares its
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
- **Naming no version is not a refusal.** A caller that names no version is
  relayed, because absence is not a claim about versions. A consumer that
  *knows* it shares no version with the target must refuse locally: sending
  nothing puts a v1-shaped payload in front of a v2-only target. The server's
  check is a second boundary against a stale manifest, not the first one.

A refusal names both sides, on the client exactly as on the server:
`` `agent-a` offers `git.status` at [v2], which this client cannot read ``.

### Generate consumer types

Rust contracts are the source of truth. Generated TS carries the DTOs, the
protocol id constants, the operation request/response map and manifest metadata.
Generated output is deterministic, committed, never hand-edited, and CI
regenerates and diffs it so drift fails the build.

**The same contracts project a second way**, for a consumer that validates a
message rather than imports a shape:

```bash
just protocol-schema > protocol-schema.json   # every protocol, one document
just protocol-schema agent.session.create     # one operation, and only the
                                              # definitions it references
```

JSON Schema (2020-12), from the same catalog the TypeScript comes from, so the
two cannot describe different contracts. A unit whose handler reads raw JSON
rather than a named type has `request: null` — the document says so instead of
inventing a shape it cannot vouch for.

Product Capability UI state stays hand-written — only real wire contracts are
generated. `capabilities/git/types.ts` is the shape that leaves behind: 238
lines of hand-copied shapes became alias declarations, and the plugins read
`WIRE`, `PROTOCOL` and `VERSION` out of the generated files instead of writing
the strings themselves.

**What replacing them found is the argument for doing it.** Thirteen type errors
appeared the moment the imports changed, one per place the copy had drifted from
the contract — `truncatedBytes` where the wire says `truncated_bytes` (so a
truncation notice had been rendering `NaN`), `reason` read off variants that do
not have it, a two-variant union flattened into one interface, and a field the
contract never had. None was visible by reading the mirror, because the mirror
defined what the code was written against. One of them is worth keeping in mind
when a test suite looks reassuring: a component test asserted the truncation
notice said "4.0 KB" and **passed**, because the test's mock and the component
agreed on a field name the agent never sends.

It runs as `just codegen` and reads:

```text
crates/nession-protocol-codegen/src/catalog.rs   which types are which contract
        ↓  ts-rs answers "what TypeScript shape is this Rust type?"
web/src/generated/protocol/git/status/v1.ts            a provider's unit
web/src/generated/protocol/claude-code/read/v1.ts      a provider's unit
web/src/generated/protocol/core/session-create/v1.ts   the kernel's
```

The directory is the id with the owner's prefix removed and dots as dashes —
one rule for both kinds. For a provider the prefix *is* the owner, so
`git.status` under `git` is `status`. The kernel's units are nobody's prefix:
`server.session.create` and `agent.session.create` are both the kernel's, and
truncating them to their last segment would put both in `create`, as it would
`agent.attach` and `server.session.attach` in `attach`. Two units writing one
file fails nothing — the second write wins and the Web imports a contract it did
not ask for — so `check_paths_are_unique` refuses it rather than letting the
last writer through.

**ts-rs owns the type translation; this repository owns everything else** — the
layout, the identity constants, the request/response aliases and which types a
contract is made of. A generator that also translated types would be a second,
worse ts-rs; one that let ts-rs own the layout would emit one file per type with
imports, which is not the layout above.

Four things about the output that are decisions rather than details:

- **One file per unit, self-contained.** No imports between generated files, so
  a reader answers "what does `git.status` look like?" by opening one file. The
  duplication that costs is generated, so it cannot drift — and it is *checked*,
  not assumed: the generator refuses to write a file that refers to a name it
  does not declare, using ts-rs's own dependency data.
- **`WIRES`, and `WIRE` only when there is one of them.** A contract carried by
  two transports has no single wire, and `session.create` is carried by three.
  Emitting a `WIRE` for it would mean picking one and dropping the rest
  silently; instead the multi-wire unit has no `WIRE` at all, so a caller that
  needs one is made to say which it means by a `tsc` error rather than by a
  string that compiles and is wrong.
- **There is no `index.ts`.** The first version had one and `tsc` refused it —
  every unit exports `PROTOCOL`, `WIRES` and `VERSION`, so a barrel is a wall of
  ambiguity errors. The fix is not to rename the constants: a barrel would let a
  consumer import a shape without saying which contract version it is, which is
  the thing this whole document is against. The version is in the import path.
- **`u64` is `number`, not ts-rs's default `bigint`.** Every integer here
  arrives through `JSON.parse` as a `number`, so `bigint` would describe a value
  the runtime never produces. The design requires the number range be explicit;
  this is where it is, in one `Config`.
- **The gate compares against a scratch directory**, not against the working
  tree. Regenerating in place and diffing with `git diff --exit-code` repairs
  the condition it is testing: the run after a failure would diff an already-
  regenerated tree, pass, and leave the committed files stale.

**A skippable `Option` needs both serde attributes, and that is not obvious.**
ts-rs makes a field optional in TypeScript only when `skip_serializing_if` **and**
`default` are both present. Serde needs only the first — measured: a missing
`Option` field deserializes to `None` with no `default` — so the two disagree
about twenty-four fields, and ts-rs's answer (`branch: string | null`) was wrong
twice: the wire omits it, and it is never null. The fix is not a codegen
annotation. It is adding `default`, which is the spelling the rest of these
contracts already used and is a **no-op on the wire** — `default` affects
deserialization only, and serde's `Option` behaviour is unchanged by writing it
down. So: `#[serde(default, skip_serializing_if = "Option::is_none")]` wherever
a field may be absent. `field?: T | null` is ts-rs's `Option` rendering and the
`| null` is loose — no such field ever serialises as null — but it rejects
nothing that is valid, which is the direction that matters.

Still unhandled, and it should land with the first consumer: a `#[serde(default)]`
field on a **non-`Option`** is emitted as required. `#[ts(optional)]` is refused
on anything but `Option`, so `AgentMetadata.image_tag`, `protocol_version`,
`preferred_mode` and the `Vec`s beside them are omittable on the wire and
required in the generated type. Nothing consumes these bindings yet, so nothing
is broken by it.

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
| The same holds for the agent's core units | `core_routes!` (`crates/nession-agent/src/protocol/mod.rs`) — one invocation emits `core_descriptors()` **and** `dispatch_core()` |
| One wire type, one claimant, across both halves | `ExtensionRegistry::new` — `DuplicateCoreWireType` names both, whichever side lost |
| A core unit the agent does not serve is not advertised | the same invocation — `CORE_WIRES` and `core_descriptors()` are the same list |
| The same holds for the Server's units | `server_routes!` (`crates/nession-server/src/protocol/mod.rs`) — one invocation, and `every_unit_the_server_dispatches_is_in_its_manifest` says so |
| A client can ask the Server what it serves | `server.info` → `ServerInfoResponse.protocol_manifest` |
| A router can name a protocol without knowing any provider | `ContractSupport.wire` — the projection is declared by the provider, not derived by the router |
| A target is never asked for a wire type it does not carry | the Server's extension relay, gated on the target's manifest |
| A peer with no manifest does not connect | `handle_agent_register` — `protocol_manifest` is required, and its absence is a rejection |
| A straggler is refused per call, not disconnected | the same gate as any other unsupported unit — `contract_not_supported` |
| A consumer resolves per target, not per connection | `ProtocolDirectory` is keyed by agent id and replaced wholesale by each agent-list snapshot |
| A consumer never sends a version it cannot read | `addressedPayload` refuses locally — the server's gate cannot catch this case, because a caller that names nothing is relayed |
| Every path that learns an agent list publishes it | `AgentsPlugin.listAgents` and the `agents.changed` push, both calling one `publishProtocols` |
| The agent list carries the same fields on every path | `server/agent_view.rs` — one builder, because the two hand-built ones had already drifted |
| Generated bindings are what the contracts say | `just check-codegen` (`scripts/check-codegen-drift.sh`) — regenerate into a scratch directory, diff |
| Every advertised contract has generated bindings | `nession-protocol-codegen`'s `every_advertised_contract_is_in_the_catalog`, against all four runtimes' own declarations — the agent's `served_descriptors`, the server's `server_manifest`, and the two providers' `descriptors()` |
| Two units cannot generate to one file | the same crate's `check_paths_are_unique`, run by the generator |
| A generated file refers to nothing it does not declare | the same crate's `check_self_contained`, run by the generator *and* as a test |
| The wire a *call site* names is one some runtime answers | `just check-protocol` (`scripts/protocol-gate.mjs`) — rule 1 |
| Every advertised protocol has a caller | the same gate — rule 2 |
| The gate still catches each of those | `just protocol-check-selftest` — each rule injected into a fixture tree, which must fail with that rule named |

### The one thing two lists cannot see (the gate)

Everything above is about the contracts and the runtimes agreeing with each
other. None of it can see a **call site**.

`agent.env.resource` had a sender and no receiver for long enough that the
symptom was diagnosed as something else entirely: the Server's forced env write
asked the agent to re-source through a wire no agent has ever answered, so every
forced write reported a re-source failure and the running session kept its old
values (#913). Nothing failed. Nothing was refused. The reply simply never came,
because an unrecognised wire is ignored rather than rejected.

The route tables and the catalog cannot catch that — both are correct. What is
wrong is a string in a caller. So `just check-protocol` reads the call sites, in
both directions:

- **Every wire a call site names is one a runtime answers.** A name that is not
  a valid `ProtocolId` is reported as malformed; a name that is valid but
  advertised nowhere is reported as unanswered. Kept apart because the fixes
  differ: one is a spelling, the other is a wire that does not exist.
- **Every advertised protocol has a caller.** A unit nothing calls is a protocol
  this workspace maintains and cannot use.

The advertised set is not a list the gate keeps. It is read from the generated
bindings (which `just check-codegen` holds equal to the contracts) and from the
`pub const` declarations beside each dispatcher — the notification wires, which
no route table can describe because nothing answers them.

It used to be read from a third source as well: `<wire>.response` for every
wire, which the gate derived itself because that was the spelling every reply
carried. One wire per operation removed it — see *One wire per operation* above
— so the gate no longer derives anything, and a call site still naming the
suffix is reported like any other name nothing answers.

A name is **resolved**, not required to be a literal. `msg_types::AGENT_HEARTBEAT`
and an imported `WIRE as BRANCHES_WIRE` are both *better* than a literal — they
cannot drift from the contract — so a gate demanding literals would be asking
for the worse style. What gets reported is a name that resolves to nothing,
which is where a misspelling hides.

Two escape hatches, and both are printed on every run so an exemption cannot
spread unnoticed: `// not-protocol: <reason>` on a line, and
`// not-protocol-file: <reason>` in a file's header, for a file whose subject is
the transport and whose wires are deliberately arbitrary. An excused site is
still counted as a caller — it is excused from being checked, not from
existing, which is a distinction the gate first got wrong.

`just protocol-check-selftest` injects each rule into a fixture tree and
requires the gate to fail with that rule named. A gate that has quietly stopped
matching reports success, and success looks exactly like nothing being wrong.

### Why the manifest carries the wire projection

The Server relays `git.status` without knowing what `git` is. To gate that relay
it must answer "does this peer carry this message?", and the answer has to come
from the peer rather than from a transform the router applies to a string: a
transform is a rule the router would have to know, and knowing it would mean
knowing the provider. So the mapping is **declared** by the provider that owns
it and travels in the manifest.

Since `#912` the wire and the id are the same string for every unit in the tree,
so a derivational shortcut would happen to give the right answer today. It would
still be the wrong shape — the projection belongs to the contract, and a router
that computed it would be re-deriving a decision it does not own. The field is
what makes a transport rename the provider's business rather than the router's.

A manifest whose `wire` is absent — a peer predating the field — answers *no* to
every wire query. That is the safe direction: **has not said** is not **said
yes**, and the relay gate is skipped entirely for such a peer rather than
refusing on its silence.

### Where a target's support is served

`server.agent.list` carries each agent's manifest as `protocols`, `null` for a
peer the server holds no manifest for. It is served from the list rather than a
query of its own because that is already the discover-agents call — a consumer
resolving per target gets every manifest without a second round trip per agent.
The CLI's `agents list` reads the same field and prints `no manifest` rather
than `0 units` for such a peer, because those two resolve differently.

### What "derived" buys over "checked"

The design lists *provider advertises no handler* and *handler exists but not
advertised* as startup failures. Both are failures only while the advertised set
and the routed set are two lists. `ExtensionRegistry` builds its routing table
**from** the descriptors, so the two sets are one set and neither state is
constructible. That is a stronger guarantee than detecting either after the
fact — and it is why `AgentExtension` declares descriptors rather than the
`message_types()` it used to, which nothing tied to the provider's own dispatch.

The core units reached the same place by a different route. They have no object
to ask: the handlers are methods on `ServerClient`, reached by a `match` on the
wire type, and a `match` cannot be read to produce the set it handles. The
answer is `core_routes!`, one invocation that emits **both** the descriptor list
and the dispatcher:

```text
core_routes!(agent, msg, responses;
    "session.create" => "server.session.create" => { …the handler… }
    …
);
        ├── core_descriptors()   → the manifest
        └── dispatch_core()      → the message loop
```

The routing half is additionally exported as `CORE_WIRES`, a constant the
message loop tests before dispatching, so the notification match beside it keeps
handling only notifications. All three come from the one invocation, so a unit
cannot be advertised without a handler or handled without being advertised —
the same guarantee as the extensions, arrived at without a registry of boxed
futures and without disturbing what the handlers can reach.

Two things this deliberately does **not** do. The bodies are the arms that used
to sit in `handle_server_message`, moved verbatim: a table of function pointers
would have boxed every future for no gain in guarantee. And a wire type claimed
by both halves is refused at composition rather than resolved by whichever
dispatch runs first — `ExtensionRegistry::new` names the extension and the core
unit, because the loser of that collision would be advertised and never
reached.

## The three questions Phase 6 had to answer

Written down as open before the work started, because a guess would have been a
decision nobody recorded. Answered here, with what answered them — two of the
three turned out to be answerable by the code rather than by preference.

### Which direction does a manifest describe?

**Served only.** A manifest lists what the peer *answers*.

The manifest exists to answer one question — "may I send this peer this
message?" — and that question is about the receiver, never the sender. A peer
that sends `agent.register` is not thereby callable at `agent.register`; the one
that answers it is the server. Reading 2 (a direction field on
`ContractSupport`) and reading 3 (a set of units rather than of roles) would
both model something true and nothing asks for it: the relay gate needs the wire
projection, which `ContractSupport.wire` already carries.

The implementation made this concrete rather than a matter of taste.
`core_routes!` covers exactly the arms where the agent **answers** a server-sent
command. The two arms it left behind are replies to something the agent itself
sent — the server's acceptance of `server.agent.register`, and
`server.heartbeat.ack` — and advertising them would claim an offer that does not
exist. `server.agent.register` is a unit all the same: the **server** serves it,
and its own route table has the arm. The agent only reads the acceptance, under
the wire name it sent, which is one wire per operation working as intended. So
the agent's slice of Phase 6 is the units the agent serves, and the other three
units the phase names are served by the **server** — which composes a manifest of
its own, so all four are declared, two of them on each side:

| Phase 6 unit | Served by | Declared in |
|---|---|---|
| `session.create` | the agent for the server (`agent.session.create`) and the server for a browser (`server.session.create`) — two units, since `#912` gave each side the id its own handler earns | both manifests |
| `session.attach` | the **server** (`server.session.attach`) | the server's |
| `agent.register` | the **server** (`server.agent.register`) | the server's |
| `agent.heartbeat` | the **server** (`server.agent.heartbeat`) | the server's |

### Where does a core unit's descriptor live?

**The contract in `nession-protocol/src/contracts/`; the descriptor with the
implementer** — for the agent, `crates/nession-agent/src/protocol/mod.rs`.

The collision above is real, but only while "the contract" and "the declaration"
are treated as one artifact. They answer different questions. The contract asks
*what shape is this message*, and Nession owns it, because a router must be able
to read it without having heard of any agent. The descriptor asks *what does
this runtime offer, and what does it answer to*, and only the implementer knows
the wire string its own dispatch is keyed on — as `session.capture_preview`
shows, where the id and the wire are not derivable from each other.

That is also why the two rules agree rather than fight. "The crate that
implements a contract owns its declaration" is about the declaration; "no
concrete provider inside `nession-protocol`" is about the contract. A core unit
is an extension whose two halves live in different crates, and this is where a
version bump is written: the contract in `contracts/<family>/v2.rs`, adopted by
the descriptor the implementer composes. Today every core unit is one version on
one wire type — `v1_descriptor` says so and exists so that eleven units do not
each restate it — and a unit that needs a second version states it itself
rather than going through that helper.

### How does a core unit stay derived rather than listed?

**One macro invocation emits both halves**, so the guarantee holds without a
registry of boxed futures. Described under *What "derived" buys over "checked"*
above; the point here is only that option 1's guarantee was reachable without
option 1's blast radius, and that neither a behavioural test nor "do not
advertise core units yet" was needed.

### The Server is a provider too

For most of `#678`'s life it was not, in the only sense that mattered: it served
`agent.register`, `session.attach`, `env.*`, `commands.*` and the rest, and
declared none of them. Its dispatch was a `match` in `server/handler.rs`, and a
`match` cannot be read to produce the set it handles — the same problem the
agent's core units had, and the same answer.

`crates/nession-server/src/protocol/mod.rs` carries `server_routes!`, one
invocation emitting `server_descriptors()`, `SERVER_WIRES` and
`dispatch_server()`. Deliberately the same shape as the agent's `core_routes!`:
two mechanisms for one rule would be a second thing to keep in step, and the
hygiene workaround is identical — `self` cannot be captured by a `$body`, so the
dispatcher is a free function taking the handler and the bodies say `handler`
where they said `self`.

One difference is worth knowing, because it is not cosmetic. The agent's
dispatcher matches on `$msg.msg_type.as_str()`; this one clones the wire type
first. The agent's handlers *borrow* the message, so a borrow held across the
match is fine — these take it **by value**, and a borrow in the scrutinee would
conflict with every arm that moves it.

The ids are the **operations**, not the wire types, which is what lets one
contract have a provider on each side: `session.create` is served by this server
for a browser and by the agent for this server, both declare the same id, and
each declares its own wire projection in `ContractSupport.wire`. That is the
model working rather than a coincidence — a browser asking for a session and a
server asking for one are the same operation seen from two sides.

**Where it is read.** `server.info` carries it as `protocol_manifest` —
one field on the call a client already makes to ask what this server is, rather
than a message of its own. The Web already calls it (`platform/server/`), and
`ServerInfoResponse.protocol_manifest` is the contract.

### The agent answers on two sockets

An agent serves its own units over two transports — the connection it opens to
the central server, and the WebSocket it listens on for a browser to reach it
directly — and until now only the first was declared. `server/websocket.rs`
dispatched a second, larger `match` that no manifest described.

`p2p_routes!` is the second invocation, deliberately the same shape as
`core_routes!` and for the same reason: a `match` cannot be read to produce the
set it handles, so a hand-written list of peer-to-peer wires would be a second
list free to drift from the arms it claims to describe. Thirty-five payload
types moved into `contracts/` with it, including `FileEntry` and `FileData` —
the agent's filesystem model *was* the wire shape, exactly as `SessionInfo`
was — and four responses that were `json!({ … })` at the handler are now named
types. No `json!` remains on that path.

**One provider, so one list.** `main` unions `core_descriptors()` with
`p2p_descriptors()` and composes one registry from the result, because it is one
agent offering one set of units over two wires. `agent.session.create` is the
clearest case: the agent answers it on the connection it opens to the server and
on the socket a browser reaches it by, and it is one unit with one wire on both.
The manifest's `ProtocolManifest::from_descriptors` already unions wire sets by
id, so the union is what states that rather than a coincidence of ordering.

What it is *not* is `server.session.create`, which is a different unit. A browser
asking the Server to create a session and the Server asking the Agent to are
different protocols answering different questions — that distinction is
`protocol-identity.md`'s subject, and `#912` is where the tree came to agree
with it.

**One unit can share a wire name across transports.** `agent.session.capture-preview`
arrives from both halves — the server sends it to the agent, and a browser
connecting directly sends it too — and that is one unit, so both dispatchers
serving it is not a conflict. The registry's core-against-core check exists so
that two *units* cannot claim one wire, which would leave one of them advertised
and never dispatched; it compares units rather than wire types alone, because
the same unit arriving twice is both dispatchers serving it. The two payloads
differ only by the server's `request_id` correlation — framing, not contract
semantics.

**What remains here.** The server's own `json!` payloads, which are a larger and
separate ledger (276 uses in `server/handler.rs`). `#884` is no longer on it:
the five wires the kernel declared under two unit ids, one of them carrying two
payload shapes, were resolved by `#912` — every unit now has one id and one
wire, and the shape difference is gone with the duplicate unit.

**And what no longer does.** This section used to say that `contracts/` did not
feed the TypeScript codegen at all, so an advertised contract need not have
generated bindings — the codegen's coverage was not the guarantee it read as.
That was true until `#876` and is not any more: the catalog now carries the
kernel's units beside the providers', and
`every_advertised_contract_is_in_the_catalog` checks it against **all four
runtimes** — the agent's `served_descriptors`, the server's `server_manifest`,
and the two extension providers — instead of the two it used to compare. Both
runtimes are `dev`-dependencies of the generator, which is why nothing that ships
links it.

An advertised contract having bindings is now a checked property. Filing the
check as a test rather than a comment is the reason it stayed true.

### What is still not versioned

- **The global `protocol_version`.** Gone. It rode in `agent.register` and no
  consumer ever read it — not the server, the CLI, the Web, or the database —
  so it was the *shape* of a compatibility statement rather than one, and
  leaving it there was an invitation for the next reader to branch on it. What
  replaced it is the per-unit resolution above.

## Where a protocol's identity comes from

`#678` gave Protocol Units an `id` and left the naming to convention. What the
convention turned out to be — the sender — could not express which of two
handlers is answering, so five wires in this tree carried one name and two
different handlers (`#884`). The rule that replaced it, what it changed, and the
one boundary it has are in [`protocol-identity.md`](protocol-identity.md).

## The routing pipeline, as it actually runs

`handle_relayed_message` (`crates/nession-server/src/server/handler.rs`) is where
a browser's request reaches an agent, and it is the place a reader is most
likely to have been told the wrong thing. What it does, in order:

1. **Is this connection authenticated?** Checked *before the payload is read*,
   deliberately — everything below answers differently depending on the named
   agent, and an unauthenticated caller must not be able to tell a target that
   does not exist from one that exists but cannot carry the wire. Both are
   `contract_not_supported`, with different text. This step was missing until
   `#877`; the comment above it says so.
2. **Did the request name an agent?** No `agent_id` is `missing agent_id`.
3. **Does the target say it can carry this wire?** The target's advertised
   manifest is consulted. A target with **no** manifest is refused rather than
   relayed — registration already turns away an agent that advertises nothing,
   so reaching here means a straggler, and relaying to it would be guessing at a
   shape nobody declared. The refusal is *unit-scoped*: it answers the one
   request and leaves the connection alone.
4. **Relay.**

### There is no authorization step, and that is deliberate

There is no `authorize(principal, target, protocol)` relation in this pipeline,
and no `principal` at all — the Server's model is single-principal. `#879` asked
for that relation and is closed; the honest record is that its requirement was
**superseded rather than implemented**, because the product does not have
multiple principals to distinguish and the pipeline's job today is
authentication, not per-principal authorization.

Stated here rather than left implied, because the opposite was previously
implied: a reader looking for a `authorize` step that the docs described as
required would find nothing in the source and no statement about why. A
single-principal allow-all is a decision, and a decision that is not written
down reads as an omission.

When principals do exist, this is the seam: step 1 becomes "who is this", and the
relation belongs between steps 3 and 4, where the target and the unit are both
already resolved.

## Related

- `#678` — the requirement this document implements.
- `#565` — shared `nession-mcp`, which consumes the same contracts rather than
  copying Nession DTOs.
- [`docs/architecture/web.md`](web.md) — the Web layer model this mirrors on the
  client side.

Reached from the root `CLAUDE.md` crate tree, where `nession-protocol` sits, and
from that crate's own `lib.rs`. Deliberately **not** linked from
`docs/design/README.md`: that tree's rule is one canonical owner per concept, and
a wire protocol is not a product design concept — a link there would read as the
design tree owning this one.
