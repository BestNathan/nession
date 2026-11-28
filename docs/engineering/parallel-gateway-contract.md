# Parallel public and private gateway contract (#4719)

Owner decision 2026-11-28: **HK is the unified public entrance and the SLB is
the unified LAN/VPN entrance.** The two gateways are parallel, not chained:

```text
Public:  Client -> Cloudflare -> HK (TLS + public ACL) -> WireGuard/gost
         -> Higress HTTP -> Service
Private: LAN/VPN Client -> AdGuard DNS -> SLB (TLS) -> Higress HTTP -> Service
Cluster: Service -> Service
```

Nession is the coordinating parent for this contract, not the owner of host,
cluster, DNS, firewall or certificate infrastructure. This document is the
canonical Nession engineering owner for the topology, ownership boundaries,
dependency/rollback order and operational evidence checklist. Live rollout
remains an authorized operator action under the parent issue and is **Pending**.

## Ownership

| Concern | Canonical owner | Executable / record |
|---|---|---|
| Site hostname, visibility, enabled flag, exact path | Nession | [registry.json](../../scripts/ci/site-registry/registry.json) validated by [site-registry.mjs](../../scripts/ci/site-registry/site-registry.mjs) |
| Cross-repository entrypoint/allowlist policy | Nession | [gateway-policy.mjs](../../scripts/ci/site-registry/gateway-policy.mjs) + [gateway-policy.fixture.json](../../scripts/ci/site-registry/gateway-policy.fixture.json) |
| HK public L7 listener, public ACL, direct private upstream | nsible | nsible#1 (HK listeners, TLS consumer, safe canary) |
| SLB TLS termination, cert-manager/ACME lifecycle | nitops | nitops#17 / nitops#2 (issuer, wildcard and HK public SAN delivery) |
| Higress Ingress enrollment and route/backend identity | Nession GitOps | `gitops` branch manifests; compared by [site-registry.mjs](../../scripts/ci/site-registry/site-registry.mjs) `compare` |
| Cloudflare origin and AdGuard answers | Protected GitHub Environment Variables/Secrets | `CLOUDFLARE_ORIGIN_IPV4`, `LAN_GATEWAY_IP`, `ADGUARD_*`; values never checked in |
| Cross-repository cutover evidence | Nession parent Issue | [gateway-rollout.mjs](../../scripts/ci/site-registry/gateway-rollout.mjs), receipt path below |
| Legacy hostname/TLS retirement | #4588 | [retire-origin-ca.mjs](../../scripts/ci/site-registry/retire-origin-ca.mjs) plus the cross-repo receipt requirement |

No second certificate or route owner is introduced. Nession installs no
cert-manager, issues no Certificate/Issuer and writes no competing TLS Secret.
HK and the SLB independently consume the nitops-managed certificate lifecycle;
the HK public certificate has a distinct private key and is never the LAN
wildcard key copied to the public host.

## Policy artifact and SHA pinning

`renderGatewayPolicy()` derives the public allowlist, private host set and
public/private/cluster hop ownership from the reviewed registry. The checked-in
`gateway-policy.fixture.json` is the reviewed **contract template** (it declares
`revision: null` and `revisionRequirement: exact-40-hex-at-consumption`); it must
never be consumed as a pinned artifact. A consumer generates the handoff with
the exact reviewed Nession commit:

```bash
SOURCE_SHA=<40-hex-reviewed-sha> node scripts/ci/site-registry/gateway-policy.mjs render
```

`verifyGatewayPolicyRevision()` rejects a missing, short or mismatched revision
and a policy whose registry content hash does not match the checked-in registry.
The artifact contains symbolic `CLOUDFLARE_ORIGIN_IPV4` / `LAN_GATEWAY_IP` /
`ADGUARD_*` references only; literal addresses and URLs are rejected.

Public activation is derived from **both** the reviewed allowlist and
`enabled: true`. `production-mcp` stays eligible but disabled until #4529 is
separately approved, so a public route fixture for it is rejected at HK despite
the allowlist entry. Wildcard Host authorization is never accepted; unknown,
private and disabled hosts have no fallback route.

Migrated Nession route fixtures are validated by `evaluateRouteFixture()`.
They are rejected when they expose a private/disabled host publicly, authorize a
wildcard, insert an HK->SLB hop, send HTTPS/443 or an Ingress `tls` block to
Higress, expose a public NodePort, or use a public upstream for the private
entrypoint. The public upstream is a verified reachable Higress private HTTP
NodePort (31693) or an equivalent private HA endpoint; the contract rejects
non-HTTP/TLS dependencies rather than pinning an unverified single node.

## Rollout and retirement receipt

A retirement of the legacy direct-TLS path is permitted only after the
authorized operator (or a separately authenticated Acceptance lane) records
[`docs/engineering/receipts/4719-parallel-cutover-readback.json`](receipts/README.md).
`validateCrossRepoReceipt()` requires:

