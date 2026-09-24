# Protocol Versioning Closure (#963) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `#678`'s Protocol Unit model actually close its loop from contract → composition → manifest → resolution → dispatch → generated bindings → gates, so a Unit can serve two Contract Versions at once and no consumer can bypass version negotiation.

**Architecture:** The wire locates the Unit; `contract_version` selects the generation. So two versions of one Unit legitimately share one canonical wire (which `#912` already made equal to the Unit id), and the descriptor's "one wire, one version" refusal — whose stated rationale was "the transport cannot tell which contract arrived" — dissolves because `contract_version` now tells it. Dispatch becomes `wire → {version → handler}`; the manifest keeps advertising one Unit with `versions: [1,2]`; codegen, the gate and the local hooks converge on the same identity `(unit, version)`.

**Tech Stack:** Rust (workspace of 9 crates), TypeScript/React (Vite + Vitest), Node scripts (protocol gate, design gate), GitHub Actions.

**Issue:** [#963](https://github.com/BestNathan/nession/issues/963)

---

## Part 0 — Verified current state

Every claim below was read off `main` at `a3d83988`, not inferred from the issue. Where the issue's premise is imprecise, that is stated — the issue is a design document and three of its five "verified gaps" are partly already closed.

### Gap 1 — descriptor/dispatch are single-version routing (CONFIRMED, and the core of the work)

**Confirmed.** `crates/nession-protocol/src/kernel/descriptor.rs:103-128`:

- `ProtocolDescriptor::validate()` refuses two Contract Versions that share a wire, as `DescriptorError::DuplicateWireType` (`:117-124`).
- Its stated rationale (`:100-102`) is *"the transport could not tell which contract an incoming message was for, so the version on the wire would be decided by luck"* — which is exactly what a `contract_version` field removes.
- `DuplicateVersion` (same version twice) is a genuine invariant and stays.

**The existing test bakes in the anti-pattern the issue forbids.** `descriptor.rs:156-166`
(`accepts_one_contract_per_version`) uses wires `["extension.git.status"]` and
`["extension.git.status.v2"]`. That is both the retired `extension.` namespace and the
"encode v2 in the wire" trick that issue Non-Goal 6 forbids. It must be rewritten against a
*shared* wire.

**Manifest already tolerates multi-version**, and its union-by-id is the right shape once the
wire is shared: `manifest.rs:104-144` unions `versions` and `wire` per id;
`a_unit_offered_at_two_versions_keeps_both` (`:334-364`) passes today — but it passes *because*
its two contracts use different wires (`extension.git.status` / `extension.git.status.v2`).
With the wire shared, its `assert_eq!(support.wire.len(), 2)` becomes `1` and the test needs
rewriting to assert the version list instead.

**ContractSupport carries `versions` and `wire` as two parallel flat lists**
(`manifest.rs:27-43`). For a shared wire this is adequate — `wire: ["git.status"]`,
`versions: [1,2]`. It is *not* adequate if v1 and v2 ever travel on different wires. Decision:
keep the flat shape, and let a Unit's wire set stay the union across its versions (documented
as such). Revisit only if a real Unit needs per-version wires.

**`unit_for_wire` silently picks a winner** (`manifest.rs:176-181`): a linear scan returning the
first Unit that carries a wire. Two *Units* claiming one wire is therefore not detected — the
issue's "不同 Protocol Unit 争用同一个 operation wire 仍然是 composition error" has
**no check today**. `ProtocolDescriptor::validate()` only looks inside one descriptor (one Unit),
so it structurally cannot catch this.

**Runtime dispatch — mapped, and it found a live bug (see Stage 0).** Four places spell
`wire → (version, handler)`:

| # | Site | What must change |
|---|---|---|
| 1 | `crates/nession-agent/src/extension.rs:37-43,50,169-188` | `Route { version }` is a single value under a wire-only key; a second claim of one wire is a hard `RegistryError::DuplicateWireType`. Becomes a per-wire version map. |
| 2 | `crates/nession-protocol/src/kernel/descriptor.rs:103-128` | the cross-version wire refusal (Task 1.1) |
| 3 | `server_routes!` / `core_routes!` / `p2p_routes!` (`crates/nession-server/src/protocol/mod.rs:70-136`, `crates/nession-agent/src/protocol/mod.rs:97-155,216-285`) and their invocations (`handler.rs:7104`, `server_client.rs:3262`, `websocket.rs:939`) | arms are `$id => $wire => $policy => $body` with the version hardcoded to `V1` by each crate's `v1_descriptor`. Needs a version slot, or an `$id` that resolves to several descriptors. The emitted `*_WIRES` sets and `dispatch_*` matches must survive one wire appearing twice. |
| 4 | `crates/nession-server/src/server/handler.rs:2235-2263` + `manifest.rs::unit_for_wire` | selection is by membership only; `unit_for_wire` returns an id and never a version. |

