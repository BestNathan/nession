# E2E Run Record evidence retention and digest scopes

## Trusted storage

Nession maintains **one append-only orphan branch**, `acceptance-results`, for compact trusted Case and Scenario records. The source code and Scenario/Case manifests remain in the product Git history. Only the **main-controlled** ingestion workflows can create results or update Issue/SC Acceptance Reports.

The source workflow is always checked against its GitHub-owned identity: repository, workflow path and ID, SHA, branch, event, run ID and attempt; the trusted ingest fetches the actual source Git tree before appending. A checksum of attacker-supplied JSON alone is never an attestation of its producer.

## Finite artifact retention contract

| Mode | Compact immutable record | External source artifact | Retention |
| --- | --- | --- | --- |
| Acceptance Case | `runs/YYYY-MM-DD/RUN-ATTEMPT/ISSUE/SC.json` | `acceptance-case-results-RUN-ATTEMPT` | 90 days |
| Terminal Scenario | `runs/YYYY-MM-DD/RUN-ATTEMPT/scenario/NAME-INDEX.json` | `e2e-terminal-scenario-RUN-ATTEMPT` | 14 days |

The trusted receipt `evidence` attached to newly ingested records declares **schema_version=1, mode, provider, artifact_name, sha256, digest_scope, retention_days, retrieval_url and durability**. The scope of `sha256` is **validated-source-record-json**, which is the canonical source record fed into the ingestor; it **is not the binary digest of the GitHub artifact ZIP**. The immutable record and its validated checksum remain in the orphan history even after the source artifact expires, subject to repository retention/access policy. Raw browser traces, screenshots, video and full terminal output are **not archived permanently** by this design.

The bounded receipt generator verifies run ID/attempt, full 64-character source record SHA-256, and a GitHub Actions URL belonging to the same authenticated run. Modes have fixed artifact prefixes and retention days. A changed digest, URL, attempt, retention or unexpected envelope field is rejected. Legacy records without the new evidence envelope remain readable; they do not gain retroactive retrieval promises.

## Limits and negative cases

- A GitHub Actions success status or GitOps branch push is **not** proof that an actual VPN-connected deployment was ready.
- A time-limited Actions artifact can expire; its `retrieval_url` is a locator rather than evidence that bytes still exist.
- The Scenario `evaluation=null` is an observation. No Scenario collection step may generate a fabricated Acceptance Pass.
- A Case `Pass` requires its own trusted Issue/SC contract, exact source SHA and verifier evidence, followed by the deterministic updater.
- Missing eligible Case coverage must fail closed; a stage with no eligible SCs is separately classified `not-applicable`, never a Case Pass.
- Collision/replay/idempotency behavior is independently gated by the trusted orphan ingestion fixtures. Do not replace a record on divergent bytes.
- Long-term large artifact archival requires a **separately approved object storage policy**, object checksum, access controls, expiry and deletion audit; it is *not implemented* by this receipt contract.

The executable contract is `scripts/run-record-artifact-evidence.mjs`, self-tested by the mandatory Quality Gate and used by the two main-owned ingestion programs. The source workflow retention durations must remain synchronized with these exact contract values.

## Test Run ingestion (main-owned)

The `E2E Test Run Ingest` workflow is a **separate, main-owned, write-token-only** consumer of completed successful `E2E Tests` **push** runs on `staging` or `main`. It does not execute any source PR code and deliberately rejects `pull_request` or `workflow_dispatch` events because a synthetic merge checkout cannot independently prove the PR head. The trusted ingest script re-fetches GitHub's source workflow, run metadata, successful `e2e` Job, exact source commit tree (`e2e/tests/browser`), and the `playwright-report` artifact receipt. It rejects wrong workflow/repository/SHA/branch, failed/ambiguous Jobs, absent or expired artifacts, and invalid SHA-256 digests.

It appends compact, immutable `test` mode Run metadata at `acceptance-results:runs/<UTC-day>/<run-id>-<attempt>/test/playwright.json` with a versioned `indexes/by-sha/<sha>/test/...` entry. The trusted single-writer concurrency group is shared with Acceptance and Scenario ingestion. A divergent retry fails instead of overwriting data; matching bytes are idempotent. These Test records contain only an exact SHA, workflow/Job success facts, source tree identity, execution digest, and the artifact ID, SHA-256, size and expiration. They deliberately do **not** include raw browser output or a fabricated Acceptance verdict (`evaluation: null`). GitHub Actions artifacts are time-limited (the E2E workflow currently uses 7-day report retention), not permanently archived by this mechanism. Benchmark producer ingestion is a separate future capability; the shared versioned index schema merely reserves that mode.

**Gate:** this workflow only becomes active after the trusted source is on GitHub's default `main` branch. A staging code merge alone is not proof of actual Test record ingestion. A stage-specific source Case must independently verify a completed post-deployment push run, both immutable orphan files, and the authentic source artifact checksum before marking the relevant SC Pass.


