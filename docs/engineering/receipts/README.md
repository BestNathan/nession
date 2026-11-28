# Operational readback receipts

One-time sanitized evidence records that an operational precondition was met,
kept next to the executable owner that consumes them.

- `4588-tls-cutover-readback.json` — proves the certificate/edge readiness that
  unblocks retiring Nession's legacy Cloudflare Origin CA TLS. Schema and gate:
  [`scripts/gitops-tls-contract.mjs`](../../scripts/gitops-tls-contract.mjs)
  (run as the `gitops-tls-contract` Gate against the `gitops` branch).

Rules: receipts contain public facts only (revisions, gateway identity,
certificate serial/SAN/expiry, probe outcomes, Run/Attempt). Never record tokens,
private keys or sealed material. A receipt is a point-in-time attestation; when
the underlying state changes materially, supersede it with a new reviewed entry
rather than editing history silently. Rollback never requires deleting a receipt.
