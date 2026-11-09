# Remote E2E runtime profiles and VPN access trust contract

Status: **read-only remote-staging observation implemented; remote Case profiles not enabled**. This document specifies the independently gated `remote-staging` and `remote-production` profiles for the common `e2e/runner/` platform. The project already has VPN access configuration; this document does not claim that the intended GitHub workflow has exercised that route or that a live cluster has been attested. The only executable **Acceptance Case** profile today is `full-stack-local`; the observation-only `remote-staging` collector does not enable remote Case execution. Requests for remote Case profiles must fail closed until the gates below are proven.

## Deployment identity before execution

The trusted controller must resolve a deployment identity from an authenticated GitOps and cluster control plane, **not** from a PR-head file or a caller-supplied label alone:

- `repository`, `source_sha` (40-character commit), `gitops_commit_sha` and `environment`, all pinned.
- The three running image names and **immutable registry digest** (`server`, `agent`, `ui`); verify the digest against both the desired GitOps revision and each observed pod's `imageID`. When one build is published to several registries, or a trusted mirror rewrites the index (for example by dropping attestation manifests), provenance records one immutable digest per registry and attests the digest of the registry actually observed in `imageID`; an unknown registry is rejected.
- Cluster/context identity, namespace, workload UID, observed generation, rollout revision and readiness timestamp. Never accept a branch name, mutable image tag or a successful GitOps push as proof of live readiness.
- A verifier asserting a particular source SHA must prove the deployed source-to-image relationship from trusted build provenance; otherwise return `Error`, not `Pass` or `N/A`.
- On promotion to production, compare **deployed** digest/revision and approval record. A main merge alone is never a deployment.

The executable policy for this chain is `scripts/deployment-identity-policy.mjs` (Gate `deployment-identity-selftest`). It parses a trusted GitOps overlay, validates trusted build provenance, and binds one full source SHA to three immutable digests and three ready observed workloads (exact namespace, workload name, UID, generation and imageID). `scripts/deployment-identity-collect.mjs` is the adapter that maps raw read-only `kubectl get deployments/pods` JSON into that observation shape and rejects mid-rollout or ambiguous pods. Neither script performs cluster or registry I/O, emits evidence by itself, or enables a remote profile; a trusted workflow must still supply authenticated inputs.

## Existing CI access path (verified from repository source, not a live route test)

The current `.github/workflows/deploy-identity.yml` uses the project's existing
**GOST v3 relay over WSS** to forward only the Kubernetes API endpoint, rather
than provisioning WireGuard on the GitHub-hosted runner. The workflow consumes
`GOST_RELAY_URL` and `KUBE_CONFIG_CI`; the 2026-10-27 incident notes referring
to `WG_CI_CONF` describe an older transport and are not instructions to
create another VPN. The relay and tunnel are networking; only Kubernetes RBAC
and trusted deployment provenance authorize the subsequent observation.

The `Deploy / Identity` attest job is limited to `BestNathan/nession` on
`refs/heads/main`, pins the checkout to its triggering SHA, and declares
GitHub Environment `nession-staging-identity`. **An Environment name in
workflow YAML does not prove it has protection configured.** The repository
administrator must independently configure this existing workflow's
Environment in GitHub Settings: restrict deployment branches/tags to
`main`, limit the allowed actors/approval policy, store the scoped tunnel
and Kubernetes read-only credentials as Environment secrets, and remove
the legacy repository-wide copies. Verify the *effective* Environment
rules and a rejected non-main dispatch from GitHub API/Run evidence.
Merely adding this YAML key does not establish SC-02 or a short-lived
OIDC credential. The current static `KUBE_CONFIG_CI` remains a documented
migration/blocker for OIDC/short-lived identity until a working provider
and live readback exist.

Do not mistake negative `kubectl auth can-i` checks for firewall egress
enforcement: they demonstrate Kubernetes API authorization, not denied
connectivity to other LAN destinations. The actual CI workflow now additionally
probes a fixed harmless **local** destination (`127.0.0.1:6443`) at TCP level
after the positive API-alias probe; that verifies the GOST listener is not
wildcard-bound on the runner. This is *not* proof of a relay-side ACL or LAN
egress deny-list, which still needs an independently approved live control. Demonstrate the network boundary with
an explicitly allowlisted API endpoint **and** a separately approved,
non-sensitive denied-destination probe from the actual workflow environment
before asserting SC-01. A successful tunnel startup is not an authenticated
deployment attestation.

The workflow currently collects deployment/pod identity and ingests the
bounded attestation through `Deploy / Identity Ingest`; this is a
**deployment identity record**, not an executed `remote-staging` E2E Case.
The `E2E / Staging Lanes` workflow runs a full-stack-local suite at the
attested source SHA and must not be called live deployed-environment E2E.
Remote Case execution remains disabled until its trusted read-only collector,
profile admission and evidence ingestion are actually implemented.

## Main-owned identity revalidation after verifier changes

