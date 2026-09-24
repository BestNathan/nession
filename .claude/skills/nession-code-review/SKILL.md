---
name: nession-code-review
description: Use when reviewing Nession code, a PR, a completed implementation, protocol/runtime changes, concurrency changes, reconnect/lifecycle behavior, or when the user asks to “review 一下”, “再检查一下”, “实现完了看看”, “看还有没有问题”. Focuses on correctness invariants, ownership, resource scope, concurrency/backpressure, protocol semantics, tests-as-proof, and issue lifecycle. Do NOT use this as an implementation workflow; if fixes are requested, hand off to nession-development after the review.
---

# Nession Code Review

This skill is for **implementation review**, especially post-implementation review where a PR or issue claims to be complete.

The goal is not to find style nits. The goal is to answer:

> **Does the implementation actually preserve the system invariants under real lifecycle, concurrency, reconnect, slow-consumer, and multi-client conditions?**

A green test suite and a convincing PR description are evidence, not proof.

---

# 1. Related skills and hand-offs

Use this skill as the review coordinator. Do not duplicate workflows owned elsewhere.

| Situation | Skill / workflow |
|---|---|
| Review implementation / PR / current main | **this skill** |
| Review finds a bug or unmet requirement that must be tracked | `nession-writing-requirements` |
| User asks to fix / implement the findings | `nession-development` |
| Release / staging → main / deployment questions | `nession-cicd` |
| UI / interaction implementation review needs design-system rules | `nession-web-design` |
| Bug mechanism is not yet confirmed | follow systematic-debugging phases before claiming Root Cause |

Hard rule:

```text
review
  -> findings
     -> issue lifecycle via nession-writing-requirements
        -> implementation via nession-development
           -> release via nession-cicd
```

Do not silently jump from review to code changes.

---

# 2. Review modes

Classify the review first.

## A. PR review

The target is a specific PR/diff.

Review:
- changed files;
- surrounding implementation that establishes the changed code's assumptions;
- linked issue / success criteria;
- tests added by the PR;
- recent related commits when lifecycle behavior spans multiple PRs.

## B. Post-implementation review

The user says the work is “done”, “implemented”, or asks to review the current repository after a series of PRs.

This mode is stricter.

Do **not** review PRs independently. Reconstruct the final state on the target branch and verify that the original requirement/invariant is actually closed.

Typical question:

```text
Issue said X must be true.
Several PRs landed.
Is X now actually true in current main/staging?
```

## C. Architecture/runtime review

The target is not one bug but a subsystem:
- Agent ↔ Server protocol runtime;
- WebSocket dispatch;
- scheduler / lane / actor design;
- reconnect ownership;
- protocol unit composition;
- terminal relay;
- sandbox/runtime lifecycle.

Start from invariants and ownership, not function length.

---

# 3. Establish the exact review baseline

Before reasoning about correctness, determine what code is actually being reviewed.

Collect:

1. current target branch / commit SHA;
2. relevant PR(s);
3. linked issue(s);
4. current issue state and acceptance criteria;
5. changed files;
6. nearby code that owns the state or resource;
7. relevant architecture documents.

For protocol/runtime work, normally inspect:

- `VISION.md`
- `PRINCIPLE.md`
- `docs/architecture/protocol.md`
- relevant `docs/design/*`
- the Protocol Unit declarations / route tables
- the transport reader/writer
- the state registries / broker / resource owner

Never assume the PR description matches the merged code.

Hard rule:

> **Review current code as source of truth; use PR text to understand intent, not to establish fact.**

---

# 4. Reconstruct the invariant before reading details

A useful review starts with one or more invariants.

Examples:

### Connection ownership

```text
For logical Agent A:
only the active connection generation may publish current Agent state.
```

### Command correlation

```text
request/reply correlation comes from envelope id,
not response arrival order.
```

### Mutation ordering

```text
operations that mutate the same logical resource must have deterministic order,
independent resources may execute concurrently.
```

### Backpressure

