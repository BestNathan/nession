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
4. All Task scripts run with `contents: read`, no repository write token and no privileged deployment runtime. **Optional allowlisted test credentials** are available only for tasks initiated by a GitHub-authenticated **Write+** repository collaborator/owner; others always run secretless. Task code still may not close Issues, edit Success Criteria, or generate authoritative Acceptance Pass.
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

### Optional trusted-submitter test Secret (initial policy)

A Task that needs TypeSafe can **optionally** request the single currently allowlisted `TYPESAFE_API_KEY` in its manifest (no separate `trust: trusted` or manual approval flag):

```json
{
  "schema_version": 1,
  "id": "jev-2221-probe",
  "runtime": "node24",
  "entry": "probe.mjs",
  "timeout_minutes": 10,
  "cleanup_on_success": true,
  "args": { "issue": 2221 },
  "secrets": ["TYPESAFE_API_KEY"]
}
```

The **main-owned** Task workflow checks the GitHub-authenticated `github.actor` (and `github.triggering_actor` on reruns) with the repository collaborator permission API. Only an approved **human actor with Write/Maintain/Admin** access may run a Task with the allowlisted Secret. Git commit `author`/`committer` strings, historical contributors and Task-declared trust flags are **never** proof of permission. No additional human approval occurs for authorized writers. Missing/unverifiable permission fails closed; a Task requesting secrets is rejected, not silently run without them. Bot identities are not trusted for credentialed Tasks under this initial policy.

The workflow validates the exact source SHA, task ID and manifest **before** selecting the credentialed execution step. Plain Tasks are always secretless, including when pushed by a writer. The trusted runner forwards **only the explicitly requested allowlisted Secret** to the child process; no broad environment inheritance or elevated GitHub token. A requester with write permission is thereby trusted with the Secret, so only give Write permission to users you trust to use/export that credential. Use only disposable/test-grade credentials, never production/deploy secrets. The privileged task itself must avoid printing the Secret or writing it to artifacts.

Task results, including authenticated-Task observations, remain **untrusted diagnostic evidence** under `task-results`; this is not SC Acceptance proof. This policy is intentionally narrow for initial TypeSafe experiments and can be revisited as needed.

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
- If a Task needs `issues: write`, production/deployment credentials, or branch mutation, split its read-only observation from an existing trusted workflow. For allowlisted **test API keys only**, use the Write+ actor-gated `secrets` manifest contract above; do not elevate the Task's GitHub token.
- Never report a Task result as Requirement Acceptance Pass. Use the `nession-acceptance` workflow and its deterministic updater to judge SCs.
- Before deleting, verify exact Task ID, source SHA, Run ID/attempt, successful ingest and persisted source snapshot.

Implementation owners: `.github/workflows/task-runner.yml`, `.github/workflows/task-result-ingest.yml`, `scripts/task-runner.mjs`, and `scripts/task-result-ingest.mjs`.
