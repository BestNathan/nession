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

## 3. Where `extension.*` does not fit — the open question

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

### The `extension.` wire prefix is a separate question

The id and the wire are already allowed to differ, so `extension.git.status` as a
*wire* is legal today. But it is load-bearing in a way worth naming:

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

### What is not decided

Three questions this document deliberately leaves open, because each is a design
choice rather than a consequence of the rule:

1. **Does the wire prefix survive at all?** Either `extension.` stays as an
   explicit relay marker and the server keeps routing on it, or the server
   resolves every message by manifest and the prefix goes.
2. **If it goes, what replaces it?** `git.status` as a wire, matching the id — or
   something that still marks the relay path without naming a capability's host.
3. **What does `owner` mean when a capability runs in two hosts at once?** Today
   it is a crate name and there is one host per deployment. `#565` is the change
   that tests it.

---

## 4. Status

| | |
|---|---|
| The rule | decided, above |
| The core-unit rename | decided, not started — breaking, accepted |
| `client.agents.list` on the agent | delete, not rename |
| The agent's two session-list wires | **measure first**: same handler and subject, so the contract decides |
| `extension.*` | open — section 3 |

Reached from `docs/architecture/protocol.md`, which owns the Protocol Unit model
this refines.