## Issue-centric selected PR E2E and immutable Issue projections

This selected PR path is **distinct** from the successful full-suite push ingestion above. Only files at `e2e/tests/**/*.spec.ts` are selectable: the basename before `.spec.ts` is the stable E2E ID. Each linked Issue explicitly declares `New` and `Regression` IDs in `## E2E Verification`. The authenticated source plan takes the de-duplicated union of all linked Issue obligations and any changed Spec IDs; there is no static source-code→E2E mapping. GitHub Actions invokes `./e2e/run test --id <ID>` for each selected ID. Staging push still runs the complete Playwright regression suite.

An Issue declaring `New: none` and `Regression: none` remains a *validated participant*, but owns **no selected ID** and must not receive a synthetic empty E2E Report PATCH or projection receipt. The selection plan preserves full Issue attribution: the same test executes once even when two Issues own that ID.

For selected PR runs, Playwright JSON plus a separate runtime assertion reporter is independently checked. A Pass needs actual discovered tests, complete non-flaky and non-skipped execution, and at least one verified executed assertion. Absent or conflicting evidence, missing test IDs, zero assertions, Skip or Flaky cannot become Pass. A source E2E workflow can therefore fail while still generating authentic per-ID Fail/Pass results.

The privileged, default-main-owned `E2E / Test Ingest` handles **completed success or failure** selected PR source runs. It verifies GitHub workflow identity, exact HEAD SHA, Run ID/Attempt, source Spec catalog, Issue contracts, selection plan and original report/artifact digest before persisting `acceptance-results:runs/YYYY-MM-DD/<source-run>-<attempt>/test/issue-e2e.json`. For each actual E2E owner it may PATCH the Issue's `## E2E Report`, independently GET the updated Issue, then append a bounded, immutable `test/projections/<issue>.json` in the *same* Run Store. The receipt binds Issue ID, source Run/Attempt, SHA, Issue declaration digest, Plan Digest, artifact digest, per-ID verdicts, trusted Ingest Run ID/Attempt and the full read-back body SHA-256. `outcome=applied` requires the real PATCH and GET; `outcome=recovered` means a previous identical projection was found and does **not** claim a new PATCH.

Read-only SC Acceptance may use a historical projection only after independently joining the source GitHub Run, PR commit list, exact SHA and verified plan, protected Run Store record/receipt, and a **completed successful** main-owned Ingest workflow and privileged projection job. A source Playwright artifact, mutable Issue comment, failed Ingest or `recovered` receipt alone is never positive historical PATCH proof. For old closed/unmerged test-only PR runs without `applied` receipts, exclude the run from positive Issue-mutation evidence; malformed *present* receipts remain hard failures. Do not rewrite, force-push or collapse previous Fail and Pass receipts.

### Executed two-owner Fail → Pass proof (2026-10-14)

The closed **unmerged** test-only [PR #1775](https://github.com/BestNathan/nession/pull/1775) associated owning Issues #1702 and #1776 with `login`; #1702 alone also required `session-lifecycle`. Linked #1759/#1772 both declared `none`, so they correctly received no empty projection.

| Phase | Exact source HEAD | Source E2E | Main-owned Ingest | Authenticated outcomes |
| --- | --- | --- | --- | --- |
| Controlled Fail | `92838abca9ee9fe4f0a4bcde91071ff111d72fcc` | [38556580416](https://github.com/BestNathan/nession/actions/runs/38556580416) (expected workflow failure) | [38557400411](https://github.com/BestNathan/nession/actions/runs/38557400411) (success) | `login=Fail` for both owners; `session-lifecycle=Pass` |
| Corrected Pass | `ac601555c1de69e66b7d9cf2da73fe4971862230` | [38557570973](https://github.com/BestNathan/nession/actions/runs/38557570973) (success) | [38558355729](https://github.com/BestNathan/nession/actions/runs/38558355729) (success) | `login=Pass` for both owners; `session-lifecycle=Pass` |

Independently fetched immutable `applied` receipt blobs, one per Issue and source Run:

| Phase | #1702 projection blob SHA | #1776 projection blob SHA |
| --- | --- | --- |
| Fail | `37b7542a08b3bae5524dd18d96f4cff3a7b749db` | `f2d72afad3fd8082f521702afd1287ada294a48f` |
| Pass | `7e26b8172f066491f0943086220e320db6421eb9` | `f74782c82fa28739fe9fc167f12670b653e022ba` |

The paths are `runs/2026-10-14/{38556580416-1,38557570973-1}/test/projections/{1702,1776}.json` on `acceptance-results`. The corrected Pass did not erase the earlier Fail evidence. Both outcomes were separately read back from the live GitHub Issue reports. This is evidence for the trusted Acceptance evaluator, **not** an instruction to manually approve SCs or waive final merge gates.
