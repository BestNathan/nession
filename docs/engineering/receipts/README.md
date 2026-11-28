# Operational readback receipts

One-time sanitized evidence records that an operational precondition was met,
kept next to the executable owner that consumes them.

- `4588-tls-cutover-readback.json` — **not present.** It would prove the
  certificate/edge readiness that unblocks retiring Nession's legacy Cloudflare
  Origin CA TLS. Schema and gate:
  [`scripts/gitops-tls-contract.mjs`](../../../scripts/gitops-tls-contract.mjs)
  (run as the `gitops-tls-contract` Gate against the `gitops` branch).

  A first version was recorded on 2026-11-28 and withdrawn the same day: the
  cutover attempt it attested regressed the public staging MCP endpoint, because
  the Cloudflare origin hop reaches the Higress TLS listener without SNI and the
  chain that answers it only exists while the Ingress keeps both its `tls` block
  and `higress.io/ssl-redirect`. So `noRemainingConsumer` was not true, and the
  Gate must not be satisfied by a receipt that predates a verified cutover. The
  required ordering before a receipt may be recorded again is written in
  `environments/staging/mcp/ingress.yaml` on the `gitops` branch and in
  [`cloudflare-site-provisioning.md`](../cloudflare-site-provisioning.md).

- `4719-parallel-cutover-readback.json` — **not present.** It would prove the
  independently attested parallel public/private cutover: exact
  Nession/nsible/nitops/GitOps revisions, the actual HK/private paths, both TLS
  lifecycles and positive/negative protocol evidence, with
  `noRemainingConsumer: true`. Schema and validator:
  [`scripts/ci/site-registry/gateway-rollout.mjs`](../../../scripts/ci/site-registry/gateway-rollout.mjs),
  consumed by
  [`retire-origin-ca.mjs`](../../../scripts/ci/site-registry/retire-origin-ca.mjs).
  Missing, stale or mismatched receipts block Origin CA retirement; the
  prerequisite order and evidence checklist are in
  [`parallel-gateway-contract.md`](../parallel-gateway-contract.md). This entry
  is a Nession parent contract; #4588 still owns the actual hostname/TLS
  retirement.

Rules: receipts contain public facts only (revisions, gateway identity,
certificate serial/SAN/expiry, probe outcomes, Run/Attempt). Never record tokens,
private keys or sealed material. A receipt is a point-in-time attestation; when
the underlying state changes materially, supersede it with a new reviewed entry
rather than editing history silently. Rollback never requires deleting a receipt.