```text
slow consumers must not turn producer throughput into unbounded memory growth.
```

### Protocol authority

```text
connection identity established by registration/authentication
is authoritative over payload-claimed identity.
```

### Runtime ownership

```text
the scope that serializes mutations must be at least as wide
as the scope that owns the mutable resource.
```

Write the invariant in one sentence before judging implementation details.

If the invariant cannot be stated, the architecture boundary is probably still unclear.

---

# 5. Trace the full data path

Never stop at the function where a symptom appears.

Trace end-to-end:

```text
sender
  -> transport frame
  -> envelope decode
  -> routing / execution policy
  -> handler
  -> shared state / backend
  -> response / event
  -> outbound queue
  -> writer
  -> peer
```

For reconnect/lifecycle issues also trace:

```text
accept
  -> register/auth
  -> active operation
  -> reconnect/replacement
  -> stale message
  -> disconnect cleanup
  -> liveness sweep
  -> re-claim/recovery
```

For each step ask:
- who owns the state?
- who is allowed to mutate it?
- what identifies the owner?
- what happens if an old task/connection finishes late?
- what survives transport replacement?
- what is deleted on disconnect / timeout?
- is the delete itself generation-safe?

A bug frequently lives one layer outside the code that originally failed.

---

# 6. Concurrency review checklist

Concurrency review is not “does this use tokio::spawn”.

Review the following dimensions separately.

## 6.1 Reader responsiveness

Does a transport reader directly await long business work?

Bad shape:

```text
read.next()
  -> slow_handler.await
  -> next read
```

Check whether slow work blocks:
- heartbeat;
- close;
- auth/control;
- independent queries;
- terminal input/resize;
- reconnect detection.

## 6.2 Task creation bound

Ask two separate questions:

```text
Is work bounded per message?
Is work bounded per distinct resource?
```

A per-key queue does **not** imply a global bound.

Example:

```text
depth = 8 per key
100000 unique keys
=> potentially 100000 workers
```

When reviewing keyed executors, inspect:
- per-key queue depth;
- number of live keys;
- worker budget;
- global query concurrency;
- detached task ownership.

## 6.3 Queue/backpressure bound

Search for:
- `unbounded_channel`;
- unbounded Vec/HashMap accumulation;
- producer loops with no admission control;
- slow socket writer paths.

Classify every outbound class:

| Message class | Typical policy |
|---|---|
| command/reply | non-droppable, bounded wait/fail |
| heartbeat | latest/coalescible |
| terminal resize | latest per session |
| terminal output | bounded; slow-consumer verdict |
| pointer/mouse motion | may coalesce |
| keyboard/paste/IME bytes | ordered, must not silently drop |

Never accept “bounded handler concurrency” as proof of bounded memory if the outbound path is still unbounded.

## 6.4 Lock-across-await

Inspect every shared lock around backend I/O.

Prefer:

```text
lock map
 -> clone Arc<resource handle>
 -> unlock map
 -> await backend operation
```

Avoid:

```text
lock global map
 -> await tmux/file/network
```

Also check less obvious ownership locks:
- broker maps;
- pending request maps;
- subscriber maps;
- session maps;
- registry writes.

## 6.5 Ordering scope vs resource scope

This is a critical Nession rule.

Ask:

> **Where is the scheduler instance created, and where is the mutable resource created?**

If:

```text
scheduler = per connection
resource = shared across all connections
```

then same-key FIFO only exists inside one connection.

That is not resource serialization.

For Agent P2P especially compare:
- per-WebSocket `ExecutionLanes`;
- shared `SessionManager`;
- shared `FileOps`.

## 6.6 Multi-resource / hierarchical mutations

A `ResourceKey` model can be correct mechanically and wrong semantically.

Look for operations that touch more than one resource:

```text
rename(from, to)
move(src, dst)
recursive delete(parent)
session migration
cross-agent transfer
```

Examples:

```text
rename A -> B
write B
```

and:

```text
delete dir/ recursive
write dir/x
```

