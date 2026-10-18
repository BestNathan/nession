# Nession Pages

Independent public site for project introduction, AI workflow Agents, repository engineering indicators, active GitHub Issues/PRs, and metadata-only orphan Run Store inventory. See [Issue #1782](https://github.com/BestNathan/nession/issues/1782).

This is **not** the authenticated product Web UI. No product Web components, shared themes/tokens, auth, WebSocket or runtime endpoint is used. The Pages design is authored entirely under \`pages/\`; Node 24 is the only build requirement and there are no npm dependencies.

## Build locally (sanitized / offline-capable)

\`\`\`bash
cd pages
npm test
npm run check
npm run build
# output: pages/dist/
\`\`\`

The build reads \`METRICS_DIR/metrics.json\` and \`METRICS_DIR/agent-metrics.json\` from a read-only, pinned checkout of the canonical \`metrics\` orphan branch. It reads the AI Role/Instance registry from \`automation/agents/registry.json\` in trusted main. With \`GITHUB_TOKEN\`, it additionally queries the GitHub Issues/PRs and orphan ref metadata APIs at **build time**. Only strictly selected public fields are written into \`dist/data/site.json\`.

\`\`\`bash
METRICS_DIR=../metrics-store \
SOURCE_MAIN_SHA=<40-hex-SHA> METRICS_SHA=<40-hex-SHA> \
GITHUB_TOKEN=<read-only-token> node scripts/build.mjs
\`\`\`

If a source is unavailable the snapshot retains \`null\` / \`unavailable\` rather than inventing zero or success. Aggregate tokens and costs are not attributed to individual Agents. Orphan ref presence must not be interpreted as verified append-only protection. All browser links are bounded to the public GitHub repository.

The static UI uses hash navigation (\`#/agents\`, \`#/work\`, etc.) so direct deep links work under the repository's GitHub Pages base path without rewrite rules. Deployment is owned by a **separate, trusted, main-based workflow PR** per \`.github/AGENTS.md\`; it must not build, deploy, or modify \`web/\`.

## Phase 2-A — public source-backed observations

The build-only `agent-metrics.json` source supplies rolling 7-day and 30-day `runs.by_provider` and `runs.by_workflow` counts, and 7-day `runs.by_issue` counts. The versioned public projection includes only bounded, safe category names, observed nonnegative integer counts and source metadata. Missing observations remain `null` / N/A (not an inferred zero). It does **not** establish causal PR↔Agent linkage, exact-SHA Acceptance verdicts, live presence, per-Agent cost or orphan integrity. The independent Pages layout and UI do not depend on product `web/`.

## Phase 2-B1 — public PR HEAD evidence

Recent GitHub Actions Run metadata is fetched **only during the independent Pages build** and validated against exact, same-repository PR HEAD SHA, canonical workflow path/event, positive Run/attempt identity and bounded listing. The Collaboration view reports each canonical CI/E2E **workflow outcome**, never a Success Criterion / Acceptance verdict or an Issue↔PR/Agent causal join. No observed run means Not observed within a 100-run snapshot, not a claim about all history.

## Phase 2-B2 — source-only Issue Timeline PR references

For up to 12 public Issues, the independent Pages build requests GitHub `cross-referenced` Timeline events (bounded 100 events per Issue). A displayed PR must have a canonical same-repository GitHub Issue/PR API and HTML path. Deduplicated and capped at 6 PR links per Issue; a 100-event Timeline is labeled **truncated**, and a failed API fetch **unavailable**. A cross-reference is a GitHub mention/source link, not verified Issue ownership, implementation, Agent provenance, exact PR HEAD or SC Acceptance. Browser code never calls authenticated APIs.

## Public export safety and freshness (Phase 2-B3)

Public metric freshness is evaluated against each canonical source's `generated_at`, **not** the Pages build time (8-hour fresh threshold, then stale; missing/future-skewed source unavailable). Standalone Pages performs a fail-closed release audit of the versioned allowlisted JSON payload: bounded Issue/PR, registry and source references; canonical GitHub links; finite metrics; no injected fields, private local addresses or filesystem paths. Untrusted free-text Issue titles/providers are redacted before export when they contain private host/path information. Source freshness and site build times are displayed independently. This is a public publication gate, not an orphan-store integrity certificate.

## Phase 2-B4 — public current-HEAD PR review observations

For at most 12 displayed open PRs, a trusted build-time read-only GitHub API fetches up to 100 PR Review events each. Pages validates the GitHub PR identity, exact current PR HEAD commit SHA, review ID, submitted time and canonical review source URL; publishes only the latest valid event with an explicit available/truncated/unavailable observation window. Historical APPROVED reviews on old commits are not presented as current, and a current-HEAD APPROVED event does not certify aggregate merge readiness or trusted SC Acceptance. Review bodies, author data and comments are never exported. Incomplete API windows preserve Not observed semantics. This does not establish the Issue→implementing PR→Agent Run chain or #1690 orphan integrity.

## Phase 2-C1 — source-bound Issue Agent Run observations

The trusted standalone build reads only the pinned canonical Metrics checkout's last seven UTC days of `raw/workflows/{issue-audit,requirement-acceptance,agent-provider-smoke}/DATE/*.json` under a strict source-file budget. The canonical Agent telemetry validator, exact original storage path, repository, workflow, event, Run ID and attempt must match. A dirty/drifted Metrics checkout, path escape, symlink, invalid record or conflicting identity fails closed to `unavailable`; bounded windows display `truncated`. All raw Agent records stay server-side and only allowlisted source facts (Issue, workflow Run/Attempt, SHA, optional Agent ID/role/provider, observed tokens/duration and canonical GitHub Actions link) enter the public JSON.

GitHub Run identity is labeled **independently verified** only if the already bounded GitHub Actions window matches the same Run/attempt/repository/workflow/event and any exact target SHA. Otherwise it is **Not independently verified**. Crucially, `PR linkage: Unlinked` is always explicit: an Issue number in a Metrics run summary does not prove an implementing PR, Developer/Reviewer succession, a trusted Acceptance SC Pass, or #1690 orphan integrity. Missing Agent IDs and metrics remain null. No product `web/` dependencies, browser token, raw Provider session or privileged writer are introduced.

### Canonical mixed producer compatibility

The `requirement-acceptance` Metrics directory can contain the historical `Agent / SC Acceptance` (`workflow_dispatch`) producer as well as the current `Acceptance / Orchestrator` (`pull_request_target`) producer. The public reader recognizes **only these explicit allowlisted producer identities**, checks the original storage path and target Issue before publishing, and verifies each against its own canonical Actions workflow path when an exact Run/attempt is observed. An unrelated historical record cannot invalidate a different selected Issue's observation window. This does **not** promote old Acceptance to a current SC Pass or imply an implementing PR. Post-merge production source status must be checked independently from passing synthetic tests.

### Verified public deployment receipt

A successful independent Pages workflow now verifies that the exact anonymous HTTPS `/data/site.json` bytes match the trusted build's SHA-256, checks the pinned main SHA and measures the `agent_run_source` coverage and actual public Issue Agent Run count. The result is printed in its authenticated deployment job log as either `source_backed_observation` or `not_observed`. Only a completed same-repository main-push deployment at the **exact target SHA**, with unique successful build/publish jobs and matching attempt, successful digest/HTTPS verification steps, and one unambiguous actual log marker, can produce a `verified_public_pages_agent_observation` for trusted post-merge Acceptance. This cannot establish implementing-PR ownership, a trusted SC verdict on its own, or strong Run Store integrity. A truncated coverage window is explicitly marked truncated.

## Phase 2-C2 — truthful Issue/PR evidence deep links

The standalone Work list exposes refresh-safe static hash views at `#/work/issue/<number>` and `#/work/pr/<number>`. These only render **already bounded, schema-validated** records in the current generated public snapshot. Unknown or malformed IDs show an explicit unavailable view; they do not trigger a privileged browser API request or imply that the record does not exist. A local Issue view separates GitHub Timeline **cross-reference mentions** from pinned canonical Metrics Run/Attempt observations and always says `Implementation relationship: Unknown / Unlinked` and `PR linkage: Unlinked`. A local PR view independently displays current-HEAD Review, CI and E2E observations and always says the implementing Issue/Agent/Slice and trusted SC verdict are **not attested** by these independent records. No shared-number heuristic, public approval claim, provider session, auth token, orphan integrity assertion, or product Web UI dependency is added. These views are not the final authoritative #1664 causal producer contract; parent #1906 remains source-gated.

## Phase 2-C3 prerequisite — authenticated implementing PR receipt (upstream #1664)

The existing trusted result ingester first verifies GitHub Controller/worker Run/Attempt, signed dispatch/Outbox identity, exact PR HEAD and authorized `agent/issue-<issue>-` branch using GitHub REST. A **v2** `authenticated_agent_task_result` can preserve that already-verified `implementing_pr` as `repository`, `number`, `head_sha_at_attestation` and `relation=trusted_pr_head_at_result_attestation`; its other source/Agent/Action/Artifact identities retain their original types. A v1 result lacks this binding and remains **Unlinked**, not inferred. The v2 receipt does **not** attest a logical Slice ID, current PR HEAD after subsequent changes, trusted SC verdict, or remote Store integrity. For #1906 to project even this historical PR edge, the trusted `agent-store` producer/ingester and #1690 live write protections must first emit a **real source receipt** with independently checked provenance and exact SHA. Public Pages does not scan arbitrary orphan files or trust Issue comments as implementing-PR proof; no browser token or new writer is introduced.

## Phase 2-C4 — offline-first Lineage projection + pinned E2E evidence

The standalone public schema now has `work.lineage` (version 1, source coverage and per-edge source ref) and `work.acceptance_e2e` (bounded source-backed test outcomes). Their trust boundaries are intentionally distinct.

**Lineage**: `pages/scripts/lineage.mjs` accepts only a fully typed, authenticated-at-attestation historical producer receipt: Issue/PR, PR HEAD at attestation, developer/reviewer, agent identity, precise Run/Attempt, `action_id`, immutable source-ref SHA and writer receipt digest. The field `slice_id` remains null: a dispatch Action is not a logical Slice. A changed PR HEAD, mixed repository, missing writer source or ambiguous duplicate never produces a public verified edge. **The current public builder supplies no authenticated producer input, because live `agent-store` has not been provisioned or independently attested. Thus `lineage.status=unavailable`, and the UI must show Unknown / Unlinked.** A schema-valid v2 JSON or GitHub Timeline mention alone cannot authorize this join; a trusted pinned producer-source adapter is still required under #1664/#1690.

**E2E evidence, not an Acceptance verdict**: the trusted main-only Pages workflow checks out `acceptance-results` read-only, pins its exact Git SHA and passes it to `pages/scripts/acceptance-e2e.mjs`. The bounded (7-day / 110 run directories / 24 records) reader rechecks the canonical `issue_e2e_run` and trusted issue projection receipts at the exact PR HEAD, same Run/Attempt, plan/artifact digest, test IDs and real counters against **independent GitHub E2E / Tests and E2E / Test Ingest successful workflow Runs**. A missing GitHub entry, truncated window, drifted checkout, foreign repository, stale attempt, forged row or unsafe file never creates a per-ID Pass. The public projection contains only ID, Pass/Fail/Pending/Error, Issue, exact SHA, Run/Attempt and canonical GitHub link; it never exports the rich Issue readback, private project text or raw artifact. It distinguishes source `unavailable`, `truncated` and `available` with no observed matching entries. **An E2E Pass is not a trusted SC Acceptance Pass.** Actual SC results stay Unknown until a separate canonical, independently attested Acceptance SC reader exists.

The read-only projector and reader ship with deterministic positive/negative and mobile deep-link tests under `pages/tests` and `e2e/tests/browser`; no new producer, privileged browser API, App token, metrics writer, product `web/` dependency or store-integrity badge is introduced. Parent #1906 remains Open until real authenticated Producer/Slice/SC sources and final acceptance exist.

## Phase 2-C5 — GitHub workflow-scoped E2E source windows

In a busy repository, the first 100 *mixed* GitHub Actions Runs may contain no `E2E / Tests` or `E2E / Test Ingest` for the current sampled PRs, even when the pinned `acceptance-results` Store contains authentic exact-SHA per-ID receipts. The build now queries the **two workflow-specific** GitHub Actions Run windows independently (up to 100 each), pins their canonical workflow path/name/event/repository identity and deterministically rejects malformed or duplicate Run IDs. Both must be obtainable; a source API failure is **`unavailable`**, not an observed zero. Either window reaching 100 is marked `truncated` even if selected records are found. The pinned E2E reader checks the full bounded 100+100 identity set so a trusted Ingest at offset greater than 100 cannot disappear from verification. Test/result/plan/Artifact and source SHA correlation, safe public fields, no client token, and **E2E Pass ≠ Acceptance SC Pass** remain unchanged. An actual absence of matching *current PR HEAD* records continues to mean `not observed in this bounded window`; it is not proof of no tests. This work neither creates a source-backed Issue→PR→Agent causal edge nor claims audited orphan integrity.
