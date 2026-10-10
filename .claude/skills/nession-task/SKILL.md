---
name: nession-task
description: Use when executing a one-time CI script, replaying diagnostics, collecting temporary evidence, or running a disposable GitHub task without merging its code into main/staging.
---

# Nession Task — ephemeral execution

This Skill owns the **one-time script lifecycle**, not product development, E2E Case semantics, or Requirement Acceptance. Load `nession-development` for permanent changes, `nession-acceptance` for SC judgments, and `nession-cicd` for workflow/trust repairs.

## Invariants

1. Permanent runner/tooling lives on `main`; ephemeral input lives **only** on `task/<id>` and is **never merged to main or staging**.
2. One branch = one `.task/task.json` = one entry script. Only that manifest selects the executable. Never infer an entry from git diff, glob order, or arbitrary shell supplied through workflow inputs.
3. Results/snapshots live only on the **separate orphan branch `task-results`**; do not put Task artifacts in `acceptance-results`.
4. Untrusted task scripts run with `contents: read`, no repository write token, no production secrets, and no privileged deployment runtime. They may not close Issues, edit Success Criteria, or generate authoritative Acceptance Pass.
5. Only trusted `main` ingestion verifies pinned source/run metadata and appends records; uploaded task artifacts are untrusted input even if the Actions run is green.
6. A failed Task is evidence of a failed execution, not a successful Acceptance Result. Always report exact SHA, run ID/attempt, and archival status.

## Create a one-off Task

Start from latest `origin/main` in an isolated worktree (never change the root checkout):

```bash
git fetch origin main
git worktree add -b task/bug-1522-replay .claude/worktrees/task-bug-1522-replay origin/main
cd .claude/worktrees/task-bug-1522-replay
mkdir -p .task
```

Create `.task/task.json`:

```json
{
  "schema_version": 1,
  "id": "bug-1522-replay",
  "runtime": "node24",
  "entry": "replay.mjs",
  "timeout_minutes": 20,
  "cleanup_on_success": true,
  "args": { "issue": 1522 }
}
```

Create `.task/replay.mjs` (or a small module tree inside `.task/`). `entry` is a relative path inside `.task/`, **not** a shell command. The runner validates path containment, symlinks, file/size bounds, runtime and the pinned checkout SHA before execution. No dynamic URL, arbitrary action name, executable outside `.task/`, or inline script in Actions input is supported.

Node entry scripts receive `TASK_ID`, `TASK_SOURCE_SHA`, `TASK_ARGS_JSON`, `TASK_OUTPUT_DIR`, and `TASK_RESULT_PATH`. Write a compact JSON object to `TASK_RESULT_PATH` for a structured result; logs are for diagnostics only. Never include credentials, private terminal buffers, tokens or unbounded logs in task results.

## Execute automatically (normal path)

```bash
git add .task/task.json .task/replay.mjs
git commit -m "chore(task): replay bug-1522 evidence"
git push -u origin task/bug-1522-replay
```

A `push` changing `.task/**` on `task/**` runs `.github/workflows/task-runner.yml`. The branch must inherit this Workflow from `main`. Do **not** open a PR or merge the task code. The `task/<id>` suffix must match the manifest `id`.

GitHub suppresses most new workflow triggers caused by a push using the default Actions `GITHUB_TOKEN`. If an AI is operating inside GitHub Actions, use an explicitly authorized GitHub App/PAT push identity that can trigger workflows; do not make an empty main commit or add a per-task YAML to force execution. If push dispatch is unavailable, ask an authorized caller to use the manual path.

## Manual dispatch and retry

Manual run (requires Actions write authority; also useful when a connected GitHub tool cannot dispatch new runs):

```bash
gh workflow run task-runner.yml --ref main \
  -f task_id=bug-1522-replay \
  -f source_sha=<exact-40-character-task-commit>
```

Never use a mutable branch name as the source SHA. `workflow_dispatch` selects the trusted entry point on `main`; `source_sha` selects immutable Task content. Retrying the original run preserves identity/attempt through GitHub's rerun mechanism:

```bash
gh run rerun <run-id> --repo BestNathan/nession
```

Pushing a new task commit creates a **new source version**, not a retry of the previous version. Preserve failed run records and explain the cause.

## Observe, locate evidence, clean up

```bash
gh run list --repo BestNathan/nession --workflow task-runner.yml --branch task/bug-1522-replay
gh run view <run-id> --repo BestNathan/nession --log-failed
gh run view <run-id> --repo BestNathan/nession --json conclusion,headSha,attempt,url
```

The `Task Result Ingest` main-owned workflow authenticates run identity and persists compact evidence under:

```text
task-results:
  runs/<task-id>/<run-id>-<attempt>/record.json
  sources/<source-sha>/<task-id>.json
  indexes/by-sha/<source-sha>/<run-id>-<attempt>.json
```

Check the downstream ingestion run **and actual `task-results` record** before calling archival complete. The source snapshot preserves `.task/` file bytes after branch deletion. Uploaded logs/artifacts have independent retention and are not automatically authoritative.

After verified ingestion, setting `cleanup_on_success: true` instructs the **trusted ingestion workflow** to delete the exact archived task branch using a server-side SHA lease; failures or newer pushes retain the branch. Omit it (or set false) when you want to inspect/replay the branch manually.

If cleanup was not requested, only after ingestion succeeded and no further replay is needed:

```bash
git push origin --delete task/bug-1522-replay
# from the original root checkout:
git worktree remove .claude/worktrees/task-bug-1522-replay
git worktree prune
```

Never auto-delete a branch before the trusted evidence store is confirmed. The cleanup flag belongs to the **verified source Manifest**, not to an untrusted artifact. If archiving failed, keep the branch and repair ingestion rather than declaring the task complete.

## Boundaries and stop conditions

- For regression verification against a running stack, prefer `e2e/scenarios` or source-aligned `e2e/acceptance/cases/<issue>/<SC>`; this Task mechanism does not replace their runtime and case contracts.
- Permanent migrations, product fixes, reusable diagnostics or a test that should become a Gate must go through normal feature/fix PRs, not a `task/*` branch.
- If a Task needs `issues: write`, network secrets, production access or branch mutation, split the script's read-only evidence collection from an existing trusted workflow. Do not add permissions to the untrusted runner.
- Never report a Task result as Requirement Acceptance Pass. Use the `nession-acceptance` workflow and its deterministic updater to judge SCs.
- Before deleting, verify exact Task ID, source SHA, Run ID/attempt, successful ingest and persisted source snapshot.

Implementation owners: `.github/workflows/task-runner.yml`, `.github/workflows/task-result-ingest.yml`, `scripts/task-runner.mjs`, and `scripts/task-result-ingest.mjs`.
