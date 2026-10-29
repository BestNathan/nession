# 2319 / SC-04 — accepted-evidence Case

SC-04 does not re-run the staging Worker. It verifies the **trusted
Case/ingester records** for SC-02 and SC-03 on the append-only
`acceptance-results` branch:

- both records are `Pass` and every verifier carries non-empty evidence;
- `case_revision` equals the record's exact `target_sha`;
- the record has an exact `case_tree_sha` and canonical `execution_id`;
- both records share one `contract_sha256`;
- `provenance.verified_source.head_sha` equals the target SHA;
- each target SHA is an ancestor of this Case's target.

This is deliberately a two-phase proof. The staging push that first adds the
SC-02/SC-03 Cases cannot have their ingested records yet, so SC-04 is
`Pending` there. A later staging push whose merge SHA descends from that run
records SC-04 as `Pass`.

A manual `workflow_dispatch` replay of an older target is **not** an
alternative: `assertSourceBoundRecord` requires the Case target SHA to equal
the authenticated source `workflow_run.head_sha`, and a manual run's head is
the dispatching main SHA.

Missing records are always `Pending`, never a premature `Fail`.
