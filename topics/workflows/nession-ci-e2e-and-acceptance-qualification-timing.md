---
title: "Nession CI, E2E and acceptance qualification timing"
description: "Stage-specific Quality, Acceptance, Full E2E and deployed qualification without unnecessary repeated gates"
topic: workflows
categories: ["acceptance","ci","e2e","release"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-27T09:56:51Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/docs/architecture/acceptance-sc-format.md","https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/e2e-full-regression.yml","https://github.com/BestNathan/nession/issues/2323","https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/ci-quality.yml","https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/scripts/ci/quality-scope.mjs","https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/acceptance-case-smoke.yml","https://github.com/BestNathan/nession/issues/2917","https://github.com/BestNathan/nession/pull/2931","https://github.com/BestNathan/nession/blob/185cd5fbcf9934a5ad4adeccbdca75ec2f178262/scripts/acceptance-sources.mjs","https://github.com/BestNathan/nession/blob/185cd5fbcf9934a5ad4adeccbdca75ec2f178262/.github/workflows/agent-sc-acceptance.yml","https://github.com/BestNathan/nession/issues/3068","https://github.com/BestNathan/nession/blob/5575cdbbdc3ffabbe08dd5f7b3e26ba8919470ef/scripts/acceptance-plan.mjs","https://github.com/BestNathan/nession/blob/5575cdbbdc3ffabbe08dd5f7b3e26ba8919470ef/scripts/issue-contract.mjs","https://github.com/BestNathan/nession/blob/5a54f11f530c1c075fcefb86c36d8b760d79e655/.github/workflows/agent-sc-acceptance.yml","https://github.com/BestNathan/nession/issues/3388","https://github.com/BestNathan/nession/blob/b22222fe1107c0d61ecb228cb78cd30f24d40659/scripts/acceptance-executor.mjs","https://github.com/BestNathan/nession/pull/3603","https://github.com/BestNathan/nession/issues/3581","https://github.com/BestNathan/nession/blob/0c5aef6a09a23fa228a141409cc0b2aee1363dba/scripts/ci/quality-scope.mjs","https://github.com/BestNathan/nession/issues/4672"]
---

# Nession CI, E2E and acceptance qualification timing

## Stage-specific evidence

Nession separates **development correctness** from **release qualification**, so every ordinary PR need not wait for the full system test suite.

| Boundary | Meaning |
| --- | --- |
| **PR exact HEAD** | Relevant deterministic Quality Gates, selected E2E and SC-specific proof; earliest safe boundary for static/protocol/config invariants |
| **Merged staging SHA** | Specific integration, provider, cross-component or Store/Run Cases when the invariant needs a trusted integration lane; eligible Issues may reach Development Complete here |
| **Main promoted SHA** | Separate promotion lineage and applicable full regression for runtime-affecting changes; no substitute from an older or different SHA |
| **Deployed revision** | Actual environment identity and authenticated observation; a main merge does not prove deployment |

Every Success Criterion has one `when: pr | merged | deployed` and one `method: agent | case` in its canonical Acceptance Plan. Choose the earliest **provable** boundary, not the current Worker topology. `agent` can evaluate source and authenticated records read-only; executed runtime assertions require `case`. Preserve missing evidence as Pending rather than passing a skipped check.

The Issue lifecycle distinguishes **Development Complete → Main Promoted → Regression Qualified → Released**. Normal Issue completion does not automatically depend on Full E2E, product deployment or a production release.

## Canonical PR Acceptance and legacy read compatibility (#3388)

A PR is the **only** pre-integration Acceptance timing. Current Issue plans express it as `when: pr` and current Runner/Result dispatch uses stage `pr`; there is no second business phase named for the period before merge. For **new** PR-bound Success Criteria, `method: agent` is required: the restricted read-only Acceptance Agent evaluates independently authenticated exact-head source/Quality/Gate/E2E receipts. Selected PR Case Smoke remains an executable **CI evidence producer**, not a second PR Acceptance projector and never a replacement for absent runtime proof.

For merged staging/main and verified deployment predicates, `when: merged` or `when: deployed` and appropriately source-aligned `method: case` remain independent. The trusted normalizer understands historical Issue/Run/Attempt/Case stage spelling without rewriting immutable receipts, reclassifying previous Case Pass as Agent Pass, modifying saved contract digests or accepting stale SHA. The archived name is valid **only when reading previous evidence**, never in new workflow job identifiers, dispatch parameters or result stages.

The source implementation is [canonical planner at code merge 5575cdbb](https://github.com/BestNathan/nession/blob/5575cdbbdc3ffabbe08dd5f7b3e26ba8919470ef/scripts/acceptance-plan.mjs), [new-Issue PR Agent contract](https://github.com/BestNathan/nession/blob/5575cdbbdc3ffabbe08dd5f7b3e26ba8919470ef/scripts/issue-contract.mjs), and [trusted workflow activation PR #3393](https://github.com/BestNathan/nession/pull/3393). The workflow-conventions Gate rejects reintroducing the obsolete stage spelling into live PR Acceptance workflows; the PR-head requirement Gate uses a canonical PR identity. Historical verification and external publication evidence keep their own original SHA and method.

## Immutable orphan-source evidence for read-only Acceptance (#3068)

A selected `method: agent` Success Criterion may declare immutable evidence inputs in an optional, separate Issue `## Acceptance Sources` section. The canonical `Acceptance Plan` remains limited to `when / branch / environment / method`; declarations do not select a proof stage or create a third proof method. Trusted-main `scripts/acceptance-sources.mjs` permits only the explicitly approved `prototype`, `knowledge` and `gitops` orphan branches, an existing reachable full 40-character source commit, and precisely enumerated allowlisted text files within fixed file/byte budgets. It validates source Git tree modes, UTF-8, safe paths and target staging-root collisions, then creates an SC-scoped read-only view and content-addressed manifest. A changing branch tip cannot change a pinned source.

The trusted `Agent / SC Acceptance` router stages only currently eligible Agent SCs; model tools remain read-only, and source/comment instructions and model citations cannot expand trusted authority. Source declarations and manifest identity bind verdict and reuse digests without changing the historical digest of no-source Issues. A narrowly cutoff-bounded historical GitOps archive path remains for older explicitly marked Issues; new and no-source Issues must never implicitly archive entire branches or comments.

A source file proves only its pinned bytes and structure: prototype HTML does **not** prove Pages publication, Knowledge content does **not** prove a public readback, and a desired-state GitOps file does **not** prove reconciliation. These still require independently authenticated publication/runtime evidence and the applicable `method: case`. The [#3068 Case Smoke run](https://github.com/BestNathan/nession/actions/runs/42569458181) observed five source-aligned historical PR-head Case Smoke Pass results at head `1086b28a3ac7333cbd68a470d6c14a09cba0db66`; Smoke is supporting development evidence, **not** the formal `Acceptance / Cases` → immutable `Acceptance / Case Ingest` → Issue-projection chain.

## Full E2E and cost

The current `E2E / Full Regression` performs exact-main-SHA qualification when runtime changes require it; it also has separate periodic health-admission logic. An explicitly tooling-only/non-applicable push yields authenticated **Not Required** evidence, **not** Full Pass. Mixed, unknown or browser-affecting changes must not be silently omitted. A successful GitHub workflow is not itself an authenticated Issue acceptance record.

## Scope-aware PR Quality and Case Smoke (#2917)

The [merged Quality routing](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/ci-quality.yml) executes the **trusted Main** `scripts/ci/quality-scope.mjs` against the **exact PR head versus merge-base**, or the exact Main-push first-parent diff; it does not assume a historical PR head contains today's selector. A positively classified agent-development Markdown fixture has no Rust/Web/Tooling Quality applicability. Historically #2917 used global conservative fallback for unknown paths; **#4672 supersedes that policy** for valid complete diffs (see below). Unverifiable or empty integration diffs remain conservative. The stable required `web-check` aggregates applicable `tooling-check` and `web-tests` results after parallel execution; failure, missing/unknown outputs and skipped *required* families fail closed. The individual Gate catalog/definitions and Rust coverage rules are unchanged.

[Case Smoke](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/acceptance-case-smoke.yml) validates contracts and selects source-aligned fixtures before provisioning Rust, Web, tmux or Chromium. Historically PR-linked Case-method manifests can remain executable as **CI test evidence**, but new PR Success Criteria use the read-only Agent method, not formal PR Case ingestion. A PR with no selected source-aligned Case records Not Required instead of running representative runtime Cases. Representative infrastructure Cases remain in the main/manual/scheduled lane. An eligible real Case or unknown entitlement cannot be silently treated as absent. The separate E2E planner retains its independent risk/Issue-selection policy.

A verified Main `web-dist` artifact is emitted only after the applicable `web-check` aggregate passes. The trusted [source attestation](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/scripts/ci/web-dist-source-attestation.mjs) verifies producer source/repo/branch, exact SHA, Run/Attempt, required jobs and steps. It distinguishes **both Web tests and dist skipped** as authenticated `WEB_DIST_NOT_REQUIRED_V1` (no artifact check), versus actual `WEB_DIST_SOURCE_V1` and restoration. A mixed skip, foreign/stale source or missing job must fail. Real positive proof: [Quality producer 42378852053](https://github.com/BestNathan/nession/actions/runs/42378852053) and [Web Dist consumer 42379261477](https://github.com/BestNathan/nession/actions/runs/42379261477), both exact Main SHA `4a5436a8...`, restore and preview parity successful.

### Per-family positive applicability and independent fallback (#4672)

The [activated selector](https://github.com/BestNathan/nession/blob/0c5aef6a09a23fa228a141409cc0b2aee1363dba/scripts/ci/quality-scope.mjs) separates trustworthy changed-path facts from family-specific impact. On a complete nonempty diff, each of Rust, Web, Native, Tooling, Workflow and Instruction independently selects its positive inputs; unmatched repository paths select Tooling diagnostics only, not implicit Rust/Web/Native execution. Mixed changes union the applicable families. Unknown scripts and shared Gate dependencies retain explicit Rust/Web-local conservative rules until their input boundaries can be proven. Invalid path facts or empty integration diffs conservatively select all families; a failed diff or malformed NUL input blocks scope instead of fabricating a valid result. The selector logs matched paths and named reasons alongside its stable boolean outputs.

Positive boundaries cover Cargo manifests/lock/toolchain and native transitive crates, protocol codegen outputs, shared checker infrastructure and the root README (a real Rust CLI integration-test input). The [canonical routing self-test](https://github.com/BestNathan/nession/blob/0c5aef6a09a23fa228a141409cc0b2aee1363dba/scripts/ci/quality-scope.test.mjs) checks unknown paths, mixed inputs, Cargo local paths, literal includes and manifest-relative external assets; both Rust and Tooling suites run the guard. Arbitrary dynamically constructed input paths still require owner review and registration. The independent E2E/Case applicability policies are unchanged; a skipped inapplicable job is not an executed Pass.

Implementation: [PR #4676](https://github.com/BestNathan/nession/pull/4676), main merge `0c5aef6a09a23fa228a141409cc0b2aee1363dba`; [exact integration-head Quality](https://github.com/BestNathan/nession/actions/runs/45973966034), E2E and Case Smoke succeeded before protected merge. This proves the policy source was activated, not the complete live config-only routing receipt: [disposable probe #4681](https://github.com/BestNathan/nession/pull/4681) and SC-04 require separate authenticated scope/job evidence. No performance SLA is claimed.

### Measured performance — separate exact-head PR samples

A disposable unmerged [probe PR #2931](https://github.com/BestNathan/nession/pull/2931) recorded three independent GitHub Actions runs (Ubuntu 24.04; one sample per class). Measured values are **workflow created-to-updated wall time**, not isolated CPU/test time.

| Change category | Before comparable run | After exact-head run | Observed Quality wall time |
| --- | --- | --- | --- |
| Fixture-only | [42371357810](https://github.com/BestNathan/nession/actions/runs/42371357810) — 370s | [42379218472](https://github.com/BestNathan/nession/actions/runs/42379218472) — 24s | -94% |
| Web-only | [42377591120](https://github.com/BestNathan/nession/actions/runs/42377591120) — 404s | [42379309835](https://github.com/BestNathan/nession/actions/runs/42379309835) — 230s | -43% |
| Terminal Rust + Web | [42375105508](https://github.com/BestNathan/nession/actions/runs/42375105508) — 367s | [42379657576](https://github.com/BestNathan/nession/actions/runs/42379657576) — 259s | -29% |

The after Quality jobs all passed with their applicable suites and required aggregate. Fixture-only Case Smoke dropped from ~246s to 28s without runtime build. **Do not extrapolate these three observations to a guaranteed CI SLA**: source commits/inputs, caches and scheduling differ; they are not same-SHA paired A/B trials and no multi-sample variance is established. The mixed probe's [E2E job 42379657588](https://github.com/BestNathan/nession/actions/runs/42379657588) **failed closed** because the disposable source PR had no Issue-linked E2E plan; that does *not* provide product E2E Pass evidence. Correctness and independent Acceptance obligations must still be met by real feature PRs.

## Bounded GitHub evidence projection (#3581)

The deterministic Acceptance Issue updater proves PR-source supersession before projecting a result. It needs only the exact previous/next SHAs, comparison ancestry metadata and associated PR identity; the full compare payload (commits, files, diffs) and unrelated PR fields are not provenance.

`scripts/acceptance-executor.mjs` projects the required fields through `gh api --jq` and caps the `gh` child buffer at an explicit 8 MiB. A response above the cap, invalid or truncated JSON, missing comparison metadata, or a full 100-entry PR page is an explicit bounded-provenance error and fails closed: the updater performs no Issue projection and never treats partial bytes as authenticated evidence. `verifiedPrSourceSupersession` still owns SHA/PR-source authentication; bounding collection removes neither ancestry nor Issue-association checks. The historical failure was Node `spawnSync gh ENOBUFS` on a large comparison after the upstream acceptance executor and artifact download had already succeeded, leaving genuine evidence unapplied.

Evidence: Issue [#3581](https://github.com/BestNathan/nession/issues/3581), merge [PR #3603](https://github.com/BestNathan/nession/pull/3603) at `b22222fe1107c0d61ecb228cb78cd30f24d40659`; source-aligned Cases `e2e/acceptance/cases/3581/SC-01|SC-02` prove the large-response success and the fail-closed negatives. SC-03 stays Pending until trusted main records an actual affected-PR updater receipt.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — why triggers, evidence and result projection are different owners.
- [Nession public Pages source publication and orphan-branch signals](nession-public-pages-source-publication-and-orphan-branch-signals.md) — deploy/readback verification is not a generic Quality Gate.

## Authority and limitations

The exact [SC authoring and lifecycle contract](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/docs/architecture/acceptance-sc-format.md) and [Full Regression workflow](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/e2e-full-regression.yml) govern operational details. Deployed proof depends on a real authenticated environment/revision; production integration is not implied by successful staging acceptance.
