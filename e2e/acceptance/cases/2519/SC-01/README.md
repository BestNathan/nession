# SC-01 / post-merge authenticated source boundary

The normal checked-out main tree cannot itself contain the orphan producer. This real Runtime Case retrieves the current `prototype` branch head and `.github/workflows/prototype-changed.yml` from approved read-only GitHub public endpoints and compares its **actual bytes** to an audited workflow with exactly `push:prototype`, `contents:read`, one echo-only signal job, and no checkout/secrets/publish privileges.

It independently validates [Prototype Signal Run 40534958867](https://github.com/BestNathan/nession/actions/runs/40534958867). A future prototype source commit must descend from that immutable signal witness.

Execution is deliberately **post-merge/main**. The canonical `Acceptance / Cases` main workflow creates an exact-SHA Case record and the trusted `Acceptance / Case Ingest` alone may update Issue #2519. The prior [pre-merge Case Smoke Run 40538994676 attempt 2](https://github.com/BestNathan/nession/actions/runs/40538994676) is useful background, not substitute Case acceptance. See [decision and history](../../../../../docs/architecture/prototype-signal-acceptance-evidence.md).