Exact-path single-key scheduling does not serialize these automatically.

Choose explicitly between:
- multi-key acquisition with canonical ordering;
- hierarchical locking;
- deliberately coarse mutation lane.

Do not invent fine-grained concurrency unless it is needed.

## 6.7 Cancellation and shutdown

Every spawned task needs an owner.

Review:
- what aborts it;
- whether it can outlive its connection;
- whether dropping a task drops queued work;
- whether a task can still mutate shared state after the peer is gone;
- whether shutdown waits forever because a task owns a sender;
- whether cancellation happens while holding a resource lock.

A task that cannot answer its peer may still have side effects. Decide whether aborting it is safe.

## 6.8 Single-writer ownership

For a WebSocket, prefer one task owning the sink.

Check that:
- business handlers do not race writes;
- ping/close/control are not starved by a saturated business queue;
- byte/frame budget is released after the actual socket handoff, not merely dequeue.

---

# 7. Lifecycle / reconnect review

Distributed connection bugs often look correct until an old connection is still alive.

Always test the four-event sequence:

```text
c1 owns A
c2 reconnects and takes A
c1 sends a late message
c1 disconnects
```

Then add liveness eviction:

```text
c1 = g1
c2 = g2
sweeper evicts A
old g1 speaks again
```

Review these independently:

## 7.1 Identity

What Agent/client is this connection bound to?

Payload identity must not override established connection identity.

## 7.2 Current authority

A connection can be correctly bound to Agent A and still be **stale**.

Therefore:

```text
bound identity != current authority
```

For current-state writes, validate both.

## 7.3 Generation high-water mark

If “newest generation wins”, ask where that ordering is stored after:
- sender removal;
- timeout/liveness eviction;
- disconnect;
- registry cleanup.

Deleting the whole ownership record can recreate ABA:

```text
g2 existed
record removed
g1 arrives
map says None
g1 becomes owner again
```

High-water generation and active sender are different concepts.

## 7.4 Re-registration on one socket

Registration/authentication should normally be a state transition, not a rebind.

Review:

```text
Unregistered -> Agent(A)
Agent(A) + register(B) -> ?
```

If re-registration is allowed, verify old ownership is explicitly released.

If it is not a product feature, reject it.

## 7.5 Pending work semantics

Transport ownership and logical request ownership may differ.

Example:
- a superseded Agent connection should not publish current heartbeat/session state;
- but it may be valid for it to finish an already in-flight command response if the pending command belongs to the logical Agent.

Do not apply one generation rule blindly to every message category.

---

# 8. Protocol review

For changes touching `nession-protocol`, Protocol Units, manifests, relay, or extensions:

## 8.1 Contract vs runtime policy

Keep separate:

```text
consumer-visible contract
  !=
provider/runtime execution policy
```

Scheduling policy should not force a protocol version bump unless consumers actually observe a contract change.

## 8.2 Unit declaration completeness

A served unit should not be able to exist without:
- descriptor / manifest declaration;
- handler;
- runtime execution policy where applicable.

Look for fallback policies such as “unknown extension => Query”.

A fallback may be safe today and become a correctness trap when a future provider adds mutations.

## 8.3 Correlation and ordering

If replies carry request IDs, completion order is not a semantic requirement.

Do not preserve global serial execution merely to preserve reply order.

## 8.4 Control vs operation

Control messages and Protocol Unit operations often need different execution semantics.

Examples:
- auth/register/mode transition: ordered/connection-local;
- query: bounded parallel;
- mutation: keyed;
- close/ping: transport control;
- terminal stream: stream semantics, not ordinary RPC.

---

# 9. Review tests as proofs, not decorations

Do not ask only “are there tests?”

Ask:

> **What exact claim does this test prove? Can it pass while the real invariant is still broken?**

## 9.1 Test the negative half

If the claim is:

```text
new connection owns A
```

test both:

```text
new connection receives command
old connection does NOT receive command
```

For state ownership also test:

