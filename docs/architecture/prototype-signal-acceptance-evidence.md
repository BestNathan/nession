# Prototype push signal — immutable pre-merge proof for Issue #2519 SC-01

## Evidence / truth boundary

The actual low-privilege producer is on the **orphan prototype branch**, not in main. Its file is [prototype-changed.yml at source SHA b929fe89321b4bcc74d76e889f5c56c359a274cf](https://github.com/BestNathan/nession/blob/b929fe89321b4bcc74d76e889f5c56c359a274cf/.github/workflows/prototype-changed.yml).

The producer defines exactly a `push` on `branches: [prototype]`; top-level `permissions: contents: read`; one job on ubuntu-24.04 containing an echo-only bash script, and no checkout, network fetch, actions/Pages write scope, secret use or source execution.

A source-aligned verifier was executed at PR SHA `2afe1aaea24a0ad259fcf5e113b45de525a7f2ff`:
- [Immutable source verifier source](https://github.com/BestNathan/nession/blob/2afe1aaea24a0ad259fcf5e113b45de525a7f2ff/e2e/acceptance/cases/2519/SC-01/verify.cjs). It fetched the orphan file from `raw.githubusercontent.com` at the current exact source SHA and asserted complete byte equality with the audited literal; also verified GitHub signal source Run.
- [Acceptance / Case Smoke Run 40538994676, attempt 2](https://github.com/BestNathan/nession/actions/runs/40538994676) executed `2519/SC-01` with result **Pass** at exact PR SHA `2afe1aaea24a0ad259fcf5e113b45de525a7f2ff`; logged authenticated `ACCEPTANCE_BATCH_RECEIPT_V1` with execution ID `d6d31d7260625dee42f3f780efd7f226bfad08b04fe1f3fac05e0374c7f5528d` and Case tree `1eab33c94b11a79f82654a3ddfe26b6df3f9211d`.
- [Prototype Push Signal Run 40534958867](https://github.com/BestNathan/nession/actions/runs/40534958867) completed successfully on the same orphan SHA, with event `push` and branch `prototype`.

**Why the current PR has no SC-01 Case manifest:** The repository's canonical Case selector requires every registered `case.yaml` to match `Acceptance Plan.method: case`; SC-01 is now `method: agent` because its **verification evidence has already been executed** and only a read-only, independently authenticated source/run audit remains. Keeping a formal `case.yaml` would be an invalid duplicate and fails `Acceptance / Case Smoke` selection. The prior exact-SHA source Case and its immutable Run remain reviewable in GitHub history.

The trusted Agent and deterministic Issue updater must still determine and project the SC-01 result. The successful historic Case run is evidence, **not** a manual Pass or bypass of the Issue's Acceptance gate. SC-03 remains `method: case`, `when: merged, branch: main`.