The existing `E2E / Staging Lanes` admission job already reads trusted GitOps
and dispatches `Deploy / Identity` for stale attestations. On a **trusted
main push** that changes the identity workflow, GOST lifecycle, source
attester or Staging observer (including the lane router itself), the same
owner also requests **one** new `Deploy / Identity` dispatch for `staging`,
unless the stale-lane step already dispatched it. An unrelated main push
does not open another VPN session. No secrets are passed to the scheduler:
the protected, read-only identity workflow still receives its own
`workflow_dispatch` input, retains its exact Run/Attempt provenance and is
ingested by the unchanged trusted Run Store path. This is not an implicit
production inspection, deployment, Case evaluation or SC Pass.

## Job-owned GOST tunnel and fault cleanup

`scripts/ci/deploy-identity-tunnel.sh` is the single lifecycle owner for
`Deploy / Identity` on the pinned Ubuntu runner. It refuses a preexisting
`192.168.2.162/32` loopback alias instead of borrowing it, creates an
explicit owned-alias marker only after successful `ip addr add`, and starts
GOST directly as the job user (6443 is unprivileged). The PID marker binds
the executable, approved listener argument and Linux /proc start-ticks to
protect against PID reuse; cleanup never broad-kills an unrelated process.
The workflow's `if: always()` step invokes the same owner for shutdown
after failure, timeout or ordinary completion; `start` also self-cleans if
startup fails. The script removes only its job-owned alias, tunnel, temporary
kubeconfig, observations and downloaded provenance. A failed privileged alias
inspection is an Error, not permission to delete an unverified address.

The existing `deployment-identity-selftest` Gate tests actual isolated
sleep subprocess signal/termination, PID replay rejection, malformed markers,
unowned subprocess and file preservation, owned-alias cleanup and idempotent
retries. These are **local lifecycle proofs**, not substitute evidence for
an actual cancelled Actions run or runner destruction. An independent
cancel/timeout run must still show job cleanup or hosted runner teardown
before SC-05 is asserted from infrastructure.

## Read-only remote-staging observation (implementation boundary)

The existing main-controlled `Deploy / Identity` job now invokes
`scripts/remote-staging-observe.mjs run --profile remote-staging` using the
**same** GOST/WSS tunnel and Kubernetes read-only kubeconfig, after successfully
attesting the exact GitOps overlay, build digest and ready workloads. It takes
two separately read `kubectl get deployments/pods -o json` snapshots with
fixed argv and bounded time/output, and reuses the canonical identity adapter
to reject a changed source SHA, deployment UID/generation, readiness, imageID
or registry digest during sampling. No PR-head verifier, Playwright, shell
session, pod creation, port-forward or cluster mutation executes with tunnel
credentials.

The bounded `remote_observation` is an **optional part of the existing
authenticated deployment Run Record**, rather than a second Store or an Issue
acceptance result. It records UTC and monotonic relative sample offsets,
source/GitOps identity, approved roles, UID/generation/readiness and immutable
digest; it cannot contain raw kubectl JSON, internal IPs, hostnames, secrets,
headers or terminal content. The observation always has `evaluation: null`.
`scripts/deployment-identity-policy.mjs` validates its exact field allowlist
and binding; `scripts/deployment-attestation-ingest.mjs` includes it in the
canonical authenticated Run/Attempt execution identity only for new records,
preserving old persisted record hashes. Failed/mismatched sampling fails the
trusted source workflow and produces no new attestation artifact/Pass.

**This is live read-only Staging observation, not a general remote E2E Case
runner.** The canonical `Acceptance / Cases` workflow and
`./e2e/run acceptance` still support only `full-stack-local`. Do not
advertise remote Case execution, evaluate a deployed SC as Pass from an
`Observed` record alone, or reuse an observation as proof for a different
source SHA/run. Additional app-level remote Case protocols would require a
separately approved noncredentialed executor and normal exact-source Case
ingestion. Production remains opt-in and blocked pending its own approval,
credentials and read-only policy.

## Trust and runner isolation

1. Reuse the **existing project VPN access path** from a trusted main-controlled workflow and protected environment where that execution environment supports it. Do not provision a second VPN or dedicated runner group by default. Only propose additional runner/network infrastructure if a concrete limitation of the existing path is demonstrated.
2. Exercise the configured route and verify positive and negative connectivity to explicitly allowlisted read-only cluster/API endpoints. Deny broad LAN routes, inbound access, unrelated networks and production management-plane writes. Keep tunnel credentials short-lived and scoped; do not expose them to PR-controlled code.
3. Workload identity is issued only after GitHub OIDC subject/repository/ref/environment verification. A protected environment approval is mandatory for any production inspection. Avoid long-lived static kubeconfigs, personal tokens and `pull_request_target` checkout of untrusted source with credentials.
4. Trusted main resolves metadata and runs an allowlisted, pinned verifier image. A target SHA's scripts, npm lifecycle hooks, Playwright/browser code and network-controlled fixture files must **never** run with VPN tunnel credentials or Issue-write tokens. If sandboxed dynamic checks are later needed, split them into an unprivileged isolated worker with outbound egress explicitly restricted.
5. Read-only RBAC permits `get/list/watch` on named workloads, pod status and approved metrics only; no `exec`, arbitrary `port-forward`, secret reads, session creation, shell commands or cluster mutation. Use a separately provisioned *synthetic fixture namespace/tenant* and ephemeral credentials for any future stateful test lane.
6. Bound each job with a timeout, network packet/byte and log budgets; disable shell command interpolation from submitted Issue/Scenario parameters. Failure to obtain identity/attestation is `Error` and must not silently fall back to local execution.