```text
old connection cannot mutate current registry/session state
```

Routing ownership is not state ownership.

## 9.2 Deterministic race tests

Do not rely on sleep and probability when a barrier is available.

Use:
- an acknowledged protocol message;
- a channel/semaphore;
- a brokered round-trip;
- explicit task gates.

A deterministic race test should prove the ordering point before the assertion.

## 9.3 False-positive review

Look for tests that prove the wrong layer.

Example:

```text
old connection sends heartbeat
old connection sends register as barrier
command still routes to new connection
```

This proves broker routing ownership.

It does **not** prove the old register/heartbeat failed to mutate registry state before the broker claim was rejected.

## 9.4 RED evidence / mutation testing

When feasible, temporarily remove or bypass the fix and ensure the intended regression test fails.

Useful forms:
- disable generation comparison;
- restore old substring classification;
- restore unbounded spawn;
- remove pending cleanup;
- change resource key deliberately.

A test that never turns red against the broken behavior is weak evidence.

## 9.5 Scope tests

For concurrency, test all relevant scopes:

```text
same key / same connection
different key / same connection
same key / different connection
many unique keys
slow outbound consumer
disconnect with work in flight
```

---

# 10. Compare implementation against the original issue

For post-implementation review, build a small acceptance matrix.

Example:

| Requirement | Implementation evidence | Status |
|---|---|---|
| same-resource FIFO | KeyedLane | partial if only per connection |
| bounded concurrency | Query semaphore | partial if unique-key workers unbounded |
| bounded outbound | bounded reply queue | partial if another outbox remains unbounded |
| reconnect ownership | generation compare | partial if eviction loses high-water mark |

Do not close a requirement because “most stages landed”.

A requirement is complete only when its **stated invariant and success criteria** are true in the final repository state.

---

# 11. Severity model

Use severity to order fixes, not to dramatize.

## P0 — correctness invariant violation

Examples:
- stale connection can become owner again;
- wrong Agent/session state can be mutated;
- data loss;
- cross-identity state write;
- reconnect destroys active ownership;
- protocol mode transition races.

## P1 — boundedness / resource-scope / concurrency correctness

Examples:
- unbounded unique-key workers;
- per-connection scheduler protecting a runtime-global resource;
- slow consumer can grow memory unbounded;
- rename/delete race due incomplete key model;
- mutation extension routed as Query.

## P2 — maintainability / observability / incomplete hardening

Examples:
- oversized handler after boundaries are already correct;
- metrics exporter absent while logs exist;
- duplicated policy vocabulary that is not yet causing divergence.

Do not call function length a correctness bug by itself.

---

# 12. Evidence discipline

Every review finding must be one of:

### Verified fact

Supported by current code / diff / deterministic test.

Write:
- exact file;
- line/range when available;
- concrete execution sequence.

### Hypothesis

Mechanism not yet fully proven.

Mark it explicitly as:
- `unverified`;
- what evidence supports it;
- what single experiment would confirm/refute it.

Never put an unverified claim under “Root Cause”.

---

# 13. Issue lifecycle after review

When the user asks to record/fix findings, use `nession-writing-requirements`.

Before creating anything:
- scan **all open issues**, not only one label;
- inspect relevant closed issues;
- dedupe by invariant, not keyword.

Decision table:

| Review result | Action |
|---|---|
| Existing issue's same invariant / acceptance criterion is still unmet | **reopen existing issue**, add post-implementation investigation comment |
| Same symptom, different confirmed root cause | create a new Bug and reference the old issue |
| New independent behavior/design decision | create a new Requirement |
| Existing open issue already covers it | comment/cross-reference there; do not duplicate |
| Follow-up is already tracked | link it from the parent review issue |

When reopening, explain **why the previous implementation was only partial**.

Good shape:

```text
original invariant
  -> what the implementation fixed
  -> what remains false
  -> deterministic sequence proving it
  -> additional acceptance tests
```

Do not rewrite history by pretending the first fix did nothing.

---

