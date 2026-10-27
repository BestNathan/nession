# SC-01: read-only prototype push signal proof

The producer lives in the history-isolated `prototype` branch, not the normal main checkout.

The source-aligned `verify.cjs` reads that branch's **actual** `.github/workflows/prototype-changed.yml` bytes, compares them to the pinned audit baseline, and independently verifies the real push event identity/Run 40534958867. No untrusted workflow, script, mock page or artifact runs with write credentials.

At [Case Smoke Run 40538994676 attempt 2](https://github.com/BestNathan/nession/actions/runs/40538994676), exact PR HEAD `2afe1aaea24a0ad259fcf5e113b45de525a7f2ff`, this SC's runtime Case returned Pass, execution ID `d6d31d7260625dee42f3f780efd7f226bfad08b04fe1f3fac05e0374c7f5528d`. The Case result is supporting evidence for read-only Agent Acceptance, not a self-authorized Issue mutation.

The read-only Agent and trusted deterministic updater alone may project the final SC-01 result; no manual acceptance table edits, no skipped Gate. SC-03 has its own post-merge Case.
