# SC Acceptance Orchestration — operational contract and future deployment boundary

> **Implementation status:** the constrained `## Acceptance Plan` YAML contract is supported for per-SC `when`, `branch`/`environment`, and `method`; main/staging merged-SHA Agent/Case selection, exact target proof, trusted Case ingestion and Issue result projection are operational. New three-column Acceptance Reports derive the compatibility stage from the Plan; historical four-column Reports and issues without a plan remain supported. **Production `when: deployed` execution remains deferred:** an actual environment/revision/digest and authorization boundary must be implemented independently; main merge is not deployment.

## Problem and decision

The current `pre-merge | staging | post-merge` stage vocabulary mixes **timing** and **branch**. Meanwhile, some SCs can be proved by a read-only model Agent inspecting code and existing tests, while others require the full system to be started after a merge, with scripted fault injection, user operations and observable assertions.

**Decision:** an SC is the unit of proof. Its plan has orthogonal `when`, `target`, and `method` coordinates. An orchestration workflow chooses eligible SCs, dispatches their proof mechanism, evaluates evidence under a trusted policy and projects one authoritative result.

## Logical plan example

```yaml
acceptance:
  SC-01:
    when: pr
    method: agent

  SC-02:
    when: merged
    branch: staging
    method: case

  SC-03:
    when: merged
    branch: main
    method: case

  SC-04:
    when: deployed
    environment: production
    method: case
```

This is the **supported constrained Issue grammar**, validated by `scripts/acceptance-plan.mjs` and the owning Issue/Gate contracts. If present, the plan must cover every SC; its effective legacy runner stage is derived when the Report has no Stage column, or checked against any explicitly declared historical Stage. Case manifests describe execution, not independent authority for SC selection.

`branch: staging | main` is required for `when: merged` in the current contract; no caller may silently infer a different default. Exact target SHA and source commit association must be recorded.

## Target dimensions

| Dimension | Values / identity | Rule |
|---|---|---|
| When | `pr` | Proof about exact PR **head SHA**, not an arbitrary newest staging branch |
| When | `merged` | Proof about exact merged branch/commit SHA, with `branch` retained as target selection |
| When | `deployed` | Proof of a real rollout bound to environment + artifact digest/revision; no merge-as-deploy shortcut |
| Method | `agent` | Read-only code/test/CI examination, emits reasoned structured evidence |
| Method | `case` | Exact-source Case; E2E Runner provisions declared runtime/drivers and evaluates executed assertions |
| Result | `Pass`, `Fail`, `Pending`, justified `N/A` | Executor errors are separately recorded and are never synthetic product Fail/Pass |

Legacy stage migration guidance (not always one-to-one):

- `pre-merge` normally maps to `when: pr` + PR head SHA.
- `staging` normally maps to `when: merged`, `branch: staging`, merged staging SHA.
- `post-merge` normally maps to `when: merged`, `branch: main`, main SHA **only when** the old SC meant main-branch verification. If the old SC actually requires observing production, map to `when: deployed` and explicitly verify deployed identity. No blind bulk conversion.
- Historical records keep their original stage/target semantics and remain immutable; compatibility readers translate only where justified.

## Agent vs Case proof — example: Terminal reliability

| SC | When / Target | Method | Required proof |
|---|---|---|---|
| Session stream authority and protocol invariants | PR head | Agent | Inspected code paths, exact file locations, versioned tests and relevant CI SHA |
| No parser-applied ACK before xterm write callback | PR head | Agent or Case as explicitly selected | If Agent: concrete tests and implementation trace; if runtime proof required: Case with controlled delayed parser |
| Reconnect replays without gaps | merged staging SHA | Case | Launch Server+Agent+tmux+Web, simulate disconnection/recovery, assert ordered bytes/sequences |
| Relay and P2P parity across client switch | merged staging SHA | Case | Simulate route switching and multi-client observation; capture assertions/timeline |
| Behavior against actual deployed production release | deployed digest | Case | Actual revision identity + safe remote observation; future VPN profile as an independently gated prerequisite |

The SC definition, **not the Agent's preference**, decides whether Agent-only proof is sufficient. No automatic Agent fallback if a mandatory Case is absent.

## Planner, executor, evaluator and result pipeline

```text
PR / merged push / verified deployment event / explicit manual request
  -> trusted SC plan + Issue association + immutable SC contract digest
  -> exact target & eligibility (when, target, method)
  -> dispatch:
       agent: read-only model tool access -> structured findings, telemetry
       case:  e2e/run acceptance -> real assertions, runtime evidence
  -> trusted evaluator: provenance, method, scope, SHA, contract, evidence
  -> canonical immutable Run Record -> single authorized Issue projector
  -> deterministic PR/merge/Issue-close Gate
```

