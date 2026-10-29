# Durable Acceptance event relay — shadow-only implementation (#2031)

**Current state:** optional Node 24+ GitHub App webhook service with authenticated
run attestation, existing Acceptance Plan-based eligible SC selection and a
SQLite WAL inbox. Incoming signed webhook envelopes are durably committed before
the HTTP 202 ACK. A separate local due-time worker re-authenticates source Runs
and writes shadow tasks atomically; it never dispatches Actions. The service has **not** been deployed. It **never dispatches
GitHub Actions**, writes Issues or changes Acceptance verdicts. The existing
Post-Run Waker and 15-minute Quota Recovery remain required.

## Why job filtering is not enough

GitHub creates a receiving Workflow Run when a workflow_run subscription
matches, even if subsequent job conditions skip every job. GitHub scheduled
workflow delivery is best-effort and cannot replace durable delayed retries.
Correctness needs an external trusted event producer that filters BEFORE
Actions dispatch and persists receipts across restarts.

## Authenticated source and selection

POST /github/webhook validates raw X-Hub-Signature-256 (1 MiB max body),
installation ID and exact repository identity. The service requests a
short-lived GitHub App installation token and reads the live source Run. It
matches run ID, attempt, workflow path and name, original event, branch,
exact head SHA, origin repository and completed/success conclusion.
Only main-push sources previously observed by Post-Run Waker are in scope.
An E2E / Full Regression success whose full job was skipped is ignored.

Open Requirement/Bug Issues are discovered from exact merged main SHA using
the same commit-to-PR relation and Issue-reference parser already owned by
requirement-acceptance.mjs. The eligible criteria are determined by the
existing buildAcceptanceContext(..., 'post-merge', {method:'agent'})
contract. This keeps when/branch/method unchanged, and skips closed Issues,
already accepted SCs and Case/deployed-only plans. Missing or malformed
contracts fail closed. Current exact merge-commit selection is intentionally
conservative: legacy Waker remains the liveness fallback for uncovered cases.

SQLite stores delivery IDs + HMAC-authenticated payload digest, and
(repo, source run+attempt, SHA, Issue, stage, contract digest) tasks.
An atomic transaction and unique index suppress duplicate webhook deliveries.
Claims have bounded leases and are singleflight; an expired claim becomes
UNCERTAIN rather than blindly redispatching after an ambiguous HTTP timeout.
A later, independently confirmed acknowledgement can resolve UNCERTAIN.
A known-unsent task may be explicitly requeued with a bounded attempt budget,
but a 5xx, timeout or ambiguous 204 is *not* proof of non-delivery. The shadow
service does not call these dispatch/ack methods.

## Set up a safe shadow deployment

Provision an HTTPS endpoint, persistent writable volume and backup for the
SQLite database, and a GitHub App installed only on BestNathan/nession.
Subscribe to workflow_run. Grant the App Actions:read, Issues:read,
Pull requests:read and Metadata:read. The receiver needs no Actions:write or
repository-contents write permission. Configure secrets through a secret manager,
not source, PR code, public logs or query parameters.

Environment (all required except PORT): ACCEPTANCE_RELAY_MODE=shadow,
ACCEPTANCE_RELAY_DB=/durable/acceptance-relay.sqlite,
ACCEPTANCE_WEBHOOK_SECRET (minimum 32 characters), GITHUB_APP_ID,
GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY (PEM; escaped-newline form
supported), PORT=8080. Start using
node scripts/acceptance-event-relay.mjs. The process exposes /healthz and
/github/webhook. Shield webhook TLS and storage with the deployment platform.

The receiver records aggregate delivery decisions; it does not expose Issue
body text, GitHub tokens or signatures. A successful health check or unit test
is not evidence of actual webhook delivery.

## Failed GitHub webhook delivery is not automatically retried

GitHub explicitly does **not** automatically redeliver failed webhook
deliveries. The shadow HTTP receiver now commits verified raw payloads and
delivery identity in SQLite **before** returning HTTP 202; a separate worker
processes GitHub API/Issue source readbacks. The worker reclaims expired
read-only leases, retries 403/429 with durable due times, and atomically
commits selected tasks and the processed receipt. No Actions run is created.

An endpoint outage before the SQLite commit, a 503, or failed TLS delivery
still requires operator/API redelivery (GitHub retains deliveries for a limited
window). A separate delivered-webhook audit/backfill and independently
verified live endpoint remain required before removing legacy Waker/Quota
Recovery. A successful health check alone is not delivery proof.
Reference: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries

## Requirements before turning off legacy receivers

1. Deploy shadow ingress and compare real source run/attempt/SHA lineage and
   selected Issue/SC to the existing Waker over real Main merges. Record
   authenticated no-op and positive cohorts.
2. Add a separate trusted main-owned consumer with live source and Issue
   re-attestation, authenticated delivery receipts and negative privilege tests.
   Switch shadow to live only after this is implemented and independently tested.
3. Add a **durable delayed QUOTA_RETRY_DUE timer** for 403/429 Retry-After and
   process/runner restarts. Test that an ambiguous dispatch is reconciled rather
   than blindly resent. Preserve bounded retries and manual break-glass.
4. Prove active replay, exact-main-SHA SC/Case and Issue-close correctness and
   measured no-op Run reduction. Only then disable old workflow_run receivers
   and the 15-minute cron. No shortcut via job-level if or skipped Gates.

Verification: ./gates/run acceptance-event-relay-selftest. This is the
canonical deterministic owner for webhook HMAC, live run attestation, SQLite
receipt-before-ACK, due-time async selection, deduplication, crash/restart,
429 recovery, lease uncertainty and malformed/fork source fixtures.
