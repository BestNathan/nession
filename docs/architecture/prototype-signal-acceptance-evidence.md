# Prototype push signal — immutable pre-merge proof for Issue #2519 SC-01

## Evidence / truth boundary

The actual low-privilege producer is on the **orphan prototype branch**, not in main. Its file is [prototype-changed.yml at source SHA b929fe89321b4bcc74d76e889f5c56c359a274cf](https://github.com/BestNathan/nession/blob/b929fe89321b4bcc74d76e889f5c56c359a274cf/.github/workflows/prototype-changed.yml).

The producer defines exactly a `push` on `branches: [prototype]`; top-level `permissions: contents: read`; one job on ubuntu-24.04 containing an echo-only bash script, and no checkout, network fetch, actions/Pages write scope, secret use or source execution.

A source-aligned verifier was executed at PR SHA `2afe1aaea24a0ad259fcf5e113b45de525a7f2ff`:
- [Immutable source verifier source](https://github.com/BestNathan/nession/blob/2afe1aaea24a0ad259fcf5e113b45de525a7f2ff/e2e/acceptance/cases/2519/SC-01/verify.cjs). It fetched the orphan file from `raw.githubusercontent.com` at the current exact source SHA and asserted complete byte equality with the audited literal; also verified GitHub signal source Run.
- [Acceptance / Case Smoke Run 40538994676, attempt 2](https://github.com/BestNathan/nession/actions/runs/40538994676) executed `2519/SC-01` with result **Pass** at exact PR SHA `2afe1aaea24a0ad259fcf5e113b45de525a7f2ff`; logged authenticated `ACCEPTANCE_BATCH_RECEIPT_V1` with execution ID `d6d31d7260625dee42f3f780efd7f226bfad08b04fe1f3fac05e0374c7f5528d` and Case tree `1eab33c94b11a79f82654a3ddfe26b6df3f9211d`.
- [Prototype Push Signal Run 40534958867](https://github.com/BestNathan/nession/actions/runs/40534958867) completed successfully on the same orphan SHA, with event `push` and branch `prototype`.

**Current proof stage:** SC-01 is now `when: merged, branch: main, method: case`, because this source-and-run security guarantee must be projected through the trusted, main-owned source-aligned Case Ingest pipeline. PR Case Smoke is evidence-only; it cannot mutate the Issue and the read-only PR Agent does not receive historical orphan-run receipts in its authenticated evidence set. A Case registered as `stage: post-merge` is correctly selected by the canonical main-push selector, and its result remains Pending until real main SHA execution and independent authenticated ingest.

The original PR-head Case Smoke Pass above is historic diagnostic evidence only. It does not satisfy the new post-merge Case's contract or waive its execution. Both SC-01 and SC-03 must be proven and automatically projected against main before Issue #2519 closure.
