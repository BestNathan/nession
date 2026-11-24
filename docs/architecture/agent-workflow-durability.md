# Durable GitHub Actions Agent — execution protocol (RFC v1 + Workflow V2)

**Owner:** [#1664](https://github.com/BestNathan/nession/issues/1664), extended by
[#4482](https://github.com/BestNathan/nession/issues/4482)
**Scope:** Nession **GitHub Actions LLM Agent** workflow, not `crates/nession-agent` tmux/runtime.  
**Status:** The sections below record the v1 durable execution protocol. The
[Agent Workflow V2](#11-agent-workflow-v2--one-reconcile-owner) section describes
the implemented lifecycle/reconcile layer (#4482). Its real main-owned canary
(SC-06) remains **Pending** until the repository owner explicitly authorizes it;
this document is not acceptance evidence for that criterion.

## 1. Decision and implementation baseline

Nession's repository owner approved an **accepted-risk trusted-contributor phase** on 2026-10-18: the additional administrative Ruleset-read credential, standalone external/WORM anchor, and adversarial production-ref tampering proofs of [#1690](https://github.com/BestNathan/nession/issues/1690) are deferred from #1664's critical path. Existing live protections must not be turned off or forged as passing. This does **not** waive encrypted checkpoints, source authentication, Agent/Publisher credential separation, remote CAS, fencing, or real recovery proof. Do not claim a tamper-proof or exactly-once production Store.

**Executable baseline already present on main:**

| Owner | Present | Missing for a durable live Agent |
| --- | --- | --- |
| `store/checkpoint.mjs` | AES-256-GCM encrypted checkpoint contract, immutable path, head version | Runner-safe public-key sealing / trusted restore boundary and Provider-native archive adapter |
| `store/ingest.mjs` | Local source validation, sealed-byte constraints, idempotent local head update | Live authenticated remote `agent-store` fetch/commit/push + ref CAS and fencing |
| `orchestration/state-store.mjs` | Versioned Issue state/head, local expected-version CAS | Same remote write protocol as checkpoints; live Controller/Waker |
| `orchestration/outbox.mjs` | Deterministic Issue transitions, per-task action ID, dispatch acknowledgement | Durable per-Slice yield/continuation and verified completion reconciliation |
| `orchestration/github-dispatch.mjs` and `result-artifact.mjs` | Signed dispatch intent, Run binding, authenticated result ZIP parser | Live Controller → Worker → trusted Publisher/Ingester wiring |
| `providers/cursor.mjs` | SDK `Agent.create` with JSONL local store and sanitized events | `Agent.resume` and reliable snapshot/export of entire native store |
| `providers/claude-code.mjs` | One-shot `claude -p`, JSON usage normalization | Pinned native session ID, saved native session material and `--resume` |

`.github/workflows/agent-develop.yml` and `agent-review.yml` are referenced by source allowlists but **are not checked in yet**. This is a target-state contract, not a claim that they already run.

## 2. Authority and identity

```text
trusted event / authorized command
  -> Controller: Issue state + Outbox (decision authority)
  -> trusted dispatch ticket, persisted before dispatch
  -> unprivileged Agent Worker (one bounded Execution Slice)
       -> native Provider session restored/created
       -> sync live Issue, PR and capability state
       -> observe / edit isolated worktree
       -> native checkpoint at a safe boundary
       -> encrypted checkpoint proposal + sanitized result proposal
  -> trusted Result/Checkpoint Ingest
       -> verify actual GitHub Run/Attempt/Artifact and action binding
       -> remote expected-head CAS + fencing
       -> durable checkpoint/Run receipt; only then acknowledge yield
  -> Controller reconcile / next Slice or Reviewer
  -> trusted Publisher (separate authenticated PR / Issue effects)
  -> existing Quality, Acceptance and Metrics owners
```

* **Logical Agent key:** `(repository, role, agent_id, issue)`; persists across Actions Runs. A new GitHub Run never creates a new logical Agent identity.
* **Task ID:** stable logical Developer/Reviewer work assignment. **Action ID:** stable idempotent Outbox side-effect key. **Slice ID:** one execution attempt lineage under a Task. **Run/Attempt:** GitHub source of truth for execution. **Native Session ID:** Provider-owned and intentionally independent of `agent_id`.
* **SHA roles must never be conflated:** `controller_main_sha` identifies trusted code; `task_input_sha` is the source PR/base under inspection; `checkpoint_source_sha` records the workspace when the checkpoint was taken; `current_pr_head_sha` is freshly fetched before any new action; `published_head_sha` is authenticated by the Publisher. A historical checkpoint SHA is not automatically stale merely because the PR advanced.

No model output, Issue text, or Worker artifact may assign a new role, mark an SC Pass, approve/merge a PR, change a Store head, or mint Publisher credentials.

## 3. One state machine, two recovery layers

**A. Workflow layer (existing owner):** `workflows/issues/<issue>/states/<version>.json`, its `head.json`, and the Outbox represent deterministic authority: phase, assignment, unconsumed effects, retry policy and authenticated receipts. `advanceWorkflow` remains the sole issue phase transition owner. Do not add a parallel Slice FSM.

**B. Native session layer (Provider-owned bytes):** `roles/<role>/<agent_id>/issues/<issue>/checkpoints/<version>.json` stores only sealed Provider-native material, and its versioned `head.json` names the last **committed** checkpoint. Cursor and Claude must not be coerced into a home-grown shared transcript.

The two layers are committed through a **single trusted remote Git writer** using a ref-level compare/revalidate/push boundary. All immutable records and the new pointer set are staged in **one Git commit**. A process crash before the push leaves nothing committed; a crash after a successful push but before the Worker receives acknowledgement is recovered by querying the committed ref and adopting the matching receipt. Never assume local `fs.rename` is a remote transaction.

### Slice yield vs task completion

A **yield** means the Provider finished a demonstrably safe native persistence boundary, the checkpoint was committed, and the logical Task is still active. It does **not** imply `implementation_ready`, reviewer approval, or a new Issue phase. A separate verified **task completion** can enter existing `acceptTaskResult → advanceWorkflow`.

The existing Outbox v1 stores one dispatch receipt per action. It cannot simply reuse the same action with a second GitHub Run. Add a **versioned, backward-compatible per-Slice dispatch receipt/continuation record** under the existing Outbox owner; derive each new Slice action ID deterministically from the stable Task ID plus committed checkpoint version and Slice ordinal. Do not overwrite an earlier Run binding or invent a second state engine. Keep v1 already-stored records readable.

## 4. Store layout and remote write algorithm

```text
agent-store (orphan branch; independent from metrics/task-results/acceptance-results)
  workflows/issues/<issue>/states/<version>.json   # immutable
  workflows/issues/<issue>/head.json               # mutable CAS pointer
  workflows/issues/<issue>/results/<source>.json    # immutable authenticated receipts
  roles/<role>/<agent_id>/issues/<issue>/
    checkpoints/<version>.json                    # immutable ciphertext only
    runs/<run>-<attempt>.json                      # immutable sanitized provenance
    head.json                                     # mutable checkpoint CAS pointer
    lease.json                                    # mutable fenced ownership; trust-writer-only
    leases/<fencing-seq>.json                     # immutable lease/claim receipt
```

Create `agent-store` once via an authorized trusted-main bootstrap, preserving its initial commit SHA as the baseline. This phase does not require independent external/WORM anchoring, and must not be described as a forensic integrity guarantee.

A trusted writer operation receives authenticated `repository, workflow path, run_id, attempt, action_id, slice_id, role, agent_id, issue, target_sha, expected_ref_sha, expected_workflow_head, expected_checkpoint_head, fencing_token, record_digests`.

1. Fetch the **actual** remote `refs/heads/agent-store`; verify `expected_ref_sha` or re-read/reconcile. Reject unexpected ref reset or missing typed records.
2. Check immutable keys are absent or byte-identical. Verify ciphertext size/hash and only allowed pointer paths. Compare recorded Issue/Checkpoint versions and actual lease fencing/expiry against the requested preconditions.
3. Stage all immutable objects, run/ingest receipts, new Issue state (if changed), and pointer updates in a single linear Git commit.
4. Push **normally, never with force**. A concurrent writer invalidates the planned remote base: fetch again, re-authenticate the intent, re-check live versions/fence, and retry only a bounded number of times. A stale attempt cannot be automatically rebased over a competing pointer advance.
5. Verify remote head SHA and record an authenticated post-commit receipt. After a lost acknowledgement, adopt an identical existing object/receipt; reject divergent replay.

A local CAS self-test is insufficient: a real two-writer Git remote race must prove exactly one wins a conflicting expected version while non-conflicting immutable writes can be retried safely.

### Lease and fencing

The Controller claims `(role, agent_id, issue)` with a monotonically increasing **fencing generation** and bounded expiry, committed with remote ref CAS. A renewed claim preserves or explicitly increments authority under a documented rule; an expired or superseded claim cannot publish checkpoint, PR, Issue comments, or final task results. The trusted writer validates **both** current generation and time window; an expired owner is rejected even if no successor has arrived. Worker-provided timestamps are not authority. `concurrency.group` only reduces collisions.

## 5. Native Provider Adapter contract

Adopt a small common interface; the adapters keep different native representations:

```ts
create(preparedHarness, workspace): NativeHandle
restore(sealedNativeBytes, expectedSessionId, preparedHarness, workspace): NativeHandle
execute(handle, reconciledIssueAndPrContext, boundedBudget): NativeOutcome
snapshot(handle): NativeSnapshot // only after a verified Provider-safe turn boundary
close(handle): void

NativeSnapshot = {
  provider, native_session_id, provider_version, native_format_version,
  native_store_bytes, verified_safe_boundary
}
```

**Cursor first.** The SDK documents local `JsonlLocalAgentStore` (agent/run/event/checkpoint files) and `Agent.resume(agentId, { store, ... })`. Restore **the complete native store**, not merely `agentId` or a single JSONL line. Supply the same store to `resume`; reapply tool allowlists, custom tools, MCP and sandbox options, which are not all persisted by the SDK. Audit the effective Harness after restore. Prove two different GitHub Runs consume a context marker without prompting the model with the previous marker again.

**Claude Code second.** Use a version-pinned CLI supporting a named/specific session `--session-id` followed by `--resume <id>`, and inspect its real native on-disk session dependencies using a dedicated sandbox/home. Package only the demonstrated required native files, not an unbounded `~/.claude` copy. Reject symlinks/traversal/foreign projects, unsupported CLI versions, missing session files and `--continue` fallback. Restore must use the same `session_id`, with the *current* restricted tool/permission policy independently applied. A Qwen backend behind Claude CLI is not a separate Harness family.

A genuine native resume may fail on a changed provider format, digest or revoked capability. The correct result is **blocked/incompatible** with an evidence receipt and explicit owner migration path — never a silently new session reported as resumed.

## 6. Protect private native sessions in a public repo

The existing `sealCheckpoint(..., key)` API is appropriate for a **trusted** process, but must not put its 32-byte secret into the model executor. The live Worker path therefore needs a **versioned envelope encryption adapter** or equivalently isolated trusted sealer:

* Worker has an encryption **public key only** and seals the native store **before** uploading any artifact or Git object. The trusted ingest accepts a bounded ciphertext proposal and checks the authenticated source; no plaintext appears in Git, uploaded artifacts, cache or logs.
* A trusted-main restore bootstrap has access to the decryption authority **outside the untrusted Provider process/container**. It decrypts the native store into a short-lived workspace volume, clears the key/environment, then runs the restricted Provider with no privileged GitHub writer, token, admin key, or private decryption key mounted or inherited.
* Same-runner, separate shell steps without sandboxing **are not a security boundary against hostile code**. If effective process/filesystem isolation cannot be shown, do not advertise that property or enable arbitrary shell/model-written executable code.
* Checkpoint format must bind `role/agent_id/issue/version/provider/session_id/harness_digest/source_sha` as authenticated metadata, and include a key/format version for rotation and migration. Keep existing v1 fixture compatibility with a trusted-only adapter; do not expose AES keys to model tooling.
* A normal GitHub result artifact can contain sanitized result metadata or already encrypted data; never a raw session archive.

## 7. Safe shutdown, recovery and external effects

A Worker is **one bounded Slice**, not the Agent's lifetime owner. Set a time/turn/tool budget and reserve time for safe Provider completion, encryption, remote write and post-commit acknowledgement. Do **not** kill an in-flight turn to fabricate a checkpoint. Unexpected timeout/cancel/crash rolls back to the last committed compatible checkpoint and may lose the current Slice's uncommitted changes.

On wake/restart: verify ticket and actual GitHub Run/Attempt; read authoritative Store state, head and lease; restore the Provider session; **reread live Issue body/comments, source branch/PR head, current loaded Tools/Skills/MCP/Plugin inventory and pending Publisher/Outbox receipts**; resolve ambiguous side effects before calling `execute`. The Issue cursor's last consumed comment ID/digests advances **only in the committed checkpoint**, not when comments are merely fetched.

All external effects go through the existing Outbox's **durable Intent → verified external effect → durable Receipt**. Before replaying after a crash between PR/comment publication and receipt persistence, query deterministic branch/PR/comment identity and adopt the *previous* verified effect. If multiple candidates or wrong SHA are found, block rather than publishing again. Worker never directly merges or self-approves.

Reconciler polls completed/cancelled/failed Runs, expired leases, pending Outbox, ambiguous GitHub dispatch (including HTTP 204 without Run ID), conflicting checkpoint commits and exhausted retries. It can re-wake eligible work **eventually**, never with a sub-hour delivery SLA.

## 8. Delivery order — vertical slices

| Slice | Change owner | Real deliverable / proof |
| --- | --- | --- |
| **D1. Provider-native resume spike** | `providers/*`, Harness self-tests | Real two-run Cursor resume of same session via a **disposable ciphertext-only cross-Run Artifact handoff** (authenticated Run/Attempt/Artifact ID+digest, bounded retention, trusted isolated restore); current capability reapplication and incompatible digest negative. Claude native file/session discovery and separate resume proof. No Publisher and **not a durable long-lived Store claim**. |
| **D2. Live encrypted Store** | `store/*`, trusted Store Ingest | Real `agent-store` orphan ref, encryption-before-artifact, trusted restore, remote CAS and fenced stale-worker rejection; no external WORM dependency. |
| **D3. Bounded Worker & Controller** | `orchestration/*`, thin Workflows | Issue Outbox continuation/yield receipts, trusted Dispatch → Worker → Ingest, missed/duplicate Run replay, periodic recovery, no duplicate result ingestion. |
| **D4. Trusted Publisher and Issue handoff** | `publisher/*`, `issue-thread.mjs` | Exact-SHA scratch patch application, deterministic PR/comment intent/receipt, Reviewer changes-requested then *same* Developer resumes and consumes Issue updates. |
| **D5. Controlled full-chain fixture** | `e2e/acceptance/cases/1664/*`, existing Acceptance/Metrics | Separate fixture Issue/PR, real two-run native resume, Reviewer/repair, exact SHA Quality/eligible Acceptance, cancelled-post-publication dedupe and source-aligned telemetry. |

### Operator activation of the synthetic D1 workflow

The first main push after merging the D1 workflow demonstrated **skipped**, not
successful, Seed/Verify runs when the public-key variable is absent. This is
intentional fail-closed behavior and is not acceptance evidence.

An authorized repository operator can provision the extra D1 **fixture** RSA
keypair locally using an authenticated GitHub CLI, without writing a private key
to a file or pasting it into a GitHub Issue:

```sh
node scripts/lib/agent/providers/cursor-resume-setup.mjs --apply
```

The script stores `CURSOR_RESUME_PRIVATE_KEY_B64` in the `cursor` GitHub
Environment secret scope and `CURSOR_RESUME_PUBLIC_KEY_B64` in Repository
Actions Variables, in that order. This is separate from the owner-deferred
#1690 administrative Ruleset / external-anchor requirements. It only protects
sensitive native conversation bytes while transferring between GitHub Runs.
Operators must have GitHub settings permissions and a valid `gh auth` session;
the Agent workflow or model must not execute this script. A subsequent main
`workflow_dispatch` for `Agent / Cursor Resume Seed` performs the real
verification. Two successful, independently authenticated Run IDs and a
matching source Artifact checksum are required before D1 can be marked passed.

D1 intentionally comes **before** real orphan Store activation: it uses a disposable encrypted fixture Artifact transferred between two distinct authenticated Runs, not a plaintext Artifact or the final `agent-store` ref. Authenticate the producer and exact digest before restore; expiration must fail visibly. D2 replaces the fixture transport with the versioned remote Store. This keeps the native-resume discovery exercise independent of ref-rollout work without weakening ciphertext-only policy.

Workflows that **invoke models** use `agent-*` and emit existing canonical telemetry. Trusted deterministic Controller/Store/Publisher operations belong to the existing Acceptance/Task execution boundary, **not** a second `Agent /` model-running workflow. Add new workflow paths/display names to all authoritative allowlists and workflow-conventions Gates before enabling dispatch. Workflow changes receive their own direct-to-main PR per `.github/AGENTS.md`.

## 9. Required adversarial proof matrix

| Fault injection | Expected observable result |
| --- | --- |
| Two Workers try the same checkpoint head / stale fence | One commit, stale writer denied, no parallel head corruption |
| Controller dies after dispatch API 204 / ambiguous response | No fabricated Run ID; reconcile original Run before bounded retry |
| Worker dies before ciphertext commit | No new valid head; restart from previous committed session |
| Writer commits but acknowledgement is lost | Verified existing Git SHA/receipt is adopted; no second checkpoint |
| PR created, process dies before Outbox receipt | Resolve PR by trusted task/branch/PR identity; no duplicate PR |
| Issue comment edited/deleted after last cursor | Fail or explicitly resync; never silently ignore change |
| Harness digest / loaded tool policy changes | Incompatible resume blocked or explicit migration, never fallback |
| GitHub PR HEAD changes while worker is running | Recheck and reject stale patch / result before publication |
| Run/Attempt or ZIP digest spoofed | Trusted ingest rejects; parent SC remains Pending |
| Provider hangs past budget | No invented checkpoint, bounded retry from last committed state |
| Plaintext or writer key appears in artifact | Negative privacy gate rejects and no Store write |

Every positive **and** negative result must identify actual source Run/Attempt, exact SHA, digest/Store ref, and assertion. Fixture-only tests and smoke of a different Issue are not parent acceptance proof.

## 10. Existing SC alignment / non-goals

* **#1664 SC-01/02:** real Registry/Environment and privilege-isolation negative evidence.
* **SC-03/04/05:** deterministic dispatch, replay, Issue synchronization, trusted side-effect receipts.
* **SC-06/07:** real remote encrypted `agent-store`, version/CAS/fencing, two-run compatible native resume, no duplicate PR mutation.
* **SC-10/13/15:** real loaded capabilities and truthful provider telemetry + existing Metrics Ingest authentication.
* **SC-17:** source-aligned independent end-to-end fixture. Completed child #1690 fixture SC-10 is **not** this proof.
* **SC-08/09/11/12/14/16/18:** already accepted; preserve their contracts and avoid duplicating owners.

**Out of scope:** perfect replay of an interrupted individual LLM/tool call, exactly-once external network APIs, automatic merge, tamper-proof Git against owners with full write permissions, new message bus/state machine, and Rust tmux Agent lifecycle.

## 11. Agent Workflow V2 — one Reconcile owner

[#4482](https://github.com/BestNathan/nession/issues/4482) evolves the durable
Agent workflow into one Issue-centric lifecycle coordinated by one Reconcile
entrypoint. The executable owner is the `scripts/lib/agent/workflow/` subtree;
the v1 orchestration modules remain the compatibility path for immutable
`schema_version: 1` history.

| Owner | Responsibility |
| --- | --- |
| `workflow/contract.mjs` | versioned v2 state/identity, phases, execution states, deterministic Thread/action/evidence IDs, strict validation |
| `workflow/lifecycle.mjs` | **sole** business transition decision owner (`decideLifecycle`); execution-state transitions and owner fencing |
| `workflow/ci-barrier.mjs` | freezes the applicable check obligation for the exact PR HEAD and classifies terminal results |
| `workflow/feedback.mjs` | one immutable deduped repair bundle per HEAD + CI generation + Review result |
| `workflow/migration.mjs` | explicit, readback-based v1 → v2 projection; unknown legacy state becomes a durable blocker |
| `workflow/reconcile.mjs` | bounded observe → decide → CAS persist → scoped effect → readback → receipt loop |
| `workflow/telemetry.mjs` | sanitized Reconcile observation projection (no prompts/native bytes/credentials) |
| `orchestration/transition.mjs` | `advanceWorkflowV1` compatibility replay only; it rejects a v2 state |

### 11.1 Lifecycle and execution state

Business phases: `authorized → developing → publishing → ci_checking →
reviewing → evaluating → accepting → waiting_merge → post_merge_acceptance →
done`, plus durable `blocked` and authorized `cancelled`. Each phase has a
verified entry/exit; `evaluating`/`accepting` may return to `developing` for a
single repair round. A new execution attempt or repair never creates a new
logical Thread.

Execution states are separate from business phases:
`pending → dispatching → dispatched → claimed → executing → result_available →
committed/retired`, with `yielded`, `failed`, `cancelled` and `ambiguous`.
`committed`/`retired` actions may be pruned from the live Outbox because the
immutable Store versions retain the receipt history. A GitHub Run being
queued/in_progress/completed is only an observation; it is never an accepted
result or business completion.

### 11.2 Ordering: CI before Review

After the trusted Publisher confirms the exact PR HEAD, the lifecycle enters
`ci_checking` **before** any Reviewer action. The CI barrier freezes the
applicable required-check set for that HEAD:

* pending → wait;
* missing/cancelled/unknown/skipped-required → not a pass; bounded recovery
  then a durable block;
* source-owned failure → `actionable_fail`, but Review still runs;
* infrastructure-only failure → recover/block, never blame source code;
* every required check terminal-success → `pass`.

Reviewer then runs as an **internal lifecycle action**, not a GitHub Check,
required check context or branch-protection requirement. It receives the Issue
and SC snapshot, exact PR diff/base/head, the verified CI summary and bounded
failure evidence. A Reviewer runtime/invalid result is retried or blocked; it is
never treated as `changes_requested`. Ordinary non-managed PRs never trigger an
Agent Reviewer.

`evaluating` aggregates the two independent outcomes deterministically:

| CI | Review | Decision |
| --- | --- | --- |
| pass | approved | proceed to existing Acceptance |
| actionable_fail | approved | one Developer repair with CI feedback |
| pass | changes_requested | one Developer repair with Review feedback |
| actionable_fail | changes_requested | one Developer repair with the combined, deduped bundle |
| unresolved/missing evidence | any | recover or block, never an invented pass |
| any | Reviewer runtime/invalid | retry Reviewer or block, not Developer repair |

The repair action is created only after the bundle digest is fixed for the exact
`(Issue, PR, HEAD, CI digest, Review digest, repair ordinal)`. A Reviewer verdict
can never override CI failure, and a rerun that materially changes CI evidence
invalidates the old aggregate/review before a new decision is bound.

### 11.3 Wakes, persistence and recovery

Three equivalent wake sources — authenticated GitHub events/completion hints, a
GitHub schedule, and an explicitly authorized external/manual dispatch — all
produce the same bounded `reconcileOnce` decision path. A wake may hint at
Issues and carry a reason; it cannot start an arbitrary open Issue, select a
role, approve a result or authorize merge/SC/Store writes. New lifecycles start
only from the verified owner-authorized command/admission path.

State and receipts stay in the existing `agent-store` versioned Issue state;
there is no second database or state engine. Every decision is persisted with
expected-version CAS and deterministic action IDs before any external effect.
External dispatch/publication uses write-ahead intent → external call →
authenticated readback → receipt. A lost response is resolved by readback; a
second POST/PR is never sent blindly. Ambiguous effects, stale fences, stale
HEAD/evidence generations and duplicate/out-of-order results are rejected or
idempotently replayed; retry budgets (infrastructure, model, repair rounds) are
bounded and exhaustion produces an explicit owner-recovery blocker.

V1 immutable history is preserved. A v1 state is migrated by an explicit
projection that records its source version/digest; a state that cannot be
projected safely (for example a post-Developer phase without a trusted PR
readback) becomes a durable `blocked` diagnostic. The legacy engine remains the
live production path until the V2 canary is separately authorized; a v2 state
is never driven by the legacy engine, and a v1 state is never accepted by the
V2 decision owner.

### 11.4 Rollout boundary

The #4482 PR-stage criteria (SC-01..SC-05, SC-07) are proven by deterministic
exact-source fixtures in `scripts/lib/agent/workflow/*-selftest.mjs` and the
`agent-provider-contract` Gate. The trusted-main read-only entrypoint is
`node scripts/reconcile-agent-workflows.mjs --plan` (bounded Store read, PR/CI
observation and a sanitized plan); it refuses `--apply`. SC-06 requires a real
owner-authorized
trusted-main canary through the existing controlled Agent/Store path,
independently authenticated Run/Attempt/Artifact and Store receipts; it remains
Pending until the owner authorizes that execution. No production canary, merge
authorization or self-approval is inferred from this document or from fixtures.

### References

* Current local contracts: `scripts/lib/agent/workflow/*.mjs`, `scripts/lib/agent/store/{checkpoint,ingest}.mjs`, `orchestration/{outbox,state-store,transition,github-dispatch,result-artifact,issue-thread}.mjs`, `providers/{cursor,claude-code}.mjs`.
* Cursor SDK TypeScript: https://cursor.com/docs/sdk/typescript (local Jsonl store and `Agent.resume`; configuration must be supplied again on resume).
* Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage (specified-session `--resume`).
* [#1690](https://github.com/BestNathan/nession/issues/1690) retains deferred security-hardening requirements, without their Pending status being rewritten as Pass.
