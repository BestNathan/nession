---
title: "Nession canonical hostname migration and cert-manager TLS consumption"
description: "Canonical single-label bestnathan.top hostnames, single nitops-owned cert-manager wildcard TLS consumed at the SLB, fail-closed advertised-endpoint and browser-origin config, and receipt-gated legacy Origin CA retirement"
topic: engineering
categories: ["architecture", "security", "delivery", "identity"]
status: verified
created_at: 2026-11-27T09:36:15Z
updated_at: 2026-11-28T09:24:45Z
sources: ["https://github.com/BestNathan/nession/issues/4588", "https://github.com/BestNathan/nession/pull/4677", "https://github.com/BestNathan/nession/pull/4679", "https://github.com/BestNathan/nession/pull/4716", "https://github.com/BestNathan/nession/pull/4717", "https://github.com/BestNathan/nession/blob/ab01fa680a2ce65167d65a811f1665bec36b7e78/scripts/gitops-host-contract.mjs", "https://github.com/BestNathan/nession/blob/ab01fa680a2ce65167d65a811f1665bec36b7e78/scripts/gitops-tls-contract.mjs", "https://github.com/BestNathan/nession/blob/ab01fa680a2ce65167d65a811f1665bec36b7e78/deploy/entrypoint-agent.sh", "https://github.com/BestNathan/nession/blob/adbf6b66260673bb4b80cd415039d651a2d08573/docs/engineering/cloudflare-site-provisioning.md", "https://github.com/BestNathan/nession/issues/4678"]
---

# Nession canonical hostname migration and cert-manager TLS consumption

## Decision