## Profile behavior

| Profile | Target | Allowed effects | Preconditions | Result |
| --- | --- | --- | --- | --- |
| `full-stack-local` | Exact checked-out SHA on CI runner | Own and clean isolated Server/Agent/tmux/Web resources | Normal CI build and sandbox | Eligible Case/Regression evaluation |
| `remote-staging` (future) | Verified staging deployment digest | Read-only health/metadata/metrics; optional pre-owned synthetic fixture | Trusted workflow, existing VPN route, workload identity, GitOps reconciliation, bounded collector | Observations plus Case evaluation only when Case explicitly permits |
| `remote-production` (future) | Approved production deployment digest | **Read-only** deployment/health sampling only | Protected environment, independent approval, existing VPN access and strict RBAC | Observations; no production mutation and no implicit release acceptance |

A remote profile is intentionally **not** an alternative implementation of `full-stack-local` and must not reuse local process spawning, tmux `kill-server`, temporary-home deletion or credential-rich browser execution against real users.

## Execution and evidence protocol

- The trusted main workflow resolves exact commit, environment, GitOps revision and image digests **before** connecting, and produces an immutable attempt ID. The source evaluator receives only signed/bounded observation records after the trusted collector completes.
- Every sample records UTC timestamp, monotonic relative offset, target/source identity, observed workload revision, provenance of the datum, status, counters and hashes. Clock skew is represented explicitly; never infer causal ordering solely from wall-clock timestamps.
- Permit only opt-in, allowlisted collectors. Forbid raw terminal transcript, private hostnames/IPs, session IDs, cookies, Authorization headers, full HTTP request bodies, customer data and arbitrary process environment dumps. Strip secrets before writing any artifact, and verify redaction with negative fixtures.
- Compact run records go to the **single** trusted append-only orphan results branch (`acceptance-results`) with source workflow/run attempt identity and content checksums. Large scrubbed artifacts live in controlled external retention with checksums and expiration metadata; never claim indefinite durability for Actions artifacts.
- Keep `execution` (`Completed`, `Error`, timings, evidence) separate from `evaluation` (`Pass`, `Fail`, `N/A`). Missing read permission, unavailable VPN, mismatched image digest, missing sample or absent eligible Case must not become `Pass`.
- Stage-specific Issue updates are done only by the existing trusted deterministic updater **after** authenticated ingestion and contract/SHA/stage checks. The remote collector has zero Issue-write privilege.

## Cleanup and failure guarantees

1. Delete only explicitly owned ephemeral fixture resources by matching owner UID and run attempt. Never kill tmux sessions or workloads outside the fixture namespace, even on timeout.
2. Revoke OIDC-derived credentials on exit; bound artifact retention and wipe runner workspace. Any tunnel key lifecycle must follow the existing VPN provider's controls. Retry cleanup only for the exact owned attempt (idempotent).
3. Preserve a non-secret tombstone with failure phase and last observed deployment digest when cleanup is incomplete; do not claim `Completed` without recording the uncertainty.
4. If a workflow is interrupted or disconnected, reconcile orphans using trusted fixture ownership labels, not broad session sweeps.
5. Audit workflow identity, policy/permission changes, environment approvals and digest provenance. Keep VPN/network access configuration in its existing infrastructure owner, not in a shared mutable acceptance data branch.

## Infrastructure dependencies and acceptance gates

Full remote Case execution and production inspection remain **blocked until all of the following are evidenced**, beyond the narrow read-only Staging observation:

- The existing VPN route is exercised from the intended trusted workflow environment, with positive/negative egress checks and no duplicate runner/VPN infrastructure unless evidence shows it is required.
- GitHub protected environments and OIDC federation with verified audience/subject, short-lived scoped identity and read-only cluster RBAC.
- GitOps/cluster reconcile observation and immutable image digest/source provenance for the target deployment.
- Synthetic fixture namespace/tenant with quota, owner-UID cleanup and zero production data access if stateful tests are introduced; independent dry-run cleanup safety test.
- Negative security tests for forged source SHA/digest, wrong environment, cross-run replay, missing deployment proof, hostile parameters, redaction leaks and interrupted-run cleanup.
- A main-owned workflow executing Staging read-only observation over the existing VPN path, recording a bounded authenticated deployment Run Record with `evaluation: null` and explicitly proving **no production promotion**. The code path exists; a successful post-merge live observation in the append-only Store must still be checked.

Until full remote Case gates are evidenced, `./e2e/run acceptance --profile remote-staging` and `remote-production` must continue to reject the request. Read-only observation may be recorded without fabricating a Case Pass; criteria requiring actual remote Case or production behavior remain Pending. This document is the **specification**, not an implementation or acceptance report.
