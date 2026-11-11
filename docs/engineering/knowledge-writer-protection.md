# Knowledge trusted-writer protection — activation and recovery

**Requirement:** [#2358](https://github.com/BestNathan/nession/issues/2358).
**Current data owner:** [Knowledge ledger](knowledge-ledger.md), orphan ref `refs/heads/knowledge`.
**Execution owner:** trusted main-owned Publisher, using `scripts/knowledge-ledger-publish.mjs`.
This is an **operator runbook**, not evidence that GitHub protections are enabled. #2358's production-policy Acceptance requires authenticated live Ruleset readback, trusted main-owned negative-policy fixtures, actual authorized-publish receipts and Environment isolation review. A separately configured deny/allow/deny canary is **optional**, not a mandatory acceptance gate; do not claim an unexecuted denial test passed.

## Invariants and trust boundaries

The Knowledge ledger contract, single-commit article/index/append-only changelog, source provenance and expected-head CAS are implemented. They **do not** authorize a Git push at the GitHub server. The scheduled `CI / Knowledge Ledger Audit` is read-only and can only detect an unauthorized change *after the fact*.

The existing Run Store ruleset (GitHub ruleset `25248129`) allows Integration App `5326063` to bypass its store-specific protections; do **not** add `knowledge` to that ruleset or grant the Run Store App access to Knowledge publishing. The generic Publisher App is not automatically an approved Knowledge writer either. Assign a **distinct installed GitHub App**, with only this repository and `Contents: read/write`; do not give it repo administration or unrelated API permissions.

GitHub bypass is **ruleset-wide**. Putting `update`, `deletion` and `non_fast_forward` into one ruleset with the Publisher App as `always` bypass would also let that App bypass the deletion/force-push prohibitions. Instead, create **two independent active branch rulesets** targeting *exactly* `refs/heads/knowledge`:

| Ruleset | Rules | Bypass |
| --- | --- | --- |
| `Knowledge / Writer identity` | `creation`, `update` | Exactly one dedicated Knowledge App; `Integration` and `always` |
| `Knowledge / Append-only` | `deletion`, `non_fast_forward`, `required_linear_history` | **Empty**; no App, team, administrator role or generic writer bypass |

Rulesets compose, so the dedicated App may fast-forward but cannot delete, force-push or introduce merge commits; everyone else cannot update the ref at all. Administrative changes to the rulesets themselves remain an emergency governance capability, requiring independent audit. GitHub docs: [Ruleset layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) and [REST schema](https://docs.github.com/en/rest/repos/rules).

## Dedicated Knowledge Publisher App v1 — identity and deployment design (2026-11-09)

This is **one new GitHub App identity, not a new service, model, or publishing framework**. Existing `PUBLISHER_APP_ID` / `PUBLISHER_APP_PRIVATE_KEY` are used for Agent/PR publication; `RUN_STORE_WRITER_APP_ID` / `RUN_STORE_WRITER_APP_PRIVATE_KEY` are for Run Store writes. **Neither identity or key may be reused** for Knowledge. The canonical validator and `scripts/knowledge-ledger-publish.mjs` remain the sole data-contract and push implementation.

### App registration contract

| Setting | Required v1 value |
| --- | --- |
| Display name | `Nession Knowledge Publisher` (GitHub-assigned slug/ID is recorded after creation; do not invent one) |
| Owner / visibility | Owned by `BestNathan`; private to this account, not discoverable/third-party installable |
| Installation | `Only select repositories` → `BestNathan/nession`; never `All repositories` |
| Repository permission | `Contents: Read and write` only; GitHub's implicit `Metadata: Read` is acceptable |
| Other permissions | No `Pull requests`, `Issues`, `Actions`, `Administration`, `Workflows`, `Checks`, organization or account write permissions |
| Webhook | **Inactive**, no events/subscriptions or webhook receiver |
| User authorization / OAuth / device flow | Not required: use App installation tokens only; no end-user login or callback |
| Deployment | No long-running backend; private key is used solely to mint a short-lived installation token in an approved trusted job |

Installation-token creation follows the already proven `actions/create-github-app-token` pattern, scoped by `repositories: nession` and `permission-contents: write`. Its token is **never** a replacement for the App identity in a Ruleset: the writer-identity Ruleset must refer to the independently verified App ID (`Integration` actor). A mere app install or token mint does **not** mean the live branch is protected.

### Secret owner and authorization boundary

Only a GitHub Actions Environment named `knowledge-publish` holds:

- Environment variable `KNOWLEDGE_PUBLISHER_APP_ID` (numeric App ID, non-secret).
- Environment secret `KNOWLEDGE_PUBLISHER_APP_PRIVATE_KEY` (PEM private key; never committed, echoed or attached as an artifact).

Choose the Environment's **selected deployment branch `main`**, not the ambiguous "protected branches only" option (which may unintentionally admit more branches if protection is absent). Require the authorized reviewer before the credentialed publishing job proceeds. If using **prevent self-review**, provision a second eligible reviewer first; an owner-only setup must not silently deadlock or bypass approval. Confirm actual availability of Environment protection features for the repository plan/visibility. Keep both identifiers out of the existing `cursor` and Run Store environments and out of repository-level secrets.

The trusted workflow must be main-owned, with one read-only input/source validation phase **before** environment-scoped token mint; its credentialed phase must not invoke a model, arbitrary request-provided command, PR-head code, or downloaded executable. Keep `GITHUB_TOKEN` read-only, checkout exact trusted `main` with `persist-credentials: false`, and require an independently authenticated approved Knowledge content proposal (bounded data files + exact source/manifest digest), previous `knowledge` SHA and owner authorization. An arbitrary `workflow_dispatch` ref, untrusted artifact, unapproved issue-comment text or model response cannot authorize publication; a precisely validated **owner-authored** `/knowledge-publish v1` comment can authorize a proposal under the same source and CAS checks. The eventual trigger/receipt implementation belongs to one small main-owned workflow using the existing publisher and validator—not a second Git/Knowledge execution engine.

The only permitted production ref mutation is the validated fast-forward `refs/heads/knowledge` push followed by exact remote SHA readback; any stale expected-head, missing source attestation, policy denial, ambiguous publish or divergent replay fails closed and preserves evidence. The existing scheduled `CI / Knowledge Ledger Audit` remains **read-only** and must never inherit the App private key. Acceptance/Cases remain read-only. If an **optional** disposable canary write probe is requested later, only the separately trusted, main-owned, approved probe job may hold write credentials.

**Residual authorization limit:** GitHub App `Contents: write` applies at repository scope, not one branch. Therefore an App token could potentially push other *unprotected* refs if stolen or misused. The **dedicated App + limited secret access + protected execution + independent branch rulesets** isolate Knowledge's intended publisher and protect `knowledge`; they do **not** falsely claim the App is cryptographically restricted to a single ref. Review other sensitive refs' effective protection before activation; if single-ref authorization for all refs is mandatory, that requires repository-wide ruleset coverage or separate-repository isolation as a separate architectural decision. Never put the generic PR Publisher into Knowledge's bypass list.

### Owner publication request (after approved activation)

The canonical production router is `.github/workflows/store-knowledge-publisher.yml` (`Store / Knowledge Publisher`). Trusted main-owned entrypoints include owner `repository_dispatch` (`knowledge-publish-v1`), the strictly validated owner Issue-comment request, and the already authenticated owner proposal signal; none evaluates attacker-selected workflow code or arbitrary `workflow_dispatch` refs. Its separate unprivileged prepare and protected publish jobs both independently verify the request using main-owned `scripts/knowledge-publisher-request.mjs`; the protected job never executes candidate source code.

An authorized operator prepares an ordinary **data-only** commit on `refs/heads/knowledge-proposals/<bounded-slug>` whose parent includes the exact existing `knowledge` SHA, and runs the trusted validator before requesting publication. Pushing the candidate branch alone does not publish it.

```bash
# Operator: use approved, authenticated GitHub owner credentials.
# The ref and both SHAs below are real values, not placeholders to guess.
ref='refs/heads/knowledge-proposals/<bounded-slug>'
proposal_sha='<40-hex-proposal-commit>'
expected_head='<40-hex-current-knowledge-head>'

# Only the owner may send this exact default-branch request.
jq -n --arg ref "$ref" --arg source "$proposal_sha" --arg expected "$expected_head" '{
  event_type:"knowledge-publish-v1",
  client_payload:{
    proposal_ref:$ref,
    proposal_sha:$source,
    expected_head:$expected
  }
}' > /tmp/knowledge-dispatch.json
gh api -X POST repos/BestNathan/nession/dispatches --input /tmp/knowledge-dispatch.json
```

Before approving the Environment deployment, review the exact request SHA, source ref, proposal diff, matched Knowledge history and the authenticated Run. If the protected Environment/secret has not been independently verified, **reject** the deployment. The requester and approver must not silently bypass self-review policy. The resulting workflow emits a bounded `knowledge-publisher-<run>-<attempt>` artifact with the trusted main SHA, event, run, dedicated App ID, previous and published Knowledge SHAs, and exact proposal ref. This receipt proves a real authorized publish when correlated with independent GitHub Run/Artifact and ref readback; it **does not** prove that a forbidden force-push/delete was actually attempted. #2358 requires effective production Ruleset readback, not a mandatory canary negative probe.

**Delivered:** request verification [#3097](https://github.com/BestNathan/nession/pull/3097) and main-owned publisher [#3100](https://github.com/BestNathan/nession/pull/3100) are merged. The dedicated App and both production Rulesets are active; `knowledge-publish` Environment must remain protected. Never enable unreviewed publishing code or weaken the two-rule boundary.

### Minimal rollout, proofs, and handoff

1. **Source/design preparation (non-privileged):** merge this App contract; retain the existing main-owned validator/publisher and their negative tests. Review the proposed minimal publisher job and independently authenticated proposal format before requesting a live token.
2. **Administrator registration (privileged):** create the private GitHub App with settings above, install on `nession` only, record real App ID and installation ID, configure approved `knowledge-publish` Environment and key. Admin UI/App installation operations are **not** equivalent to source changes or Issue comments.
3. **Optional security regression (not a rollout or closure dependency):** when the GitHub permission model changes or an independently justified test is required, use an explicitly approved disposable protected canary. Capture authenticated ordinary-writer control/denial and App positive/force/delete denial receipts; never run those negative attempts on production. Absence of this optional exercise must be reported honestly, not scored as a passed negative test.
4. **Production activation:** apply two exact-`refs/heads/knowledge` Rulesets, identity bypass only this App and append-only with **zero** bypass actors. Re-read the exact IDs, rules, conditions, bypass arrays, live head and `protected: true`; independently verify Environment settings and exclusion of PR/model/ordinary Issue-comment contexts.
5. **Acceptance (2026-11-11 owner-approved revision):** SC-01 validates the two active production Rulesets and effective branch; SC-02 uses a read-only `agent` review of server-side policy configuration, negative policy fixtures, authentic main-owned publication Run/Artifact and SHA readback; SC-03 verifies main-only credential/execution isolation with operator Environment attestation and matching successful protected job. SC-04 retains the recovery runbook. The trusted Acceptance projector alone may mark criteria Pass; missing source evidence remains Pending.

Official setup references: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app), [GitHub App without webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps), [Installing your own app](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app), and [GitHub Actions Environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

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

# Use exactly the production ref when installing/reviewing the policy.
# A disposable canary is optional and never modifies this production ref.
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

# Admin-only initialization example; do not re-create rulesets that already exist.
# For current production, inspect existing IDs 26835890 / 26836090 instead.
gh api -X POST "repos/$GH_REPO/rulesets" \
  --input /tmp/nession-knowledge-writer-ruleset.json
gh api -X POST "repos/$GH_REPO/rulesets" \
  --input /tmp/nession-knowledge-append-only-ruleset.json
```

**Important:** The production Rulesets already exist (writer `26835890`, append-only `26836090`); do not execute the POST example against the live repository again. Only if a separately approved optional canary is warranted, use a uniquely named `refs/heads/knowledge-probe/<run-id>` target and distinct canary Ruleset names. Do not change production protections to run tests. Never test destructive or potentially successful negative pushes against live `knowledge`.

## Optional canary defense-in-depth probe (not required by #2358 SC-02)

This deliberately exercises GitHub's own Ruleset engine, so its additional cost and administrator setup must be justified separately. If explicitly approved, use two **different authenticated principals** and retain the actual GitHub response:

1. With an ordinary token having genuine `Contents: write` on this repository but **no bypass**, successfully write a separate *unprotected control ref*. This proves the token can write; a 401, 403, missing token or network error is *not* evidence of a Ruleset denial.
2. Attempt a normal update of the *protected canary* with that same token. Require an explicit GitHub ruleset violation (`GH013`/matching rule ID), the **unchanged canary SHA**, and a Rule Insights deny event. If it succeeds, immediately stop: configuration is unsafe.
3. With the *dedicated* App installation token, publish a normal fast-forward canary commit using the expected-head/validator protocol. Require exact GitHub SHA readback and matching app identity in the audit trail. Do not use the ordinary `GITHUB_TOKEN` for the positive test.
4. Try a **non-fast-forward update** and **deletion** of only that disposable canary as the dedicated App. Both must be denied by the **no-bypass Append-only ruleset**, and canary SHA must remain unchanged. If either succeeds, do not enable the production rulesets.
5. Check the canary history is linear (one parent per new commit), record ruleset IDs/conditions/bypass arrays/activation status, token principal types (never tokens), exact observed SHA, workflow run ID/attempt, and decision. Missing optional-canary evidence means **not exercised**, not an SC-02 failure under the revised acceptance contract.

The source-aligned `Acceptance / Cases` runner is **read-only and must not be passed either App key or ordinary write credentials**. If optional probes are authorized, execute them in a separate trusted main-owned operator job and independently verify immutable receipts. A self-test is *not* evidence of a live GitHub denial; SC-02's mandatory assertion is the actual production policy configuration plus independently authenticated authorized publication, not successful execution of this optional probe.

## Live activation and readback (SC-01 / SC-03)

For rollout or recurring review, independently query the **already installed** production rulesets and effective branch (administrator authentication when bypass metadata is masked):

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

- **Rotation:** capture current ruleset JSON and ledger SHA; provision a new key for the *same App* inside the restricted Environment, verify token mint without publishing, revoke the old key promptly, retain receipts. A disposable canary append is optional when change risk justifies it. Changing App identity requires an explicit ruleset update and two-person review; do not silently add an alternate bypass actor.
- **Publisher outage:** retain current live ref, rerun read-only ledger audit, diagnose expired key/installation/environment approval or stale HEAD. Reconcile current articles + `CHANGELOG.md`, regenerate `index.json`, validate, then retry a normal fast-forward. No generic PAT fallback.
- **Suspected unauthorized update:** stop publishing and rotate/revoke the App credentials, save live Git SHA/parent chain, current rulesets/Rule Insights, associated run IDs and an independent Git bundle. Compare to the independently pinned original root and previous checkpoint. Mark affected knowledge `Pending` until investigation; **never reset, delete or rewrite the branch to hide the event**.
- **Break-glass:** ruleset administration changes require explicit owner approval, minimal temporary exception, independently captured before/after JSON, reason, incident link and reactivation verification. A one-off emergency bypass is not normal publisher operation.
- **Closure:** SC-01/02/03/04 require **separate real evidence** under the current Issue contract: active production rulesets with exact bypass, authenticated authorized publication with exact SHA and negative admission fixtures, isolated credential/Environment attestation, and the existing recovery/rotation runbook. An optional canary is not a gate. Never claim actual unauthorized-force/delete denials occurred unless separately executed; never close #2358 on this runbook alone.
