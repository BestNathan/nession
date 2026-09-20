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

**Convergence debt — the blanket relay is still what runs.** Today a target with
no manifest has *everything* relayed to it, which is the unconditional fallback
this section forbids. Recorded here rather than left to be rediscovered:

- **Why it is still that way.** Every agent built before `#854` has no manifest,
  so refusing them would take the extension surface down for the whole fleet to
  enforce a rule about a case that has not happened yet. A peer that *has* a
  manifest is checked strictly, and that is where the mechanism is proven.
- **What would end it.** Manifests are universal once `#854` has been deployed
  long enough that no live agent predates it. The change is then a second
  condition in the relay gate — "no manifest *and* no declared adapter" — and a
  `legacy_wire` field on `ContractDescriptor` for providers to populate.
- **What will not work.** The Server cannot decide this on its own: it composes
  no provider, by design, so it cannot know which contracts declare an adapter.
  The declaration has to travel — in the descriptor, carried to the relay by
  whatever composes the provider.

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
web/src/generated/protocol/<owner>/<unit>/v<N>.ts
```

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
- **There is no `index.ts`.** The first version had one and `tsc` refused it —
  every unit exports `PROTOCOL`, `WIRE` and `VERSION`, so a barrel is a wall of
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
| A router can name a protocol without knowing any provider | `ContractSupport.wire` — the projection is declared by the provider, not derived by the router |
| A target is never asked for a wire type it does not carry | the Server's extension relay, gated on the target's manifest |
| A peer without a manifest still works | the same gate, skipped when there is no manifest — a Legacy Peer, not a peer that said no |
| A consumer resolves per target, not per connection | `ProtocolDirectory` is keyed by agent id and replaced wholesale by each agent-list snapshot |
| A consumer never sends a version it cannot read | `addressedPayload` refuses locally — the server's gate cannot catch this case, because a caller that names nothing is relayed as a Legacy Peer |
| Every path that learns an agent list publishes it | `AgentsPlugin.listAgents` and the `agents.changed` push, both calling one `publishProtocols` |
| The agent list carries the same fields on every path | `server/agent_view.rs` — one builder, because the two hand-built ones had already drifted |
| Generated bindings are what the contracts say | `just check-codegen` (`scripts/check-codegen-drift.sh`) — regenerate into a scratch directory, diff |
| Every advertised contract has generated bindings | `nession-protocol-codegen`'s `every_advertised_contract_is_in_the_catalog`, against the providers' own `descriptors()` |
| A generated file refers to nothing it does not declare | the same crate's `check_self_contained`, run by the generator *and* as a test |

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
command. The two arms it left behind — `agent.register.response` and
`server.heartbeat.ack` — are replies to something the agent itself sent, and
advertising them would claim an offer that does not exist. So the agent's slice
of Phase 6 is the units the agent serves, and the other three units the phase
names are served by the **server**, where no manifest exists yet:

| Phase 6 unit | Served by | In the agent's manifest |
|---|---|---|
| `session.create` | the agent (`server.session.create`) | yes |
| `session.attach` | the **server** (`client.session.attach`) | no — waits for a server manifest |
| `agent.register` | the **server** | no — same |
| `agent.heartbeat` | the **server** | no — same |

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

### What is still not versioned

Stated rather than implied, because a reader who finds an unadvertised protocol
should know whether it was overlooked.

- **The server's units.** `agent.register`, `agent.heartbeat` and
  `client.session.attach` are served by `nession-server`, which composes no
  manifest at all. Under *served only* they belong in one. Nothing consumes a
  server manifest today, so building one now would be architecture for its own
  sake — but it is the next real increment of Phase 6, and it is the reason
  three of the phase's four named units are not in the table above.
- **The P2P path.** `server/websocket.rs` dispatches a second, larger match —
  `client.session.list`, `terminal.input`, `client.attach`, `file.read` — that
  the browser speaks to an agent directly. Those *are* served by the agent and
  do belong in its manifest, but not yet: their payloads are `json!` literals
  with no typed contract in `contracts/`, and the catalog requires every
  advertised contract to have generated bindings. The units come after their
  contracts, not before.

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
