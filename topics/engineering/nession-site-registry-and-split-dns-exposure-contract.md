---
title: "Nession site registry and split-DNS exposure contract"
description: "Private-by-default reviewed site registry, exact LAN AdGuard split-horizon DNS and MCP-only Cloudflare public exposure, parallel HK public/SLB private entrypoints with a pinned cross-repo policy and receipt-gated Origin CA retirement"
topic: engineering
categories: ["architecture", "security", "delivery", "registry", "workflows"]
status: verified
created_at: 2026-11-27T09:24:21Z
updated_at: 2026-11-28T11:02:45Z
sources: ["https://github.com/BestNathan/nession/blob/7f4d5fd5d55720627c98ff3b2934ea646b0280f5/docs/engineering/cloudflare-site-provisioning.md", "https://github.com/BestNathan/nession/blob/7f4d5fd5d55720627c98ff3b2934ea646b0280f5/scripts/ci/site-registry/registry.json", "https://github.com/BestNathan/nession/blob/7f4d5fd5d55720627c98ff3b2934ea646b0280f5/.github/workflows/deploy-configure-site.yml", "https://github.com/BestNathan/nession/issues/4589", "https://github.com/BestNathan/nession/pull/4678", "https://github.com/BestNathan/nession/issues/4588", "https://github.com/BestNathan/nession/issues/4719", "https://github.com/BestNathan/nession/blob/51b6d18a8d850384bda88e703aa466178cbc2537/docs/engineering/parallel-gateway-contract.md", "https://github.com/BestNathan/nession/blob/51b6d18a8d850384bda88e703aa466178cbc2537/scripts/ci/site-registry/gateway-policy.mjs", "https://github.com/BestNathan/nession/blob/51b6d18a8d850384bda88e703aa466178cbc2537/scripts/ci/site-registry/gateway-rollout.mjs"]
---

# Nession site registry and split-DNS exposure contract

## Decision

