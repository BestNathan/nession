# Remote E2E runtime profiles and VPN runner trust contract

Status: **design contract; not enabled**. This document specifies the independently gated `remote-staging` and `remote-production` profiles for the common `e2e/runner/` platform. It does **not** establish a VPN connection, register a self-hosted GitHub runner, attest a live cluster, or authorize a production release. The only executable profile today is `full-stack-local`; requests for either remote profile must fail closed.

## Deployment identity before execution

The trusted controller must resolve a deployment identity from an authenticated GitOps and cluster control plane, **not** from a PR-head file or a caller-supplied label alone:

- `repository`, `source_sha` (40-character commit), `gitops_commit_sha` and `environment`, all pinned.
- The three running image names and **immutable registry digest** (`server`, `agent`, `ui`); verify the digest against both the desired GitOps revision and each observed pod's `imageID`.
- Cluster/context identity, namespace, workload UID, observed generation, rollout revision and readiness timestamp. Never accept a branch name, mutable image tag or a successful GitOps push as proof of live readiness.
- A verifier asserting a particular source SHA must prove the deployed source-to-image relationship from trusted build provenance; otherwise return `Error`, not `Pass` or `N/A`.
- On promotion to production, compare **deployed** digest/revision and approval record. A main merge alone is never a deployment.

## Trust and runner isolation

1. Use a **dedicated, ephemeral, VPN-attached self-hosted runner group** restricted to a trusted main-controlled workflow and protected environment. GitHub-hosted public PR runners must never be granted WireGuard credentials or private cluster service account material.
2. Provision outbound-only VPN access to explicitly allowlisted read-only cluster/API endpoints; deny broad LAN routes, inbound access, unrelated networks and production management plane write operations. Peer and tunnel keys are short lived, rotated and revoked on runner teardown.
3. Workload identity is issued after GitHub OIDC subject/repository/ref/environment verification. A protected environment approval is mandatory for any production inspection. Avoid long-lived static kubeconfigs, personal tokens and `pull_request_target` checkout of untrusted source with credentials.
4. Trusted main resolves metadata and runs an allowlisted, pinned verifier image. A target SHA's scripts, npm lifecycle hooks, Playwright/browser code and network-controlled fixture files must **never** run with VPN tunnel credentials or Issue-write tokens. If sandboxed dynamic checks are later needed, split into an unprivileged isolated worker with outbound egress explicitly restricted.
5. Read-only RBAC permits `get/list/watch` on named workloads, pod status and approved metrics only; no `exec`, `port-forward` to arbitrary workloads, secret reads, session creation, shell commands or cluster mutation. Use a separately provisioned *synthetic fixture namespace/tenant* and ephemeral credentials for a future stateful test lane.
6. Bound each job with a timeout, network packet/byte and log budgets; disable shell command interpolation from submitted Issue/Scenario parameters. A failure to obtain identity/attestation is `Error` and must not silently fall back to local execution.

## Profile behavior

| Profile | Target | Allowed effects | Preconditions | Result |
| --- | --- | --- | --- | --- |
| `full-stack-local` | Exact checked-out SHA on CI runner | Own and clean isolated Server/Agent/tmux/Web resources | Normal CI build and sandbox | Eligible Case/Regression evaluation |
| `remote-staging` (future) | Verified staging deployment digest | Read-only health/metadata/metrics; optional pre-owned synthetic fixture | Trusted workflow, VPN, workload identity, GitOps reconciliation, bounded collector | Observations plus Case evaluation only when Case explicitly permits |
| `remote-production` (future) | Approved production deployment digest | **Read-only** deployment/health sampling only | Protected environment, independent approval, VPN and strict RBAC | Observations; no production mutation and no implicit release acceptance |

A remote profile is intentionally **not** an alternative implementation of `full-stack-local` and must not reuse local process spawning, tmux `kill-server`, temporary-home deletion or credential-rich browser execution against real users.

## Execution and evidence protocol

- The trusted main workflow resolves exact commit, environment, GitOps revision and image digests **before** connecting, and produces an immutable attempt ID. The source evaluator receives only signed/bounded observation records after the trusted collector completes.
- Every sample records UTC timestamp, monotonic relative offset, target/source identity, observed workload revision, provenance of the datum, status, counters and hashes. Clock skew is represented explicitly; never infer causal ordering solely from wall-clock timestamps.
- Permit only opt-in, allowlisted collectors. Forbid raw terminal transcript, private hostnames/IPs, session IDs, cookies, Authorization headers, full HTTP request bodies, customer data and arbitrary process environment dumps. Strip secrets before writing any artifact, and verify redaction with negative fixtures.
- Compact run records go to the **single** trusted append-only orphan results branch (`acceptance-results`) with source workflow/run attempt identity and content checksums. Large scrubbed artifacts live in controlled external retention with checksums and expiration metadata; never claim indefinite durability for Actions artifacts.
- Keep `execution` (`Completed`, `Error`, timings, evidence) separate from `evaluation` (`Pass`, `Fail`, `N/A`). A missing read permission, unavailable VPN, mismatched image digest, missing sample or absent eligible Case must not become `Pass`.
- Stage-specific Issue updates are done only by the existing trusted deterministic updater **after** authenticated ingestion and contract/SHA/stage checks. The private runner has zero Issue write privilege.

## Cleanup and failure guarantees

1. Delete only explicitly owned ephemeral fixture resources by matching owner UID and run attempt. Never kill tmux sessions or workloads outside the fixture namespace, even on timeout.
2. Revoke OIDC-derived credentials and rotate/remove tunnel keys on exit; bound artifact retention and wipe runner workspace. Retry cleanup only for the exact owned attempt (idempotent).
3. Preserve a non-secret tombstone with failure phase and last observed deployment digest when cleanup is incomplete; do not claim `Completed` without recording the uncertainty.
4. If a runner is interrupted or disconnected, reconcile orphans using trusted fixture ownership labels, not broad session sweeps.
5. Audit runner registration, policy/permission changes, environment approvals and digest provenance. Keep the network access configuration in the infrastructure repository, not as a shared mutable acceptance data branch.

## Infrastructure dependencies and acceptance gates

The implementation lane is **blocked until all of the following are provisioned**:

- Registered isolated runner group with VPN connectivity and network isolation proven via positive/negative egress checks.
- GitHub protected environments and OIDC federation with verified audience/subject, short-lived scoped identity and read-only cluster RBAC.
- GitOps/cluster reconcile observation and immutable image digest/source provenance for both staging and production.
- Synthetic fixture namespace/tenant with quota, owner-UID cleanup and zero production data access; independent dry-run cleanup safety test.
- Negative security tests for forged source SHA/digest, wrong environment, cross-run replay, missing deployment proof, hostile parameters, redaction leaks and interrupted-run cleanup.
- A main-owned workflow executing one staging read-only verification, recording a properly bounded orphan Run Record and explicitly proving **no production promotion**.

Until those gates are evidenced, `./e2e/run acceptance --profile remote-staging` and `remote-production` must continue to reject the request, and any Issue criterion requiring an actual remote run must remain Pending. This document is the **specification**, not an implementation or acceptance report.
