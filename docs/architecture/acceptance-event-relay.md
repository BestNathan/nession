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

For an operator-owned, opt-in deployment template use
[deploy/acceptance-relay/README.md](../../deploy/acceptance-relay/README.md)
and its Compose profiles. A shadow start exposes only a localhost HTTP
port (external TLS proxy required), uses the canonical Node 24 code in a
trusted read-only checkout, and persists signed receipts in a named SQLite
WAL volume. The separately authorized Actions:write publisher and App
failed-delivery audit require an explicit live profile and separate secret
files **outside** the repository. These templates are not live deployment
evidence and do not authorize removal of the existing safety workflows.

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

## GitHub App webhook failure audit and redelivery (opt-in)

GitHub does not retry failed App webhooks automatically, and only the
previous **three days** can be redelivered. An independently supervised
`acceptance-webhook-recovery.mjs` process (default disabled) audits the
App owner's `GET /app/hook/deliveries` with short-lived **App JWT**, using
bounded cursor pagination. It verifies the trusted repository ID (fetched
using the App's installation token), installation ID, event
`workflow_run.completed`, delivery GUID, timestamp and status. A GUID
with any successful attempt is never resent. Failed attempts belonging to
unrelated repos/installations/events are never redelivered.

Before calling `POST /app/hook/deliveries/{delivery_id}/attempts`, the
recovery process reserves the GUID in SQLite with a durable delay and a
bounded attempt count; an unexpected timeout/503 or process restart cannot
cause an immediate second POST. HTTP 202 only says GitHub scheduled another
delivery: it is NOT an Acceptance evidence receipt. The next audit checks
the complete GUID attempt history again. A three-day outage exceeds
GitHub's retention horizon and requires manual external recovery; live
operations must alert before that threshold.

Run on a durable host/volume with `ACCEPTANCE_WEBHOOK_RECOVERY_MODE=enabled`,
`ACCEPTANCE_RELAY_DB=/durable/acceptance-relay.sqlite`,
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
`GITHUB_APP_PRIVATE_KEY`. Start using
`node scripts/acceptance-webhook-recovery.mjs`. The local App delivery
audit occurs every ten minutes; **it creates no GitHub Actions Runs** and
never attempts direct Issue updates. This mode is opt-in and not enabled by
the existing shadow receiver. The App owner JWT must be protected.

Source: https://docs.github.com/en/rest/apps/webhooks and
https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries

## Trusted event-consumer workflow contract (not enabled by shadow)

The repository includes a main-owned `Acceptance / Event Consumer` workflow
(`.github/workflows/acceptance-event-consumer.yml`), invoked only by an
explicit `workflow_dispatch`. Its six inputs are source_run_id,
source_attempt, target_sha, issue_number, contract_digest and task_id.
The consumer re-fetches the live completed source run, checks allowlisted
workflow path/name, exact main SHA, original push, successful conclusion and
source attempt; checks SHA ancestry in the trusted main checkout; re-reads
the current Issue and canonical Acceptance Plan; and recalculates task_id
before invoking the existing `agent-sc-acceptance.yml@main` Agent and
deterministic Issue updater. Invalid or stale input never authorizes Agent
execution.

A separate, **opt-in live publisher** (scripts/acceptance-event-publisher.mjs)
uses an independently scoped GitHub App credential with **Actions:write**,
Actions:read, Issues:read and Pull requests:read for this repository. The
publisher must not be available to untrusted PR-head code. The read-only
webhook receiver does not require Actions:write.

GitHub introduced `return_run_details: true` for workflow_dispatch in
February 2026. An explicit HTTP 200 with exact `workflow_run_id`,
`run_url` and `html_url` is persisted in SQLite as a Run receipt, with no
roundtrip guessing. The legacy 204, malformed 200, timeout or 5xx is
**uncertain** and must not cause a blind second POST. The publisher attempts
read-only reconciliation against `Acceptance / Event Consumer` Run details:
exact task ID in display_title, workflow path, name, event, repository and
main branch; an absent match in a bounded listing is NOT proof of non-delivery.
Definitive 403/429 refusals are scheduled at a bounded Retry-After/reset
due time and survive process restart. Expired dispatch leases become uncertain,
not pending. Source and current SC are re-validated before making a POST;
an invalid/stale contract becomes a terminal suppressed task with no Run ID.
A terminal confirmed task has a non-null `dispatch_run_id` only when an
actual Actions Run was accepted. The existing Issue Updater remains the
sole authority for SC Pass.

Run the publisher as a **different process/security principal** sharing
only the persistent SQLite WAL directory with the webhook receiver:
`ACCEPTANCE_PUBLISHER_MODE=live`,
`ACCEPTANCE_RELAY_DB=/durable/acceptance-relay.sqlite`,
`GITHUB_PUBLISHER_APP_ID`,
`GITHUB_PUBLISHER_INSTALLATION_ID`,
`GITHUB_PUBLISHER_PRIVATE_KEY` (PEM, encrypted deployment secret).
Start using `node scripts/acceptance-event-publisher.mjs`. If
`ACCEPTANCE_PUBLISHER_MODE` is absent or not exactly `live`,
the publisher refuses to start. Install/configure the separate App explicitly.
The publisher uses durable due times and low-cost local SQLite wake checks;
it creates **no recurring GitHub Actions Runs**. A running publisher,
configured credential, and live webhook ingress are required before any
task can be actually dispatched. Concurrency and run-name correlation are not
an exactly-once guarantee: an ambiguous dispatch remains blocked for
operator reconciliation unless a unique trusted consumer Run is observed.

GitHub documentation: https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids/

The separate sender can only operate when explicitly configured. The
shadow receiver never imports its Actions:write identity. Do **not** disable
the legacy Waker or Quota Recovery until production live source→task→
consumer→Updater receipts, missed-webhook backfill, and fault injection
are proven, and verify the browser/Issue close boundaries remain intact.

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

Verification: ./gates/run acceptance-event-relay-selftest and ./gates/run acceptance-event-publisher-selftest. This is the
canonical deterministic owner for webhook HMAC, live run attestation, SQLite
receipt-before-ACK, due-time async selection, deduplication, crash/restart,
429 recovery, lease uncertainty and malformed/fork source fixtures.