Owner-approved 2026-11-26 (#4589): every Nession service uses a first-level
`bestnathan.top` name resolved through LAN split-horizon DNS; **all
Server/Agent/UI sites are private by default**, and only the explicitly
approved existing standalone MCP sites (`staging-mcp`, `production-mcp`) may
be published to Cloudflare. CF Universal SSL is unchanged; origin HTTPS moves
to Let's Encrypt via cert-manager owned by nitops#2 / #4588. `nhome.local`
and unrelated `bestnathan.top` services are entirely out of scope.

One reviewed canonical registry on trusted main
(`scripts/ci/site-registry/registry.json`, validator/renderer
`site-registry.mjs`) owns site ID, environment, service, canonical
`env-service-nession.bestnathan.top` name (production env and server service
prefix omitted), visibility, enabled flag, exact backend/route identity, LAN
DNS target reference and public origin reference. The validator rejects
duplicates, multi-label canonical names, unknown environments/services and
any public non-MCP declaration. Editable desired hosts live only on the
gitops branch; the registry validates pinned GitOps state instead of writing
a second desired state.

## Context and evidence

- **Naming and migration interop.** Canonical names match #4588's contract
  (`nession`, `agent-nession`, `ui-nession`, `mcp-nession`,
  `staging-nession`, …). Each site records a reviewed `legacyFqdn` alias for
  the current nested GitOps host; the render comparison accepts `canonical`
  or `legacy` during migration and fails closed otherwise. LAN DNS
  registration separately requires the canonical host (`lan-readiness`), so
  no rewrite is created for a name the gateway cannot yet route. #4588 owns
  the GitOps host migration and legacy GitOps TLS objects; #4589 does not
  block it and made no GitOps writes.
- **Execution.** The existing `Deploy / Configure Site` workflow is extended
  (not duplicated per environment): fixed dispatch choices, main-only trust,
  path-scoped main-push and hourly read-only plan triggers (no bot-push
  dependency), shared DNS-authority mutation concurrency that never cancels
  in-flight runs, and plan/verify/apply/reconcile/delete modes. Apply
  authenticates the plan-receipt producer run and re-verifies source SHA,
  GitOps revision, registry hash and observed/desired state hashes before any
  mutation; stale plans fail closed. Cloudflare credentials are scoped to
  public-provider jobs; VPN/AdGuard credentials only to LAN jobs.
- **LAN DNS.** `configure-adguard-dns.mjs` performs exact AdGuard Home
  rewrite list/add/update/delete (update = delete+add) with independent
  readback. The registry is the durable reviewed managed-record inventory
  (expected domain + `LAN_GATEWAY_IP` answer); ownership is never inferred
  from suffixes or ephemeral artifacts. Matching unmanaged records stay
  untouched, conflicts fail closed, partial failure is observable per site
  without rolling back successful independent changes. Execution is solely
  through the protected main-owned job-scoped GOST/VPN
  (`site-dns-tunnel.sh`, #1616 ownership pattern) scoped to the validated
  AdGuard endpoint; there is no cluster DNS executor, CronJob, ExternalDNS or
  AdGuard credential in Kubernetes.
- **Public edge.** `edge-policy.mjs` + `edge-policy.fixture.json` are the
  reviewed allow/deny contract consumed by nitops#2: only approved enabled
  MCP hosts with exact `/mcp` pass; private/unknown Host/SNI (including
  direct-IP forced Host), alternate paths, spoofed forwarding identity and
  non-Cloudflare direct-origin sources are denied with no wildcard or
  private-route fallback. DNS absence, CF WAF alone and client headers are
  never the boundary.
- **Parallel entrypoints (#4719, owner decision 2026-11-28).** HK is the unified
  public entrance and the SLB the unified LAN/VPN entrance; they are parallel,
  never chained. `gateway-policy.mjs` renders/validates the versioned
  public/private/cluster policy from this registry: explicit owner per hop,
  eligible-vs-active public MCP split, exact registry paths, private and
  wildcard denial, no HK→SLB chain, no Higress business TLS and no public
  NodePort. A consumed artifact pins the exact reviewed Nession SHA; the
  checked-in `gateway-policy.fixture.json` is an unpinned contract template and
  literal addresses/URLs are rejected. Route fixtures that expose a
  private/disabled host, authorize a wildcard, insert an HK→SLB hop or depend
  on Higress TLS fail deterministically. `gateway-rollout.mjs` owns the
  independently attested cross-repository receipt (exact
  Nession/nsible/nitops/GitOps revisions; actual public/private path; both
  nitops certificate lifecycles; positive/negative MCP/WSS/SSE evidence; no
  remaining consumer). Docs owner:
  [Parallel public and private gateway contract](https://github.com/BestNathan/nession/blob/51b6d18a8d850384bda88e703aa466178cbc2537/docs/engineering/parallel-gateway-contract.md).
- **Approvals and retirement.** Sensitive operations (public activation,
  adoption, deletion, visibility transition, origin/gateway change, Origin CA
  retirement) require reviewed explicit approvals bound to the exact desired
  state and registry hash (`approvals.json`; staging-MCP activation recorded
  as #3963/#3992 lineage). `retire-origin-ca.mjs` gates removal of the
  `issue-tls` action and Origin CA implementation on recorded #4588 cutover
  readiness, zero remaining consumers **and** the independently attested
  cross-repository receipt; a missing, stale or mismatched receipt blocks
  retirement. Public DNS and the generic SealedSecret mechanism are preserved
  and retirement never republishes private DNS. `production-mcp` stays
  declared-but-disabled until #4529 prerequisites and a reviewed activation.
- **Proof boundary.** The `cloudflare-site-dns-selftest` Gate owns the
  deterministic registry/provider/edge/retirement/workflow suite (plus the
  Linux tunnel self-test); the `parallel-gateway-contract` Gate owns the
  entrypoint policy, route-fixture negatives and cross-repo receipt tests. PR
  green is not rollout: live provider readback and LAN/external probes are a
  separate SCN-04/07 operational gate; formal deployed Cases require
  deployment identity (#1616). Implementation PR #4678 at
  `7f4d5fd5d55720627c98ff3b2934ea646b0280f5`; no live provider writes were
  performed in that session.

## Related knowledge

- [Nession canonical hostname migration and cert-manager TLS consumption](nession-canonical-hostname-migration-and-cert-manager-tls-consumption.md) — #4588's delivered canonical hosts, single nitops cert-manager TLS consumption and receipt-gated legacy retirement this registry activates.
- [Nession GitHub Actions workflow domains and trust boundaries](../workflows/nession-github-actions-workflow-domains-and-trust-boundaries.md) — the Delivery-domain trust model this workflow extends.
- [Nession MCP access layer semantic tool ownership and protocol versions](nession-mcp-access-layer-semantic-tool-ownership-and-protocol-versions.md) — the standalone MCP endpoint whose public route this contract exposes.
- [Endpoint-owned Server and Agent tokens](endpoint-owned-server-and-agent-tokens.md) — MCP inbound and backend credentials remain separate identities.

## Limits / when to revisit

- GitHub Environment provisioning (LAN gateway/AdGuard variables and secrets,
  relay scope for the LAN environment, production CF credentials) is an
  operator action; names are contracted in the provisioning doc, values are
  never checked in or printed.
- The `staging` Environment had no server-side protection rules at
  implementation time; the workflow enforces main-only itself. Protection
  must never be weakened; hardening is an operator decision compatible with
  the retained staging deploy flow.
- The edge-policy and gateway-policy fixtures are contract artifacts, not live
  enforcement; nitops#2 owns the actual router/SLB configuration and
  certificate lifecycle, and nsible#1 owns the HK public gateway.
- #4719 live rollout/retirement evidence remains **Pending**: this source
  contract performs no host/cluster/Cloudflare/DNS/certificate/firewall change,
  records no cutover receipt and makes no `noRemainingConsumer` claim. Revisit
  when nsible#1 and nitops#17 produce authenticated path/TLS/protocol receipts,
  when #4588 retires the legacy path, or when the Origin CA retirement readiness
  is recorded.
- Revisit when #4588 completes the host migration (legacy aliases can then be
  pruned in a reviewed registry change) or when production MCP activation is
  approved.
