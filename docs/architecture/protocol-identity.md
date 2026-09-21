# Protocol identity: `<handler>.<subject>.<operation>`

A Protocol Unit's id names **the component that owns the semantics of the
answer**, **what the question is about**, and **the operation**. All three are
part of the identity, and so is the contract shape that answers it.

```text
server.session.list      the server owns this answer; it is about the fleet
agent.session.list       one agent owns this answer; it is about that agent
agent.file.read          an agent owns it; it is about a file on that agent
```

This document fixes the rule and records what it changes. It is the reason
`#884` and the naming migration behind it exist; `#678` is the model this rule
refines, and where the two disagree this document is the later decision.

---

## 1. The rule

### The prefix names the handler

Not the sender. The current tree names wires by **who sends them**, and that
convention is consistent — it just cannot express the cases that matter:

```text
agent.register           sent BY the agent          (the server handles it)
server.session.create    sent BY the server         (the agent handles it)
client.session.create    sent BY the client         (the server handles it)
```

Every one holds, and the convention still under-specifies `client.*`: a browser
talking to the server and a browser talking to an agent directly are both "sent
by a client", so the prefix cannot tell them apart. That is precisely the
ambiguity behind `#884`, where five wires carry one name and two different
handlers.

Naming the handler resolves it, because the handler is what actually differs:

| boundary | id |
|---|---|
| web → server, create a session | `server.session.create` |
| web → agent, create a session | `agent.session.create` |
| server → agent, create a session | `agent.session.create` |

The first and third differ; the second and third agree — correctly, because the
agent answers either way.

### The subject names what the question is about

`server.session.list` is about **the fleet**. `agent.session.list` is about
**one agent**. Those are different protocols even though both "list sessions",
because the meaning of the answer differs: one is a registry's view, the other
is that machine's live truth.

### A parameter narrows a protocol; it does not create one

Asking the server for one agent's sessions is **still `server.session.list`**,
with an `agent_id` filter. The Web choosing between "ask the server, filtered"
and "ask the agent directly" is choosing between two protocols with different
*guarantees* — a cached registry view versus a live read — not between one
protocol and a refinement of it.

### The contract decides the last question

Two requests with the same handler and the same subject are **one protocol only
if the contract is the same**. Where the shapes differ, the ids must separate
even though the prefix and the subject match. This is measurable, and it should
be measured rather than argued: compare the structs, and let that settle it.

---

## 2. What this changes in the tree

Everything that ships today is named by the sender convention. The migration is
therefore breaking, and that was accepted deliberately: the alternative is a
naming scheme that cannot say which of two handlers is answering.

The renames, by handler:

**The server answers → `server.*`** — every unit in `server_routes!`:
`agent.register` → `server.agent.register`, `client.session.create` →
`server.session.create`, `client.env.list` → `server.env.list`,
`client.server.info` → `server.info`, `client.commands.*` → `server.commands.*`.

**An agent answers → `agent.*`** — the agent's `core_routes!` and `p2p_routes!`
alike: `server.session.create` → `agent.session.create`, `server.sessions.list`
→ `agent.session.list`, `session.list` → `agent.session.list`, `file.read` →
`agent.file.read`, `terminal.input` → `agent.terminal.input`.

### What it says about `#678`'s union-by-id

`ProtocolManifest::from_descriptors` unions wire sets by id, added so that a unit
served on two transports keeps both. That is right **when the contract is one**,
and wrong the moment two boundaries carry different shapes — it then asserts a
single protocol where the payloads say there are two.

The rule above does not repeal the union; it gives it its precondition. Union two
descriptors only after the subject and the contract agree.

### One deletion, not a rename

`client.agents.list` on the agent's own socket answered a **fleet** question with
`vec![itself]`. The browser's agent list would render "1 agent" while the server
knew about N — a wrong number presented as a right one, which is worse than a
missing handler (the client would have shown "not supported").

The scenario was real: `AgentsPlugin` is installed per `WebSocketService`, and in
P2P mode that service points at an agent, so the plugin asked a registry's
question down a socket that cannot answer it. The fix is the client knowing which
socket it is on, not the agent inventing an answer.