Everything *above* these points already expects versions to be plural per Unit —
`ContractSupport.versions`, `from_descriptors`' union+sort+dedup, `select_version`, `resolve`,
`refusalMessage`, the policy column, and the manifest-required-at-registration gate.

### Gap 2 — the Legacy Peer bypass (CONFIRMED on the Web; the Server half needs care)

**Web: confirmed, and precisely located.** `web/src/platform/protocol/resolve.ts`:

- `Resolution` has four variants including `{ kind: 'legacy' }` (`:33-37`).
- It is constructed at exactly one place — the falsy check at `:70-72` collapses both
  `null` and `undefined` manifest into `legacy`.
- `legacy` is read in exactly two places, both in this file: `refusalMessage` returns `null`
  for it (`:98-101`), and `addressedPayload`'s else-branch (`:150-152`) sends the payload
  **with no `contract_version` key at all**. That else-branch is the entire bypass.
- `ProtocolDirectory.manifestFor` (`directory.ts:52-74`) returns `null` for **both** "this
  target was never heard of" and "this target advertised nothing". The class doc calls the
  collapse deliberate. The requirement needs these two told apart.
- **There is no readiness concept anywhere** — no `ready`, no promise, no loading state.
  `manifestFor` is synchronous and total. The only thing preventing a race is ordering
  discipline in `AgentsPlugin.listAgents` (`AgentsPlugin.ts:104-111`), which publishes
  protocols *before* its awaiters resume, pinned by a test.
- `WebSocketService.protocols` is **never cleared on disconnect**, though
  `platform/socket/types.ts:44-46` claims it is emptied with the connection. A doc/code
  discrepancy worth fixing in passing.

**Blast radius of removing the bypass:** the only production callers of `addressedPayload` are
`GitPlugin` (6 methods) and `ClaudeCodePlugin` (2 methods). Every *other* capability
(`files`, `env`, `commands`, `session`, `terminal`, server, agent) sends **unversioned payloads
without going through `addressedPayload` at all** — ~50 call sites across ~13 non-test files.

Tests that currently pin "legacy succeeds" and will need rewriting:
`resolve.test.ts:62`, `:84`, `:121`; `directory.test.ts:16`;
`capabilities/git/__tests__/integration/consumerResolution.test.ts:81`, `:107`;
`capabilities/git/__tests__/unit/GitPlugin.test.ts:143`.

**Server: the issue's framing needs a decision.** The relay currently validates a target's
support *only when the request carries* `contract_version`; absence relays. `docs/architecture/protocol.md:472-476`
documents this on purpose: *"Naming no version is not a refusal."* The issue reverses that
("Server/Agent boundary 不得接受…完全没有 resolved version 信息却继续 dispatch").

⚠ **A literal reading breaks the whole application.** Every `agent.file.*`, `agent.env.*`,
`agent.session.*`, `agent.terminal.*` call is unversioned, and all of those Units *are* in the
target's manifest. So "refuse an unversioned request for a manifest-backed Unit" refuses
essentially all traffic. Resolving this is Stage 3's first task and is **an owner decision**:
either (a) migrate every first-party caller to send `contract_version` and then refuse, or
(b) scope the refusal to Units where the consumer actually negotiated. The issue's own Open
Question 5 leans (a)-lite: *"本需求至少要保证当前真正参与 manifest resolution 的 consumer
不再自行实现互相矛盾的 fallback."* Recommend (b) for this issue and file the universal
migration as its own requirement — but **ask before choosing**, because (a) is a
repository-wide change.

### Gap 3 — codegen (PARTLY ALREADY CLOSED; the real defect is narrower and concrete)

The issue's premise ("codegen identity must be `(Unit, Version)`, same id v1/v2 must both
generate") is **largely already true**:

