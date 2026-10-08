# Source-aligned Acceptance Cases

Acceptance Cases are executable, source-aligned proofs for individual Requirement Success Criteria. They complement regression E2E and the existing trusted Requirement Acceptance updater/gates; they do not replace either.

## Creating a Case

The canonical layout is:

```text
acceptance/cases/<issue>/<SC>/
  case.yaml
  verify.js | verify.spec.js | ...
```

There is exactly **one Case per Issue/SC** and one independently reported result for that criterion. A Case can contain several verifier steps. Reusable implementation belongs under `acceptance/shared/`, but shared helpers are never independently accepted.

A minimal manifest:

```yaml
schema_version: 1
issue: 1474
criterion: SC-14
stage: staging
runtime: full-stack-local
verifiers:
  - type: browser
    entry: verify.spec.js
  - type: protocol
    entry: verify.js
result_policy: all-pass
```

Discovery is derived from the directory tree and manifest. There is no shared mutable registry file.

## Stage selection

Choose the Acceptance Report stage from the Requirement contract:

- `pre-merge`: evidence required before the feature PR gate.
- `staging`: evidence that needs the merged staging SHA and integration environment.
- `post-merge`: evidence that can only be established after the main merge. A main merge alone is not evidence that production deployed.

The Case stage must exactly match the SC row in the Issue Acceptance Report. Automatic `staging` and `main` runs pin `github.sha`; manual replay requires an exact 40-character SHA plus Issue, SC, stage and runtime profile.

## Runtime contract

`acceptance/runtime/full-stack.js` owns the real local full stack:

- Nession Server;
- Nession Agent;
- isolated tmux socket;
- isolated Nession home/database/config;
- production Web build;
- per-run ports and readiness checks;
- guaranteed teardown.

Playwright is a verifier, not the runtime owner. Protocol and runtime verifiers use the same provisioned stack without launching a browser.

## Verifier choice

Use the narrowest evidence surface that proves the SC:

- **browser** — visible UI, navigation, focus, interaction, rendering or browser-observable behavior;
- **protocol** — WebSocket/wire behavior, server/agent routing and protocol state;
- **runtime** — files, process state, configuration, orchestration contracts, logs or lifecycle assertions.

A Case may combine verifier types. `result_policy: all-pass` is deterministic: any Error wins over Fail, Fail wins over Pending, and only concrete Pass from every verifier produces Case Pass. Skip or missing evidence is Pending, never Pass.

## Evidence quality

A passing verifier must emit concrete single-line evidence. Prefer facts such as exact protocol response, visible browser state, checked workflow identity, target SHA, Case tree SHA, artifact/checksum or durable record path. Do not use "tests passed", "looks good", or the verifier's own claimed status as the only proof.

Every Case result freezes:

- exact product `target_sha`;
- source-aligned `case_revision` and Case tree SHA;
- immutable SC contract digest;
- run id/attempt and execution id;
- runtime profile;
- verifier outcomes and evidence;
- infrastructure status and duration.

Large browser traces/screenshots/logs stay in GitHub Actions artifacts. Compact immutable records are ingested separately.

## Automatic staging and post-merge execution

The repository-owned `Acceptance Cases` workflow uses the same runner for both merged branches.

- staging push → `stage=staging`;
- main push → `stage=post-merge`;
- trusted `discover-ref <exact-sha>` resolves associated Requirement Issues from the PR(s) that produced the commit;
- only Case manifests whose Issue and stage match are selected;
- the target checkout is the exact SHA, not a moving branch name.

Manual `workflow_dispatch` accepts one Issue/SC/SHA/stage/runtime tuple and follows the same runner.

## Immutable results and Issue projection

Case execution has only read permissions. Compact results are uploaded as artifacts. The trusted `Acceptance Case Ingest` workflow on `main` runs afterward with write permissions and serializes ingestion through one concurrency group.

The first ingestion creates the orphan `acceptance-results` branch. Records under `runs/<date>/<run>-<attempt>/<issue>/<SC>.json` are append-only: an existing destination is an error and the branch is never force-pushed. The record carries a checksum of the source result and links back to the workflow/artifact provenance.

Only trusted ingestion projects a Case into the Issue. Projection is allowed only when:

1. the Requirement is still open and labeled `requirement`;
2. the target SHA is the current `staging` or `main` SHA for the declared stage;
3. the target SHA is associated with the Requirement;
4. Issue, stage, SC and contract digest still match;
5. the result selects only that independent SC.

Historical/manual runs remain durable evidence even when they are no longer eligible to mutate the latest Issue projection.

## Security boundary

The Case runner executes target-tree code with `contents: read` and `issues: read` only. It never receives Issue write permission or production secrets. The trusted ingestion/updater comes from `main`, validates records before persistence/projection, and alone receives the minimal write permissions needed for `acceptance-results` and the Issue body.

Never move the updater into target code, never let a verifier call `gh issue edit`, and never treat a self-asserted Pass or a skipped verifier as accepted evidence.

## Archive, removal, and promotion

After acceptance, a feature-specific Case may be archived, superseded, or removed in a later source commit. To remove it, **delete the Case directory** in a normal reviewed PR. Historical target SHAs still contain the original Case and the append-only `acceptance-results` record retains execution provenance, so source cleanup does not erase the accepted claim.

If the scenario protects a durable product invariant rather than a one-time Requirement, promote it to regression E2E (or the appropriate unit/integration suite) before removing the Case. Regression E2E remains long-lived product protection; Acceptance Cases remain Requirement-scoped proofs.

## Remote profiles

Future remote verification is deliberately separate from `full-stack-local`.

### remote-staging

A `remote-staging` profile must run only on an approved **VPN-connected** runner, resolve the real staging deployment identity (image digest/revision plus environment), use read-only/safe probes against the deployed service, and record that deployment identity in evidence. The runner gets only the network and credentials required for staging observation.

### remote-production

A `remote-production` profile requires a separately approved VPN-connected runner/environment with stricter **least privilege**, explicit production deployment identity verification, bounded read-only probes, and **safe cleanup** that cannot terminate or mutate real user sessions.

Remote verifiers must never infer "deployed" from a main merge or image build. They must compare the actual deployed revision/digest. Production secrets are never exposed to source-aligned Case code from an untrusted PR.

Remote profile implementation is **deferred until VPN runner and deployment-identity infrastructure are ready**. Until then, the schema intentionally enables only `full-stack-local`; the remote contract exists so enabling it later does not redefine the trust boundary.