**A compatibility shim that answers a question the provider cannot answer is
worse than no handler.** It reads as working.

---

## 3. Where `extension.*` did not fit — the reasoning, and how it resolved

`extension.git.status` breaks the rule in a way the rule cannot fix by renaming.

### The handler is not stable for a capability

Under `<handler>.<subject>.<operation>`, `extension.git.status` should become
`agent.git.status` — the agent's `ExtensionRegistry` is what dispatches it.

But `git` is **a capability, not an agent feature**. `#565` is about hosting
`nession-git` and `nession-claude-code` standalone and inside an MCP host. If the
same capability can run in three places, naming the protocol after today's host
bakes a deployment detail into an identity that is supposed to outlive it.

The descriptor already carries both halves — `id = "git.status"`,
`owner = "nession-git"` — which is the right shape: **the id names the capability,
the owner names who owns its semantics, and the runtime hosting it is recorded
elsewhere** (the manifest's `provider`, the registry's routes).

So the rule needs its own boundary stated:

> **The prefix names the component that owns the semantics.** For a core unit
> that is the runtime, because the runtime *is* the implementation. For an
> extension unit it is the capability, because the capability is what gets
> composed and the runtime hosting it is a deployment detail.

That reading leaves `git.status` correct as an id and makes `agent.git.status`
wrong — the opposite of what applying the rule mechanically would produce.

### The `extension.` wire prefix was a separate question

The id and the wire are separately modelled, which is what made
`extension.git.status` legal as a *wire* even though it is not an id. But it was
load-bearing in a way worth naming:

```rust
// crates/nession-server/src/server/handler.rs
if msg.msg_type.starts_with("extension.") {
    return self.handle_extension_message(msg).await;
}
```

The server routes by prefix. That is a transport fact standing in for a
routing decision — and `#678`'s own direction is that a generic relay resolves
by **manifest**, not by a name it has to recognise. The prefix also cannot
survive the rule above: once an extension can be hosted anywhere, `extension.`
says nothing about who answers.

### How it resolved

Three questions this document left open, because each is a design choice rather
than a consequence of the rule. `#912` answered the first two by taking the rule
seriously:

1. **Does the wire prefix survive at all?** It does not. The prefix only ever
   bought the server one branch — deciding whether to consult the manifest it
   already held — and the registry stripped it again on arrival. Deleted.
2. **What replaces it?** `git.status` as a wire, matching the id. Routing is now
   "is this wire in my manifest, or does it name a target?" rather than "does
   this string start with `extension.`".
3. **What does `owner` mean when a capability runs in two hosts at once?** Still
   open, and still `#565`'s to answer. It is also the reason the `id`/`owner`
   split is worth keeping even though the wire and the id are now one string:
   the id names the capability, the owner names who owns its semantics, and the
   runtime hosting it stays a deployment fact.

---

## 4. Status

**All of it landed in `#912`** (on `staging` as `8944f68a`, released to `main`
in `#878`). The table records what each row resolved to, because two of them
were decided by measuring rather than by applying the rule:

| | |
|---|---|
| The rule | decided, above |
| The core-unit rename | **done** — every wire names its handler, and the wire is the id |
| `client.agents.list` on the agent | **deleted**, not renamed: the Server answers `server.agent.list`, and the agent's 6-field variant that carried a different payload shape went with it |
| The agent's two session-list wires | **measured, then split** — `agent.session.report` (the registry's five-field answer, `width`/`height` dropped) and `agent.session.list` (the full `SessionInfo`). Same handler and subject, different contract, so two protocols |
| `extension.*` | **removed**, not renamed — see section 3 |

Section 3 is kept as the reasoning that produced the second row of that rule
(the capability, not the host, owns a provider unit's prefix). It is no longer
an open question; the namespace it asks about was deleted rather than renamed.

Reached from `docs/architecture/protocol.md`, which owns the Protocol Unit model
this refines.