- `catalog::Unit` already carries `version: u32` (`catalog.rs:71-117`).
- `unit_path` already emits `v{version}.ts` (`lib.rs:151-155`), and `check_paths_are_unique`
  keys on the full path (`lib.rs:130-144`) — so two versions of one Unit do **not** collide.

The **actual** defects are elsewhere, and one is a silent data-loss bug:

⚠ **`schema.rs::document()` keys `protocols` by `unit.id` alone** (`schema.rs:41-46`), and
`entry()` writes `version` as a scalar. A second version of the same Unit **overwrites the
first in the JSON Schema document** — nothing fails, one contract simply disappears from the
artefact. This is the concrete "not version-aware" defect.

- `schema.rs`'s `only` filter also matches on id alone (`:37-40`), so
  `just protocol-schema git.status` is ambiguous once v1 and v2 coexist.
- `tests.rs::declared()` unions wires per id (`:32-72`) and `advertised()` returns ids
  (`:74-77`). `every_advertised_contract_is_in_the_catalog` (`:79-93`) compares catalog ids to
  advertised ids — with two versions of one id the catalog side yields `["git.status","git.status"]`
  and the test **fails**. So the completeness tests are id-keyed and must become `(id, version)`-keyed.

**On "contract-derived rather than a hand mapping":** providers already gate `ts-rs` + `schemars`
behind a `codegen` feature (`crates/nession-git/Cargo.toml`), and `catalog.rs` names concrete
provider types (`decl_of::<nession_git::protocol::status::v1::StatusRequestV1>`), so the
association is compile-checked *by type name* today. What is genuinely hand-written is the
**semantic** mapping: which type is the request vs the response, and which types a Unit's file
carries. The kernel's `ContractDescriptor` (`descriptor.rs:36-51`) carries only `version` and
`wire` — no type identity — which is why the catalog has to restate it.

### Gap 4 — gate semantics (CONFIRMED, and the gate is already disciplined)

`scripts/protocol-gate.mjs` implements rules 1a/1b/2/3/4/5, resolves const names rather than
requiring literals (`declaredWireConsts`, `:255-272`), and reports exemptions every run
(`:769-771`). `scripts/protocol-gate-selftest.sh` injects a violation per rule *and* a paired
counter-example. The remaining work is the issue's own list — category/direction/ownership
invariants and trust levels between a generated `WIRE` import, a declared `pub const`, and a
hand-written computed expression — with the explicit constraint *"不要把正则扫描继续无限扩成
parser"*: if a rule needs an AST to be reliable, switch the input rather than the regex.

### Gap 5 — local gate convergence (CONFIRMED, small)

`.githooks/pre-commit` runs `just check-protocol` (on `.rs`/`web/src/` diffs) and
`just protocol-check-selftest` (on `scripts/protocol-gate` diffs). It does **not** run
`just check-codegen`. `.githooks/pre-push` runs neither `check-protocol` nor `check-codegen` —
its routing is Rust / Web / Design only. So a protocol or generated-binding drift that
pre-commit missed can only be caught by CI.

### Gap 6 — documentation (CONFIRMED, with one reversal)

`docs/architecture/protocol.md` is already converged on "there is no Legacy Peer"
(`:423-426`) — it is the **Web code that is behind the document**, not the reverse.
The one place the document states behaviour the issue reverses is `:472-476`
("Naming no version is not a refusal"), which is the same decision as Gap 2's ⚠.
Also to sync: `docs/architecture/protocol-identity.md` (§4, the wire *is* the id),
`crates/nession-protocol/src/lib.rs`, and the Web resolver/directory comments.

---

## Part 1 — Staged delivery

Six stages, each independently shippable to `staging`, ordered by dependency. Every stage is a
worktree off `origin/main` (or `origin/staging` when it depends on unreleased code), a PR to
`staging`, `--auto --merge`, and full local gates before push.

| Stage | Scope | Depends on | Issue goals |
|---|---|---|---|
| **0** | **Fix the stale `extension.` dispatch gate (live bug found during recon)** | — | prerequisite for 1 |
| 1 | Kernel: multi-version descriptor, composition, dispatch | 0 | 1, 2 |
| 2 | Web: remove the legacy success path | — | 3, 7 (Web half) |
| 3 | Server/Agent boundary refusal | 2 (**owner decision first**) | 3, 7 |
| 4 | Codegen: version-aware schema + `(id, version)` completeness | 1 | 4 |
| 5 | Gate semantics + pre-push convergence | 1, 4 | 5, 6 |
| 6 | Documentation convergence | 1–5 | 7 |