- exact 40-hex `nession`, `nsible`, `nitops` and `gitops` revisions;
- the actual public path (Cloudflare -> HK -> Higress HTTP -> Service, with
  source enforcement and no HK->SLB chain) and private path (AdGuard -> SLB ->
  Higress HTTP -> Service, SLB TLS);
- both TLS lifecycles (nitops-owned HK public SAN with a key distinct from the
  SLB wildcard, nitops wildcard at the SLB) with serial/expiry/chain readback
  and authenticated Run identity;
- positive MCP initialize/tools-list, WSS 101/frames and SSE-beyond-60s evidence,
  and negative unauthorized source, forged forwarding, unknown/private host,
  SNI mismatch and alternate-path evidence from an independent attestation;
- `noRemainingConsumer: true`, no query credentials in logs, approver and date.

`retire-origin-ca.mjs` consumes this validator. Retirement is blocked when the
receipt is missing, structurally invalid, or stale/mismatched against the
reviewed revisions or the #4588 readiness record. #4588 remains the hostname/TLS
retirement owner; #4719 adds prerequisites and never performs the retirement
itself. `noRemainingConsumer` must not be attested while the old ingress is
still load-bearing.

## Dependency and rollback order

Both infrastructure children may inventory and prepare in parallel. The
operational order is:

1. **Inventory.** Sanitized HK/cluster/LAN state, actual Cloudflare origin (do
   not assume a public IP), source/NAT addresses, unrelated hosts and the health
   baseline. No mutation.
2. **Prepare and test off-path.** Restricted Higress trust and HTTP canary,
   distinct HK certificate delivery, candidate vhost. Probe from HK/LAN with
   forced Host/SNI without switching live traffic: HTTPS scheme recognition, no
   308 loop, authenticated MCP initialize/tools/list, WSS 101/frames, SSE beyond
   the 60s default with negotiated heartbeat; deny unauthorized source, forged
   headers, unknown/private hosts, Host/SNI mismatch, `/`, `/mcp/`, `/api`; no
   sensitive query strings in logs.
3. **Activate and cut over.** Approved HK route and DNS/NAT change (Cloudflare
   Full strict scoped to MCP). Preserve the old route/certificate until external
   and LAN probes prove the new path with correlated request IDs and no old-path
   consumption. Never make simultaneous unverified changes.
4. **Retire legacy TLS.** Only after step 3 is verified: record the cross-repo
   receipt, then retire the legacy direct-TLS path and staging Origin CA in
   #4588, including sealed TLS/redirect/issuance, with no remaining consumer.
   The bypass path is closed without breaking unrelated services.
5. **Verify broadly.** All 12 LAN canonical sites (dormant only if deployed),
   per-node certificate trust/renewal, public positive/negative behavior,
   `nhome.local` and unrelated services; capture exact SHAs/config fingerprints,
   deployment identities, redacted probe receipts and rollback result.

Rollback restores route/DNS/config desired state only. It never rolls back
cert-manager, deletes a shared Secret, restarts gost/WireGuard outside a
separately approved maintenance window, or changes unrelated ingress redirect/TLS
semantics globally. Canary first; HK must not depend on the SLB.

## Operational evidence checklist

All items below are **Pending** until an authorized operator produces the
authenticated receipts; a green PR or merge is not a rollout.

- [ ] Sanitized inventory of HK listeners/`nginx -T`/firewall/NAT and LAN
      gateway state, plus the actual Cloudflare origin.
- [ ] Off-path public/private probes: scheme, no 308 loop, MCP authenticated
      initialize/tools/list, WSS frames, SSE > 60s, and all negative source /
      header / host / path cases.
- [ ] HK public SAN certificate and SLB wildcard certificate readback (serial,
      expiry, chain, distinct keys) on every serving node.
- [ ] Activated HK route and DNS/NAT cutover with correlated request IDs and no
      old-path consumption.
- [ ] Cross-repository receipt recorded at the exact pinned revisions.
- [ ] #4588 retirement executed only after the receipt; `noRemainingConsumer`
      true.
- [ ] All 12 LAN canonical sites (dormant only if deployed), `nhome.local` and
      unrelated services verified; rollback result recorded.
- [ ] Production MCP remains dormant until #4529 is separately approved.

## Scope and non-goals

- No host/cluster/Cloudflare/DNS/certificate/firewall change is made by this
  repository contract; no live rollout or production mutation.
- `nhome.local` and legacy names are unchanged until verified retirement.
- No Nession Certificate/Issuer or second certificate lifecycle.
- #4588 remains hostname/TLS retirement owner; #4589 remains registry
  implementation history; #4529 remains the separate production-activation
  approval. The parent Issue #4719 stays open until linked work and operational
  gates complete.

Executable contract: `parallel-gateway-contract` Gate
([checks/parallel-gateway-contract.sh](../../gates/checks/parallel-gateway-contract.sh)).