Owner-approved 2026-11-26 (#4588): every existing Nession Server/Agent/UI site
has a **canonical single-label** `bestnathan.top` host, and publicly trusted TLS
is consumed from a **single nitops-owned cert-manager wildcard** at the actual
termination point — not from a Nession-issued Origin CA certificate at Higress.

Canonical names (`env-service-nession`, production omits the env and server
prefix; suffix `.bestnathan.top`):

| env | server | agent | ui | mcp |
|---|---|---|---|---|
| production | `nession` | `agent-nession` | `ui-nession` | `mcp-nession` (dormant) |
| staging | `staging-nession` | `staging-agent-nession` | `staging-ui-nession` | `staging-mcp-nession` (active) |
| staging-01 | `staging-01-nession` | `staging-01-agent-nession` | `staging-01-ui-nession` | — |
| preprod | `preprod-nession` | `preprod-agent-nession` | `preprod-ui-nession` | — |

`nhome.local` hosts and their manual AdGuard records are preserved verbatim. The
nested `<env>.nession.*` names are retained as LAN compatibility during migration
and retired only after cutover readback. Visibility is consumed from the sibling
site-registry contract (#4589): Server/Agent/UI private in every lane; only the
existing MCP sites may be public, exact `/mcp`, authenticated.

**Certificate ownership is single and external to Nession.** nitops
(BestNathan/nitops#2) owns cert-manager, the DNS-01 ClusterIssuer and the one
wildcard Certificate `*.bestnathan.top` in the serving `slb` namespace; the
target Secret is owned exclusively by cert-manager. SLB nginx is the actual
client-facing TLS terminator and forwards HTTP to Higress — ingress TLS is not
assumed to be the effective client-facing certificate. Nession installs no
cert-manager, issues no second wildcard, and writes no competing
Certificate/Issuer/SealedSecret. Cloudflare Universal SSL still terminates public
client TLS at the edge.

## Context and evidence

- **Baseline.** GitOps `base/nession/ingress-*` and the staging/staging-01/preprod
  `patch-ingress.yaml` declared nested `bestnathan.top` names plus parallel
  `nhome.local` names. Staging MCP was already canonical and active with legacy
  Higress Origin CA TLS (`environments/staging/mcp/sealed-tls.json` →
  `nession-mcp-staging-tls`); the production MCP ingress existed with the
  canonical host but stayed **unenrolled/dormant** (#4529).
- **Desired-state migration (gitops PR #4677, base `gitops`).** Canonical hosts
  added to base/env ingress with matching `higress.io/domain` and correct
  `nameSuffix` backends; `SERVER_ALLOWED_ORIGINS` extended with **HTTPS-only**
  canonical origins (the actual TLS edge redirects HTTP→HTTPS for the new names);
  `AGENT_ADVERTISE_URLS` advertises the canonical WSS agent endpoint alongside the
  preserved `nhome.local` `connect_url`. No TLS object change, no dormant
  activation, no image-promotion change.
- **Application hardening (main PR at `ab01fa680a2ce65167d65a811f1665bec36b7e78`).**
  `AgentConfig::validate` fails closed on a non-`ws`/`wss`, hostless or
  credentialed `connect_url` / `advertise_addresses[].url`;
  `deploy/entrypoint-agent.sh` projects `AGENT_ADVERTISE_URLS` to
  `[[advertise_addresses]]` and an integration test feeds the real projection to
  the real parser. The Web client derives its socket scheme from the page
  (`https:`→`wss`, `http:`→`ws`) through one pure helper and never rewrites
  candidate schemes. Server WS origin-policy and MCP Host/Origin/exact-`/mcp`
  exact-head tests accept the canonical hosts and refuse unauthorized
  origins/hosts; credentials and auth are unchanged (no cookie auth exists; CORS
  is the Origin allowlist).
- **Executable contract owners.** `scripts/gitops-host-contract.mjs`
  (`gitops-host-contract` Gate, SC-01) renders the gitops tree and proves canonical
  hosts, backends, preserved `nhome.local`, canonical HTTPS/WSS config and dormant
  MCP. `scripts/gitops-tls-contract.mjs` (`gitops-tls-contract` Gate, SC-03) proves
  no competing issuer/Certificate/cert-manager or duplicate Secret writer, and
  **blocks legacy TLS retirement / consumption switch until a sanitized cutover
  readback receipt is recorded** (GitOps revision, actual gateway identity,
  certificate serial/expiry/chain, run/attempt; no key material). Rollback restores
  route/config desired state only; it never rolls back cert-manager or deletes
  shared Secrets. Both Gates have positive/negative self-test fixtures.
- **Ownership split.** #4588 owns the GitOps host migration and legacy GitOps TLS
  objects; #4589 owns the site registry, DNS providers and the `issue-tls`
  workflow/script retirement (gated on the same cutover readiness). nitops owns
  issuer/SLB/router changes. The canonical names match the reviewed registry in
  #4678.
- **Merged (2026-11-27).** GitOps desired state PR 4677 → gitops merge
  `c4e58e7ded747f6b9d97e206b902a0fdb3a59708`; main application/config + Gates + docs
  PR 4679 → main merge `adbf6b66260673bb4b80cd415039d651a2d08573`. SC-01/02/03
  projected **Pass** at the PR stage (SCN-01). The reviewed site registry (#4678)
  also landed on main; `scripts/ci/site-registry/registry.json` is now the
  canonical site-identity owner. The merged `cloudflare-site-provisioning.md`
  carries a focused "cert-manager TLS consumption (#4588)" section linking these
  executable owners. This is preparation only — no DNS activation, TLS switch or
  retirement was executed.

## Related knowledge

- [Nession site registry and split-DNS exposure contract](nession-site-registry-and-split-dns-exposure-contract.md) — the private-by-default registry, split-horizon DNS and MCP-only public exposure that activates these hosts.
- [Nession GitHub Actions workflow domains and trust boundaries](../workflows/nession-github-actions-workflow-domains-and-trust-boundaries.md) — the Delivery-domain trust model for the site and GitOps writers.
- [Nession MCP access layer semantic tool ownership and protocol versions](nession-mcp-access-layer-semantic-tool-ownership-and-protocol-versions.md) — the authenticated standalone MCP endpoint behind the canonical MCP hosts.
- [Endpoint-owned Server and Agent tokens](endpoint-owned-server-and-agent-tokens.md) — credentials remain separate identities, unchanged by the hostname/TLS migration.

## Limits / when to revisit

- **nitops#2 infrastructure is implemented and live-verified.** cert-manager +
  DNS-01 ClusterIssuers + the wildcard Certificate are merged (nitops PRs #3–#14);
  Certificate Ready with Let's Encrypt YR2 `*.bestnathan.top`; all four SLB nodes
  serve it under ordinary public trust (`Verify return code: 0`), and the
  cert-reloader log shows a validated rotation (`05D4C56E…` → `069F7B1E…`) with
  `nginx -t`, graceful reload and served-serial readback. `nhome.local` still serves
  its own cert. GitHub checkboxes lagged this state; the cluster was the source of
  truth.
- **The staging retirement was attempted and reverted on 2026-11-28** (gitops
  `274f8f03f` → restored by `efa0f1580`/`9ae33efc9`; nitops `2a6fe785d` → reverted by
  `b3cb4d22b`). Two measurements, both contradicting the documented assumption that
  the SLB is the only client-facing terminator, drove the rollback:
  1. The **Cloudflare origin for the staging MCP record is port-forwarded straight to
     the Higress TLS listener and arrives without SNI** (gateway access log
     `requested_server_name "-"`, `response_flags NR`, `route_not_found`). The chain
     answering that hop exists only while the Ingress keeps **both** `tls:` and
     `higress.io/ssl-redirect`, so removing the Origin CA material 404s the public
     endpoint (observed outage ~25–30 min, staging MCP only).
  2. With the SLB→Higress `:443` hop introduced to stop the LAN 308 loop, **LAN
     WebSocket upgrades to canonical hosts that have no `tls` block return 404**
     while the same upgrade over the plaintext `:80` hop returns 101.
- **Corrected prerequisite order before `sealed-tls.json` can be retired** (recorded in
  the `gitops` manifest header and `docs/engineering/cloudflare-site-provisioning.md`):
  (1) Higress trusts exactly one forwarded hop; (2) the Cloudflare record for this
  host is repointed to the nitops router, which terminates TLS with the cert-manager
  wildcard, sends SNI and verifies the SLB; (3) the SLB bestnathan hop returns to
  plaintext `:80` with `X-Forwarded-Proto https`; (4) only then remove
  `tls:`/`ssl-redirect`, retire the SealedSecret, and record the
  `tls-cutover-readback` receipt. A receipt whose `noRemainingConsumer` is not yet
  true must not be recorded — the first one was withdrawn (main `55b915867`).
- Formal deployed acceptance (authorized LAN/public probe lanes, production MCP
  activation) remains Pending and requires the #1616 identity lane. A green PR is not
  a rollout, and a merged PR is not a verified cutover: only live probes after each
  hop change are.
- The hostname checker encodes the canonical contract directly; the reviewed site
  registry (#4678) has since landed on main. A future refinement can consume
  `scripts/ci/site-registry/registry.json` for site identity, keeping one source
  of canonical names; the checker's nhome.local/dormancy/backend/config assertions
  remain its distinct SC-01 responsibility.
