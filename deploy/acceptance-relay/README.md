# Acceptance event relay — opt-in operator stack

This is a **deployment entrypoint**, not a deployed production service. It
uses the already-merged webhook, SQLite Inbox, Event Consumer, Outbox publisher
and failed-delivery audit from the Acceptance event-driven coordination effort.
Do **not** disable the old Post-Run Waker or Quota Recovery merely because this
Compose stack can start. The canonical behavior, security boundaries and
remaining cutover criteria live in
[docs/architecture/acceptance-event-relay.md](../../docs/architecture/acceptance-event-relay.md).

## Host and secret prerequisites

Use a trusted **pinned main release/commit checkout** (never a PR-head checkout)
on a supervised Linux host with Docker Compose V2, reliable HTTPS ingress,
outbound access to GitHub API and a durable volume/backup plan. Only the
`ingress` service exposes an HTTP port, bound to `127.0.0.1:19091` by
default. An external reverse proxy **must** provide public HTTPS and forward
`/github/webhook` without rewriting the raw body/signature. Do not route
public traffic directly to the Compose port.

Create `/etc/nession/acceptance` **outside the Git checkout** with mode
`0700`. Create distinct root-readable secret env files, each mode `0600`:

| File | Environment variable names | GitHub App authority |
|---|---|---|
| `relay.env` | `ACCEPTANCE_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | Webhook + Actions:read, Issues:read, Pull requests:read |
| `publisher.env` | `GITHUB_PUBLISHER_APP_ID`, `GITHUB_PUBLISHER_INSTALLATION_ID`, `GITHUB_PUBLISHER_PRIVATE_KEY` | **Separate** App, Actions:write + Actions:read + Issues:read + Pull requests:read |
| `recovery.env` | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | Webhook-owning App, App delivery API read/redelivery via JWT |

GitHub Apps must be installed on `BestNathan/nession` only. The receiver
subscribes to `workflow_run` and holds a long random webhook HMAC secret
(minimum 32 characters). Provide private keys through host secret injection,
not Git, Docker images, PR code, command arguments or logs. Use escaped
`\n` to represent PEM newlines when populating the environment files.
For a **shadow** boot, `publisher.env` and `recovery.env` can be empty
placeholder files; the two live services must not be started.

Set `ACCEPTANCE_SECRETS_DIR=/etc/nession/acceptance` in the operator shell.
Do not put secrets in the Compose file. Limit Docker socket access to trusted
operators; anyone controlling the Docker daemon can access container secrets.

## Shadow first (no Actions dispatch)

From the pinned repository checkout:

```bash
export ACCEPTANCE_SECRETS_DIR=/etc/nession/acceptance
docker compose -f deploy/acceptance-relay/compose.yaml --profile shadow config
docker compose -f deploy/acceptance-relay/compose.yaml --profile shadow up -d
curl -fsS http://127.0.0.1:19091/healthz
docker compose -f deploy/acceptance-relay/compose.yaml --profile shadow ps
```

GitHub App Settings > Advanced > Recent Deliveries should show actual
successful signed `workflow_run.completed` webhook receipts delivered to
your HTTPS URL; localhost health alone is **not** delivery proof. Confirm
the SQLite volume persists unique signed delivery GUIDs, read-only candidate
tasks, and that no new `Acceptance / Event Consumer` Actions Run has been
created by the shadow service. Exercise duplicate redelivery, a non-main run,
a malformed signature and an irrelevant Issue. Observe the event and task
receipt state through the audited SQLite DB. Do not export Issue payloads or
secrets into logs.

## Live proof — gated operator action, not automatic rollout

Only after successful shadow cohort comparison and an owner-approved
maintenance window: configure the separate publisher App and recovery env
files. Explicitly start `--profile live` (do **not** set it in any GitHub
Action or repository default):

```bash
docker compose -f deploy/acceptance-relay/compose.yaml --profile live config
docker compose -f deploy/acceptance-relay/compose.yaml --profile live up -d
docker compose -f deploy/acceptance-relay/compose.yaml --profile live ps
```

The publisher uses the main-owned `Acceptance / Event Consumer`; it cannot
infer acceptance from external inputs. Evidence requires **all** of:
authenticated source run ID/attempt/main SHA, SQLite receipt/Task ID,
`return_run_details: true` dispatch Run ID, verified consumer execution,
canonical Agent result, trusted Issue Updater and exact SC transition.
An HTTP 204/timeout/5xx **never** proves delivery. A GitHub App 202 webhook
redelivery response only means another attempt was queued, not delivered.

Fault-test 403/429 `Retry-After`, termination during a dispatch POST,
restart during Inbox processing, a webhook outage/redelivery, ambiguous
204/timeout reconciliation, and receipt persistence across a restart.
Measure zero-work `Acceptance / Post-Run Waker` and Quota Recovery Runs
against comparable pre/post source cohorts. Do not infer an attributable
improvement from incomparable windows. Include fresh Issues that have
pending merged-stage SC, no-op runs, Case-only plans and closed Issues.

## Persistence and rollback

`acceptance-sqlite` is a named **durable** Docker volume shared by all
three processes. The initializer runs as root only to set volume ownership
to UID 1000 and mode 0700; the Node services are read-only-rootfs,
non-root and have no-new-privileges. Back up SQLite using a consistent
backup procedure (SQLite online backup API or stop all writers and archive
the complete volume, including WAL/SHM) and **test restoration**. Never
`docker compose down -v` in a live environment. Back up before an upgrade.

Rollback is to stop the new publisher/recovery (or the whole Compose
stack) and keep existing Waker/Quota Recovery enabled; **do not erase
SQLite**. Any task already submitted to Actions still needs exact-run
reconciliation, not a blind replay. Alert for missed webhook scans, blocked
`uncertain` tasks, oldest undelivered source event, 429 retry age,
unexpected service exit, disk/backup failures, and delivery age approaching
GitHub's 3-day redelivery limit.

**Important:** this bundle does not provide a GitHub App installation,
credentials, a public HTTPS endpoint, a deployed state store, a successful
live Run receipt, or authorization to remove existing workflow fallbacks.
Those must be independently proven before closing the parent requirement.