⚠ **Stage 3 carries an open owner decision** (Gap 2's ⚠). Stages 0, 1, 2, 4, 5, 6 do not.

---

## Stage 0 — the agent drops every extension wire on the relay (live defect)

**Found by recon; unrelated to the issue's own list, but on Stage 1's critical path and a
shipping bug in its own right.**

`crates/nession-agent/src/connection/server_client.rs:832`:

```rust
// Try extension dispatch first
if msg.msg_type.starts_with("extension.") {
```

This is the **only** production `extension.` check left in the Rust tree. Everything else
matches the bare wire:

- `crates/nession-git/src/protocol/status/v1.rs:16` — `pub const WIRE: &str = "git.status";`
- `crates/nession-git/src/agent.rs:299-306` — `handle_command` matches on `protocol::status::ID`.
- `crates/nession-agent/src/extension.rs:50` — `routes: HashMap<String, Route>` keyed by the bare wire.
- `crates/nession-server/src/server/command_broker.rs:237-245` — the relay forwards `msg_type` **verbatim**.

**History:** the guard was added by #116 (`55a56166`, the `extension.*` namespace's
introduction). `d5e75793` — *"the wire is the protocol id — the extension namespace is gone"*
(#912) — deleted the prefix from every wire and **missed this one**.

**Consequence:** a relayed `git.status` / `claude-code.read` fails the prefix test, fails
`CORE_WIRES`, and is swallowed by the control match's `_ => {}` at `:903`. No error is logged
and no reply is sent, so the server's `agent_command` times out after 10s. Both first-party
extensions have been unreachable over the relay since #912. `dispatch_p2p` has no extension
fallback either, so P2P cannot serve them.

**Why nothing caught it:** `ExtensionRegistry::dispatch` is called in production at exactly one
place — inside this guard — while `extension.rs:480-486` tests `dispatch` *directly*, bypassing
the gate. Every e2e git spec is a `fixture-*` spec, and the fixture fakes the transport. No Rust
test calls `handle_server_message` at all.

### Task 0.1 — Reach the registry on the wire the registry is keyed by

**Files:** Modify `crates/nession-agent/src/connection/server_client.rs:830-867`; test in the
same file's test module (`mod tests` at `:996`).

**The fix is a deletion, not a rewrite.** `ExtensionRegistry::dispatch` already returns
`Option` — `None` for a wire it has no route for — and `routes` is built from `extensions`
only: the `core` half is collision-checked at `extension.rs:206-248` but **never inserted**
into `routes`. So the prefix test is pure redundancy *and* wrong, and the correct change is to
call `dispatch` unconditionally and let its `Option` be the gate.

Do **not** add a `handles()` method, and do not widen the string test to `"git."`/`"claude-code."`
— either re-creates the same defect (a second copy of a rule the routes own).

- [x] **Step 1: Write the failing test.** `a_relayed_extension_wire_reaches_its_handler` — a
      mock server pushes `git.status`; the client's registry composes an extension declaring
      that wire; asserts one `server.agent.command-response` arrives. Plus the paired
      counter-test `a_wire_no_extension_declared_is_not_dispatched`, so the fix cannot degrade
      into a catch-all.
- [ ] **Step 2: Run and confirm the failure is "no response frame", not a compile error.**
      `./scripts/filtered-test.sh --lib -- a_relayed_extension_wire a_wire_no_extension`
- [ ] **Step 3: Delete the prefix condition** at `:832`, inverting the nesting so the registry
      is consulted whenever one is configured.
- [ ] **Step 4: Run both tests plus the crate suite.** `just test-unit`, then
      `cargo test -p nession-agent`
- [ ] **Step 5: Commit**, naming the regression's origin (#912 removed the prefix from the
      wires and left this gate behind).

**Note:** this fix is a *prerequisite* for Stage 1's end-to-end verification — Stage 1's
success criteria include dispatching one canonical wire to a version-specific handler, and that
path runs through this gate.


---

## Part 2 — Stage 1: kernel multi-version (task outline)

*Exact signatures for Tasks 1.4–1.7 are pending the runtime-dispatch recon; they are written
against "one wire binds one version" and are the only part of this plan not yet final.*

