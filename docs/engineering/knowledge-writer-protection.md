# Knowledge trusted-writer protection — activation and recovery

**Requirement:** [#2358](https://github.com/BestNathan/nession/issues/2358).
**Current data owner:** [Knowledge ledger](knowledge-ledger.md), orphan ref `refs/heads/knowledge`.
**Execution owner:** trusted main-owned Publisher, using `scripts/knowledge-ledger-publish.mjs`.
This is an **operator runbook**, not evidence that GitHub protections are enabled. No Requirement SC is Pass until the exact live configuration and probe receipts are independently checked.

## Invariants and trust boundaries

The Knowledge ledger contract, single-commit article/index/append-only changelog, source provenance and expected-head CAS are implemented. They **do not** authorize a Git push at the GitHub server. The scheduled `CI / Knowledge Ledger Audit` is read-only and can only detect an unauthorized change *after the fact*.

The existing Run Store ruleset (GitHub ruleset `25248129`) allows Integration App `5326063` to bypass its store-specific protections; do **not** add `knowledge` to that ruleset or grant the Run Store App access to Knowledge publishing. The generic Publisher App is not automatically an approved Knowledge writer either. Assign a **distinct installed GitHub App**, with only this repository and `Contents: read/write`; do not give it repo administration or unrelated API permissions.

GitHub bypass is **ruleset-wide**. Putting `update`, `deletion` and `non_fast_forward` into one ruleset with the Publisher App as `always` bypass would also let that App bypass the deletion/force-push prohibitions. Instead, create **two independent active branch rulesets** targeting *exactly* `refs/heads/knowledge`:

| Ruleset | Rules | Bypass |
| --- | --- | --- |
| `Knowledge / Writer identity` | `creation`, `update` | Exactly one dedicated Knowledge App; `Integration` and `always` |
| `Knowledge / Append-only` | `deletion`, `non_fast_forward`, `required_linear_history` | **Empty**; no App, team, administrator role or generic writer bypass |

Rulesets compose, so the dedicated App may fast-forward but cannot delete, force-push or introduce merge commits; everyone else cannot update the ref at all. Administrative changes to the rulesets themselves remain an emergency governance capability, requiring independent audit. GitHub docs: [Ruleset layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) and [REST schema](https://docs.github.com/en/rest/repos/rules).

## Preflight — before touching the live ref

1. Record the live `knowledge` SHA and original anchored root, the currently applicable rulesets, the repository default branch, and the Issue link. Do **not** reset, rebase or force-push `knowledge`. Record IDs and run URLs in #2358 without publishing credentials.
2. Create a **dedicated Knowledge Publisher GitHub App** and install it **only** on `BestNathan/nession`, with `Contents: read and write` and no other write scope. Record its GitHub **App ID** (not installation token or private key). Verify the existing Run Store App ID `5326063` is different.
3. Store `KNOWLEDGE_PUBLISHER_APP_PRIVATE_KEY` as a secret in the restricted `knowledge-publish` GitHub Actions **Environment**, and `KNOWLEDGE_PUBLISHER_APP_ID` as an Environment variable. Restrict that environment to the protected `main` branch and require authorized reviewer approval before the publisher job accesses secrets. No secret may be placed in repository files, Issue comments, PR reviews or job artifacts.
4. Review the **main-owned** publisher workflow *before* enabling live rulesets. Its trigger must resolve to trusted default-branch source (not an attacker-selected `workflow_dispatch` ref). Verify `persist-credentials: false`, no untrusted PR-head code is executed with secrets, and the Publisher token is minted **after** source/contract checks. The existing local publisher script alone is **not** proof that a safe credentialed workflow exists.
5. Capture an independent read-only backup/checkpoint of the current `knowledge` head and pinned original root; confirm the current scheduled contract audit is successful. A ruleset does not authenticate historical content retroactively.

## Administrator-side Ruleset creation

Run the following with an administrator-authenticated `gh` CLI (not the ordinary AI/CI token). Supply the **verified dedicated Knowledge App ID**, not the Run Store or generic Publisher App ID.

```bash
set -euo pipefail
export GH_REPO='BestNathan/nession'
export KNOWLEDGE_PUBLISHER_APP_ID='<replace-with-verified-numeric-app-id>'
[[ "$KNOWLEDGE_PUBLISHER_APP_ID" =~ ^[1-9][0-9]*$ ]] || exit 1

# For the production ruleset use exactly this branch; for a disposable
# canary, first create two IDENTICAL rulesets targeting only its test ref.
ref='refs/heads/knowledge'
jq -n --arg ref "$ref" --argjson app "$KNOWLEDGE_PUBLISHER_APP_ID" '{
  name:"Knowledge / Writer identity",target:"branch",enforcement:"active",
  conditions:{ref_name:{include:[$ref],exclude:[]}},
  bypass_actors:[{actor_id:$app,actor_type:"Integration",bypass_mode:"always"}],
  rules:[{type:"creation"},{type:"update"}]
}' > /tmp/nession-knowledge-writer-ruleset.json

jq -n --arg ref "$ref" '{
  name:"Knowledge / Append-only",target:"branch",enforcement:"active",
  conditions:{ref_name:{include:[$ref],exclude:[]}},
  bypass_actors:[],
  rules:[{type:"deletion"},{type:"non_fast_forward"},{type:"required_linear_history"}]
}' > /tmp/nession-knowledge-append-only-ruleset.json

# Run only AFTER the protected canary verification described below.
gh api -X POST "repos/$GH_REPO/rulesets" \
  --input /tmp/nession-knowledge-writer-ruleset.json
gh api -X POST "repos/$GH_REPO/rulesets" \
  --input /tmp/nession-knowledge-append-only-ruleset.json
```

**Important:** For the canary, substitute one uniquely named `refs/heads/knowledge-probe/<run-id>` ref into both JSON documents, with distinct ruleset names. Exercise it, remove only that owned disposable ref under independently approved admin change control, then create the *exact-production-ref* rulesets shown above. Never test a destructive or potentially successful negative push against live `knowledge`.

## Required canary proof (SC-02)

Use two **different authenticated principals** and retain the actual GitHub response:

1. With an ordinary token having genuine `Contents: write` on this repository but **no bypass**, successfully write a separate *unprotected control ref*. This proves the token can write; a 401, 403, missing token or network error is *not* evidence of a Ruleset denial.
2. Attempt a normal update of the *protected canary* with that same token. Require an explicit GitHub ruleset violation (`GH013`/matching rule ID), the **unchanged canary SHA**, and a Rule Insights deny event. If it succeeds, immediately stop: configuration is unsafe.
3. With the *dedicated* App installation token, publish a normal fast-forward canary commit using the expected-head/validator protocol. Require exact GitHub SHA readback and matching app identity in the audit trail. Do not use the ordinary `GITHUB_TOKEN` for the positive test.
4. Try a **non-fast-forward update** and **deletion** of only that disposable canary as the dedicated App. Both must be denied by the **no-bypass Append-only ruleset**, and canary SHA must remain unchanged. If either succeeds, do not enable the production rulesets.
5. Check the canary history is linear (one parent per new commit), record ruleset IDs/conditions/bypass arrays/activation status, token principal types (never tokens), exact observed SHA, workflow run ID/attempt, and decision. Treat missing evidence as `Pending`.

The source-aligned `Acceptance / Cases` runner is **read-only and must not be passed either App key or ordinary write credentials**. Execute write probes in a separately trusted, main-owned operator job, produce authenticated immutable receipts, and have the Case **verify those receipts without write privileges**. Do not convert a green smoke test or self-test into SC-02 Pass.

## Live activation and readback (SC-01 / SC-03)

After canary proof and operator approval, install the two production rulesets, then query each ID:

```bash
gh api repos/BestNathan/nession/branches/knowledge \
  --jq '{head:.commit.sha,protected:.protected}'
gh api repos/BestNathan/nession/rulesets/<writer-ruleset-id> \
  --jq '{id,name,enforcement,conditions,rules,bypass_actors}'
gh api repos/BestNathan/nession/rulesets/<append-only-ruleset-id> \
  --jq '{id,name,enforcement,conditions,rules,bypass_actors}'
```

Require `protected=true`, exact `refs/heads/knowledge` ref matching, both rulesets `active`, the **single expected Integration App** in writer identity only, and **zero bypass actors** in Append-only. Do not infer production enforcement only from the disposable canary. Verify the actual trusted publisher job's source, token mint and Environment restrictions; fork/PR-head, issue-comment and model Agent contexts must not inherit the key or App token. A successful `CI / Knowledge Ledger Audit` proves ledger integrity, **not** write authorization.

## Rotation, emergency repair, and incident response (SC-04)

- **Rotation:** capture current ruleset JSON and ledger SHA; provision a new key for the *same App* inside the restricted Environment, verify token mint without publishing, revoke the old key promptly, perform a positive disposable canary append, retain receipts. Changing App identity requires an explicit ruleset update and two-person review; do not silently add an alternate bypass actor.
- **Publisher outage:** retain current live ref, rerun read-only ledger audit, diagnose expired key/installation/environment approval or stale HEAD. Reconcile current articles + `CHANGELOG.md`, regenerate `index.json`, validate, then retry a normal fast-forward. No generic PAT fallback.
- **Suspected unauthorized update:** stop publishing and rotate/revoke the App credentials, save live Git SHA/parent chain, current rulesets/Rule Insights, associated run IDs and an independent Git bundle. Compare to the independently pinned original root and previous checkpoint. Mark affected knowledge `Pending` until investigation; **never reset, delete or rewrite the branch to hide the event**.
- **Break-glass:** ruleset administration changes require explicit owner approval, minimal temporary exception, independently captured before/after JSON, reason, incident link and reactivation verification. A one-off emergency bypass is not normal publisher operation.
- **Closure:** SC-01/02/03/04 require **separate real evidence**: effective ruleset readback, canary denied/allowed/denied operations, isolated credential/Environment review and a completed recovery/rotation record. Never close #2358 on this runbook alone.