# 14. Recommended fix ordering after a runtime review

When multiple issues are found, prefer this dependency order:

```text
1. ownership / identity / lifecycle correctness
2. local protocol-control correctness
3. characterization + deterministic regression tests
4. bounded outbound / backpressure
5. parallelize read-only queries
6. keyed mutation ordering
7. widen scheduler scope to actual resource ownership
8. refine resource-key semantics / multi-resource operations
9. converge abstractions only after 2+ runtimes prove the same shape
10. observability / metrics
```

Why:

- increasing concurrency before ownership is correct amplifies races;
- increasing producer throughput before backpressure amplifies memory risk;
- abstracting before semantics are proven creates a framework around guesses.

Do not begin with a generic “unified scheduler framework”.

---

# 15. Nession-specific high-value review heuristics

These are recurring failure patterns worth checking explicitly.

## “Identity is bound, therefore authority is safe” — false

A stale connection can still be correctly identified as Agent A.

Current-state writes also need current ownership/generation.

## “Per-key queue is bounded, therefore concurrency is bounded” — false

Unique-key cardinality may still create unbounded workers.

## “Same key is FIFO, therefore resource is serialized” — only if scope matches

A per-connection KeyedLane cannot serialize a resource shared across connections.

## “One operation has one key” — often false for filesystems

Rename/move/recursive delete touch overlapping resources.

## “Green reconnect test proves lifecycle correctness” — maybe not

A test can prove command routing while stale registry writes still occur.

## “Delete ownership on timeout so it can recover” — can reintroduce ABA

Preserve generation high-water separately from active sender/liveness.

## “Terminal input is high frequency so latest-wins is okay” — false

Mouse motion may be coalescible; keyboard/paste/IME bytes are ordered data.

## “Large async function is the problem” — usually false

The useful boundary is:

```text
Protocol Unit / Operation
  + Execution Policy
  + Resource Ownership
  + Handler
```

Split after semantics are known.

---

# 16. Review output format

Prefer findings first.

## Summary

State:
- target branch / commit / PR;
- whether the implementation direction should be retained or reconsidered;
- whether linked issues are truly complete.

## Findings

Order by severity.

For each finding:

```markdown
### P0/P1/P2 — concise invariant violation

**Verified**
- file:line
- concrete state transition / interleaving

**Why it matters**
- user/runtime impact

**Fix direction**
- desired invariant, not merely a patch

**Test**
- deterministic regression scenario
```

## What is already correct

Explicitly name good mechanisms that should not be rewritten.

This prevents a review from accidentally turning into “replace everything”.

## Issue actions

If the user asked for repository maintenance, report:
- reopened issues;
- comments added;
- new issues;
- deduped existing follow-ups;
- lifecycle/status changes.

---

# 17. Review stop conditions

A review is not complete if any of these are still unknown for the changed subsystem:

- who owns mutable state;
- which connection/task is authorized to write it;
- what survives reconnect;
- what is bounded;
- what orders mutations;
- whether ordering scope matches resource scope;
- how slow consumers behave;
- how in-flight tasks end;
- what tests prove the negative/race path;
- whether the original issue's success criteria are actually true.

If one is intentionally unresolved, record it as an explicit follow-up rather than silently treating the implementation as complete.

---

# 18. Quick workflow

```text
Identify target commit/PR/issues
        |
        v
Read architecture + changed code + resource owner
        |
        v
State invariants
        |
        v
Trace sender -> transport -> router -> handler -> state -> outbound
        |
        v
Review lifecycle + concurrency + scope + backpressure
        |
        v
Review tests as proofs / search for false positives
        |
        v
Compare final state with issue success criteria
        |
        +--> same invariant incomplete -> reopen + comment
        |
        +--> independent bug -> dedupe -> Bug issue
        |
        +--> new behavior decision -> dedupe -> Requirement issue
        |
        v
If user wants fixes -> nession-development
```

The review should leave the repository with a clearer set of invariants and a smaller, better-scoped issue graph than it started with.