### Task 1.1 — Let two versions of one Unit share a wire

**Files:** Modify `crates/nession-protocol/src/kernel/descriptor.rs:94-134`.

- [ ] Write the failing test first: one Unit, `v1` and `v2`, **both** declaring wire
      `["git.status"]`, `validate()` must be `Ok`.
- [ ] Run it; expect `Err(DuplicateWireType)`.
- [ ] Remove the cross-version wire check from `validate()`, keeping `DuplicateVersion`.
      Rewrite the doc comment: the ambiguity it guarded is now resolved by
      `contract_version`, and the *cross-Unit* wire conflict it was reaching for belongs to
      composition, not to one descriptor.
- [ ] Rewrite `accepts_one_contract_per_version` (`:156-166`) to use the **shared** wire and
      to drop the retired `extension.` prefix and the forbidden `.v2` suffix.
- [ ] Keep `refuses_one_wire_type_serving_two_versions` (`:184-195`) **only if** it is
      restated as a cross-Unit case; otherwise delete it, because within one Unit it is now
      legal. Deleting a test whose invariant moved is correct; deleting one whose invariant
      vanished silently is not — say which in the commit message.
- [ ] Commit.

### Task 1.2 — Make a cross-Unit wire conflict a composition error

**Files:** Modify `crates/nession-protocol/src/kernel/manifest.rs`; test alongside.

- [ ] Failing test: two descriptors with **different ids** both declaring wire `git.status`
      must be refused.
- [ ] Add a composition check that returns a `Result` (a new `ProtocolError` variant or a
      `CompositionError`) mapping wire → id and failing on the first conflict. It must
      tolerate the same id arriving twice (the existing union case, `manifest.rs:293-331`).
- [ ] Decide whether `from_descriptors` becomes fallible or a sibling
      `validate_composition(&[ProtocolDescriptor])` is called by runtimes at startup.
      **Prefer the separate check** — `from_descriptors` is used in tests to build manifests
      from deliberately odd inputs, and making it fallible would force those through `unwrap`.
- [ ] Commit.

*(Tasks 1.3+ — the versioned dispatch table, composition-time handler checks, and the
synthetic two-version test Unit — are written once the runtime map lands.)*

---

## Part 3 — Stage 2: Web removes the bypass (task outline)

### Task 2.1 — Tell "never heard of it" apart from "advertised nothing"

**Files:** Modify `web/src/platform/protocol/directory.ts`, `types.ts`, `resolve.ts`.

- [ ] Failing test: a target never published must be distinguishable from one published with
      a `null` manifest.
- [ ] Give `manifestFor` a three-way answer (e.g. `{kind:'unknown'}` /
      `{kind:'advertised-none'}` / `{kind:'present', manifest}`), keeping the map's
      `null`-vs-absent distinction that `:55-62` already preserves internally.
- [ ] Commit.

### Task 2.2 — Replace `legacy` with an explicit not-ready refusal

- [ ] Failing test: `addressedPayload` with an unknown target **throws**, naming the state.
- [ ] Rename the variant `legacy` → `not-ready` (or `unknown`); `refusalMessage` returns a
      message for it instead of `null`; `addressedPayload` throws rather than sending an
      unversioned payload. The else-branch that omits `contract_version` is deleted entirely —
      after this, every payload that leaves carries a resolved version or the call fails.
- [ ] Rewrite the tests listed in Gap 2 that pin legacy-succeeds, and update the
      `resolve.ts` module doc (`:21-23`, `:26-32`) which currently argues *for* the bypass.
- [ ] Commit.

### Task 2.3 — Clear the directory when the connection goes away

- [ ] Failing test: disconnecting empties `ProtocolDirectory`.
- [ ] Wire the clear into the disconnect path, making `platform/socket/types.ts:44-46`'s
      existing claim true rather than deleting the claim.
- [ ] Commit.

---

## Part 4 — Stage 4: codegen version-aware (task outline)

### Task 4.1 — Stop the schema document losing a version

**Files:** Modify `crates/nession-protocol-codegen/src/schema.rs`, `main.rs`.

- [ ] Failing test: two versions of one id produce **two** entries, not one.
- [ ] Key `protocols` by a version-qualified name (decide the spelling: `git.status@v2`, or
      nest versions under the id). The `only` filter takes the same identity.
- [ ] Commit.

### Task 4.2 — Make the completeness tests version-keyed