- **Planner** is a logical interface owned by Acceptance; it need not imply a single long-running GitHub Actions file. Avoid credential/trigger coupling that defeats `pull_request_target` boundaries.
- **Agent path**: can cite file paths/lines, source tests, exact workflow run URLs and SHA. Read-only tools (read/grep/glob; approved CI readers). Textual confidence alone is not sufficient evidence. Missing/ambiguous evidence -> `Pending`.
- **Case path**: unique source-aligned `e2e/acceptance/cases/<issue>/<SC>/case.yaml`; use Browser, Protocol, Terminal, Process and Collectors as required. The E2E Runner owns lifecycle, isolation, readiness, cleanup and actual operation simulation. All skipped/missing assertions/missing case cannot Pass.
- **Selection**: mandatory Case Coverage is computed solely for `method: case`. Agent SCs do not require a Case. There must be one authorized proof method per SC for a given evaluation context, except an explicitly versioned composite evidence policy.
- **Provenance**: SHA + Issue/SC digest + source/run attempt/trigger + trusted tooling revision + Case tree/revision or Agent provider/model + runtime/deployment identity + evidence handle/digest. Verify both the actual workflow run identity and the artifact contents. A manual arbitrary SHA replay needs a separately authenticated manual provenance contract; it cannot masquerade as the workflow trigger's head SHA.
- **Records**: raw immutable Run Records on one authoritative orphan results branch; large evidence via hashed links to external artifact storage. Metrics orphan branch is separate and tracks agent usage, not authoritative SC verdicts.
- **Projector**: single trusted updater enforces eligibility/currentness; Agent path and Case ingest must never race to overwrite one SC. Preserve rejected and historical evidence without projecting it as current acceptance.

## Gate semantics

- Pre-merge PR Gate checks the SCs due before the requested merge boundary, using exact PR head evidence. SCs only provable after merge remain explicitly deferred, not silently Pass.
- A merged staging SHA executes eligible merged-stage Case/Agent proofs; main may use the same execution logic against **its own** exact SHA.
- Issue close Gate requires all applicable SCs to have acceptable, authenticated results. Document when an SC can legitimately be `N/A`.
- Reuse staging evidence on main only under an explicit validator-approved reuse contract (source/build/runtime/environment equivalence). Never infer it from branch ancestry alone.
- Distinguish GitHub workflow infrastructure success from SC `Pass`; a non-zero test command may produce an authenticated failure record.

## Implemented controls and the remaining production boundary

1. `scripts/acceptance-plan.mjs` provides the optional, validated per-SC `when × method × branch/environment` contract; the Issue validator and Requirement Acceptance Gate derive stage from a v2 Plan and reject mismatching explicitly-staged historical Reports.
2. `scripts/acceptance-executor.mjs`, `scripts/select-merged-agents.mjs` and `scripts/select-acceptance-cases.mjs` enforce method- and stage-qualified eligibility, with negative fixtures and exact target SHA; Agent-only criteria do not require a Case.
3. `./e2e/run acceptance` owns real source-aligned Case execution; the main-owned `Acceptance / Cases` and `Acceptance / Case Ingest` workflows preserve independent runtime evidence and trusted immutable record projection.
4. `Acceptance / Orchestrator` owns the PR/merged-SHA routing and Issue-close Guard. Model-backed execution is separated into `Agent / SC Acceptance` and emits canonical telemetry; the source-run path/name and stable logical workflow ID must be checked when renaming.
5. Real staging and main integration is documented in Issue #1674 and in the evidence below; a main merge is never assumed to be production deployment.
6. **Still future:** `when: deployed` requires independently authenticated deployment identity, environment, exact artifact revision/digest, safe runtime profile and trusted event/permission boundary. Do not mark deployed-only SCs Pass from an ordinary `main` push.

Owning implementation detail remains in `nession-acceptance`, `nession-writing-requirements`, `nession-gates`, `e2e/README.md`, and `docs/architecture/acceptance-cases.md`. This document governs cross-boundary design decisions, not an alternate executable validator.

## Live independent staging/main verification

[Requirement #1674](https://github.com/BestNathan/nession/issues/1674) proves method and SHA separation in actual GitHub Actions: staging `9249399c1a09b713c67d98687aa49e96bdc802fa` Agent run `38255975987` and full-stack Case run `38255975783`; main merged SHA `01111075dc08afa931907ee268d2dd7376d037d1` Agent run `38258395366` and Case run `38258395018`, with trusted Case Ingest `38258723607` and independently stored Case records. Neither main nor staging run proves a production deployment. The current Gate and workflow contracts, not this historical run sample, determine ongoing applicability.