**Files:** Modify `crates/nession-protocol-codegen/src/tests.rs`.

- [ ] Failing test: a catalog with two versions of one id still satisfies completeness.
- [ ] Re-key `declared()`/`advertised()` on `(id, version)`.
- [ ] Commit.

### Task 4.3 — Derive the request/response association from the provider

**Files:** Modify providers' `protocol` modules (behind their existing `codegen` feature),
`catalog.rs`, `tests.rs`.

- [ ] Failing test: for every Unit, the catalog's request/response type identity equals what
      the provider declares.
- [ ] Give each provider a machine-readable declaration of which of its types is the request
      and which the response, and reduce `catalog.rs` to a projection over those. The
      association must break the build when the provider changes it — not drift.
- [ ] Commit.

---

## Part 5 — Stage 5: gates (task outline)

### Task 5.1 — pre-push runs the canonical protocol checks

**Files:** Modify `.githooks/pre-push`.

- [ ] Add a `HAS_PROTOCOL` bucket matching the issue's scope list
      (`crates/nession-protocol/**`, `crates/*/src/protocol/**`,
      `crates/nession-protocol-codegen/**`, `web/src/generated/protocol/**`,
      `scripts/protocol-gate*`) and run `just check-protocol` + `just check-codegen`.
- [ ] The hook decides **when**, never **what** — it must not restate a protocol rule.
- [ ] Verify by making a protocol-only diff and confirming the checks run; and a docs-only
      diff and confirming they do not.
- [ ] Commit.

### Task 5.2 — Gate: category, direction and ownership invariants

**Files:** Modify `scripts/protocol-gate.mjs`, `scripts/protocol-gate-selftest.sh`.

- [ ] **Every new rule lands with a positive *and* a negative selftest case** — the negative
      one (a compliant wire must not be reported) is what stops the mis-fire class that
      `#949` hit. `just protocol-check-selftest` must fail if either half is missing.
- [ ] Add: a wire used in the wrong direction for its category is reported; hand-written
      computed wire expressions are distinguished from generated imports and declared consts
      rather than silently trusted.
- [ ] Keep the late-reply subscription case as an explicit fixture, not as a blanket exemption.
- [ ] Commit.

---

## Part 6 — Stage 6: documentation

- [ ] `docs/architecture/protocol.md`: state the multi-version dispatch flow; resolve `:472-476`
      consistently with Stage 3's decision; correct anything Stage 1–5 changed.
- [ ] `docs/architecture/protocol-identity.md`: §4 already says the wire is the id — add that
      versions share it.
- [ ] `crates/nession-protocol/src/lib.rs` and the Web resolver/directory doc comments.
- [ ] Commit.

---

## Success-criteria mapping

| Issue criterion | Stage |
|---|---|
| a Unit composes v1+v2 and the manifest declares `[1,2]` | 1 |
| v1-only consumer picks v1; v2-capable picks v2 | 1 |
| one canonical wire dispatches by resolved `contract_version` | 1 |
| cross-Unit wire grab / duplicate route / declared-without-handler all fail | 1 |
| no `manifest unknown → legacy → unversioned request` path | 2 |
| manifest-backed request missing version metadata is refused | 3 |
| stale manifest / unsupported version → unit-scoped structured refusal | 3 |
| codegen emits v1+v2; drift + completeness pass | 4 |
| generated request/response tied to the provider's typed declaration | 4 |
| every new gate rule has positive + negative selftest | 5 |
| protocol diff triggers canonical checks in pre-push and CI | 5 |
| `just check`, Web tests, gate selftest, codegen drift all pass | all |
| no doc contradicts the implementation on Legacy Peer / multi-version | 6 |

---

## Open items requiring an owner decision

1. **Stage 3's scope** — refuse unversioned requests for *all* manifest-backed Units (requires
   migrating ~50 Web call sites and the CLI), or scope it to Units the consumer actually
   negotiated. The issue's Open Question 5 leans narrow; a literal reading is repository-wide.
2. **`ContractSupport`'s flat `versions`/`wire`** — keep (adequate while versions share a wire)
   or make per-version (only needed if a real Unit ever uses different wires per version).
3. **`/tmp`-style staging of Stage 4's Task 4.3** — moving the type mapping into providers is
   the largest single change in the plan; confirm it is wanted in `#963` rather than a follow-up.
