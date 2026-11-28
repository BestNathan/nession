# Protected site registry and split-DNS configuration (#4589)

This operator-owned [Deploy / Configure Site](../../.github/workflows/deploy-configure-site.yml)
workflow reconciles the reviewed Nession site registry: **private-by-default LAN
split-horizon DNS** for every enabled site and **MCP-only public Cloudflare DNS**
for the explicitly approved allowlist. It extends the original #3963/#3992
staging-MCP provider; the Cloudflare client is not duplicated.

Ownership boundaries:

- **#4589 (this contract)** owns the canonical registry, visibility policy,
  provider adapters, edge-policy fixtures, the Origin CA retirement gate and
  workflow/script removal plus this documentation.
- **#4588** owns the GitOps ingress host migration to the canonical names and
  cert-manager TLS consumption, including legacy GitOps TLS object retirement.
- **nitops#2** owns cert-manager, the DNS-01 issuer and actual edge/router
  enforcement. The edge-policy fixture here is a reviewed contract artifact,
  not a live router configuration.

DNS success does not prove external HTTPS, MCP authentication, or Argo CD
reconciliation. PR green is not rollout: live provider readback and LAN/external
probes are a separate operational gate (SCN-04/07) requiring authorized
operator execution and, for formal deployed Cases, deployment identity (#1616).

## Canonical registry

[scripts/ci/site-registry/registry.json](../../scripts/ci/site-registry/registry.json)
is the single reviewed owner of site identity. The validator
([site-registry.mjs](../../scripts/ci/site-registry/site-registry.mjs)) rejects
duplicates, multi-label canonical names, unknown environments/services, wrong
backend/route identity and any public non-MCP declaration.

Naming: `env-service-nession.bestnathan.top`, omitting the production environment
prefix and the server service prefix (`nession`, `agent-nession`, `ui-nession`,
`mcp-nession`, `staging-nession`, `staging-agent-nession`, …). Each site records
its canonical `fqdn`, a reviewed `legacyFqdn` migration alias (or `null`),
visibility, enabled flag, backend service/port, exact route policy, and the
GitOps manifest that declares its hosts.

- All Server/Agent/UI sites are **private**, including staging-01/preprod.
- Only `staging-mcp` and `production-mcp` are in the public allowlist.
  `production-mcp` is declared but **not enabled**: its ingress is not enrolled
  (#4529 pilot); activation requires a reviewed registry change, ingress
  enrollment and an explicit approval.
- `nhome.local` and unrelated `bestnathan.top` services are entirely out of
  scope and preserved.

The render comparison validates pinned GitOps state against the registry.
During the #4588 migration a site may legitimately still declare its reviewed
legacy alias (`legacy` status); anything else fails closed. **LAN DNS
registration requires the canonical host** (`lan-readiness`), so a rewrite is
never created for a name the gateway cannot yet route. Editable desired hosts
live only on the gitops branch; the registry never writes a second desired
state.

## cert-manager TLS consumption (#4588)

Publicly trusted TLS for `*.bestnathan.top` is owned by nitops
(BestNathan/nitops#2): cert-manager, the DNS-01 ClusterIssuer and the single
wildcard Certificate in the serving `slb` namespace; the target Secret is owned
exclusively by cert-manager. SLB nginx is the actual client-facing TLS terminator
and forwards HTTP to Higress — ingress TLS is not assumed to be the effective
client-facing certificate. Nession installs no cert-manager, issues no second
wildcard and writes no competing Certificate/Issuer/SealedSecret; it consumes the
certificate through host/SAN coverage at SLB. Cloudflare Universal SSL still
terminates public client TLS at the edge.

The legacy staging MCP Higress Origin CA TLS
(`environments/staging/mcp/sealed-tls.json` → `nession-mcp-staging-tls`) is
retired, and any consumption switch made, only after a sanitized cutover readback
receipt is recorded (GitOps revision, actual gateway identity, certificate
serial/expiry/chain, Run/Attempt; no key material). Rollback restores route/config
desired state only; it never rolls back cert-manager or deletes shared Secrets.
The `issue-tls` workflow/script retirement is gated on the same readiness.

Executable owners: `scripts/gitops-host-contract.mjs` (SC-01 canonical hosts,
backends, preserved nhome.local, dormant MCP) and `scripts/gitops-tls-contract.mjs`
(SC-03 ownership, readiness-gated retirement), run as the `gitops-host-contract` /
`gitops-tls-contract` Gates against the `gitops` branch. The canonical host table
and TLS contract are also in the `gitops` branch README. Live LAN/public probes
and certificate readback are the separate SCN-07 operational gate (#1616 identity
lane); a green PR is not a rollout.

### Measured origin topology (2026-11-28)

A cutover attempt was executed and reverted the same day; the measurements are the
reason, and they contradict two earlier assumptions:

- The Cloudflare origin for `staging-mcp-nession.bestnathan.top` is **not** the
  nitops router. The router (`192.168.2.106`) logged no requests for that host, and
  the Higress gateway access log shows the public hop arriving on its `:443`
  listener with **no SNI** (`requested_server_name "-"`, `response_flags NR`,
  `route_not_found` once the Ingress `tls` block is gone). The no-SNI chain exists
  only while the Ingress carries **both** `tls:` and `higress.io/ssl-redirect`, so
  the Origin CA material is still a live consumer and cannot be retired yet.
- While the SLB forwards the bestnathan vhost to Higress `:443` (the
  BestNathan/nitops#2 #13 workaround for the redirect loop), LAN WebSocket upgrades
  to hosts that have no `tls` block return 404 (plain HTTP requests still succeed;
  the same upgrade through the `:80` hop returns 101). So the #13 topology is not a
  valid end state either.

The retirement therefore requires, in order: (1) Higress trusts exactly one
forwarded hop, (2) the Cloudflare record for this host is repointed to the nitops
router, which already terminates TLS with the cert-manager wildcard and proxies to
the SLB with `proxy_ssl_verify on`, (3) the SLB bestnathan hop becomes plaintext
`:80` with `X-Forwarded-Proto https`, and only then (4) the Ingress `tls:` +
`ssl-redirect` are removed and `sealed-tls.json` retired. Steps 1–3 are nitops and
#4589 owner actions; the cutover readback receipt must not be recorded before step
4 is actually verified.

## GitHub Environment configuration

All deployment-specific settings and provider credentials are GitHub
Environment Variables/Secrets bound to protected main-only execution — never
checked into GitOps, never injected into application/cluster Pods, never
dispatch inputs. Environment values take precedence; repository-level sharing
is only acceptable when intentional and protected by main-only execution.
Values cannot override reviewed identities, visibility, the domain suffix,
allowlists or backend identity.

| Name | Kind | Scope | Verified status (2026-11-27, names only) |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **Secret** | public-provider jobs only | existing **repository-level** Secret inherited by environment jobs; environment-scoped override recommended |
| `CLOUDFLARE_ZONE_ID` | **Variable** | public-provider jobs only | existing **repository-level** Variable |
| `CLOUDFLARE_ORIGIN_IPV4` | **Secret** | public-provider jobs only | existing **repository-level** Secret (correcting historical doc drift that described an environment Variable) |
| `SEALED_SECRETS_CERT_PEM` | **Variable** | legacy `issue-tls` only (public controller cert, not a credential) | referenced by the workflow; provision at environment or repository level if absent |
| `LAN_GATEWAY_IP` | Environment **Variable** | LAN jobs (fixed internal RFC1918 ingress IPv4) | **provision** (not configured anywhere today) |
| `ADGUARD_API_URL` | Environment **Variable** | LAN jobs (bare `https://<internal-IPv4>[:port]`) | **provision** |
| `ADGUARD_USERNAME` / `ADGUARD_PASSWORD` | Environment **Secrets** | LAN jobs only | **provision** |
| `GOST_RELAY_URL` | **Secret** | LAN jobs (reuse the existing protected relay value; no duplicate credential) | existing **repository-level** Secret, already used by main-only identity/readback workflows |
| `DNS_RESOLVER` | Environment **Variable** | LAN `verify` probes (internal resolver IPv4) | **provision** (optional until verify is used) |

Environment values take precedence over repository-level values when both
exist. Repository-level sharing is acceptable only while intentional and
protected by main-only execution (the workflow's repository/ref guard);
moving the Cloudflare credentials into environment-scoped secrets with
main-only branch policies is the recommended hardening, and requires the
operator to re-enter values (secret values are never read back by automation).

Cloudflare secrets are supplied only to public-provider jobs; VPN and AdGuard
credentials only to LAN jobs. No ACME credential or account key exists in
Nession (nitops/cert-manager owns DNS-01). The workflow validates presence and
shape and never prints values. The `staging` Environment currently has no
server-side protection rules; the workflow enforces main-only execution itself.
Operators should add a main-only branch policy where compatible with other
consumers (the retained staging deploy flow also uses `staging`) — protection
must never be weakened to land this contract. `production` has required
reviewers; unattended scheduled plans there wait for review by design.

## Execution contract

Modes (fixed dispatch choices; no arbitrary hostname/IP/URL/shell/branch input):

- `plan` / `verify` / `plan-delete` — read-only for both providers. `verify`
  adds independent LAN resolver A/AAAA probes (exact gateway A answer, no
  public IPv6 fallback).
- `apply` — re-reads provider state, verifies the reviewed plan receipt
  (source SHA, GitOps revision, registry hash, environment/site identity,
  observed and desired state hashes) and the canonical-host readiness, then
  mutates only the exact reviewed desired records with independent readback.
- `reconcile` — safe repair of already-approved desired state; sensitive work
  without a reviewed approval is skipped and reported, never forced.
- `delete` — exact owned-record removal only, bound to a reviewed approval
  that records the precise record identity; fresh state is verified
  immediately before deletion and readback afterwards.
- `issue-tls` — legacy Origin CA issuance, retained until the retirement gate
  permits removal (below).

Triggers: trusted main site-contract path changes → read-only plan; hourly
scheduled read-only inventory/drift plan (staging); manual dispatch for all
modes. Ordinary source/release builds never trigger DNS work, and nothing
depends on bot-push follow-up events (GitOps writes with `GITHUB_TOKEN` emit no
workflow runs). Environment Variable edits do not trigger workflows: the
periodic plan and manual reconcile catch them.

Concurrency: mutations serialize across **all** environments by the shared
`site-dns-writer` authority; read-only plans queue separately; in-flight runs
are never cancelled. The legacy TLS job keeps the shared `gitops-writer` lock.

Receipts: sanitized plan/result receipts (no token, origin IP, gateway IP or
provider free text) are uploaded as artifacts keyed by source SHA, GitOps
revision, registry hash, environment/site and Run/Attempt. Apply downloads the
referenced plan run's receipt only after authenticating the producer run
(exact workflow path, main branch, exact current source SHA, successful
completion). A stale plan fails closed. Partial provider failure is observable
per site; successful independent changes are never automatically undone, and
AdGuard failure is not hidden by Cloudflare success.

## Approvals

[approvals.json](../../scripts/ci/site-registry/approvals.json) records reviewed
explicit approvals for sensitive operations: public activation, adoption,
deletion, visibility transition, origin change, gateway change and Origin CA
retirement. New approvals bind the exact desired-state scope and the registry
content hash at review time; any registry change requires a fresh reviewed
approval. The existing staging-MCP public activation is recorded as #3963/#3992
lineage authorizing maintenance of exactly that reviewed state. Consumed
one-time approvals should be pruned in the next reviewed registry PR. GitHub
Environment protection (required reviewers for `production`) remains the
runtime gate and is never weakened.

## LAN DNS (AdGuard Home)

[configure-adguard-dns.mjs](../../scripts/ci/configure-adguard-dns.mjs)
implements list/add/update/delete exactly as the installed API supports
(update = delete + add), comparing exact domain and answer with independent
readback. The registry is the durable reviewed managed-record inventory
(expected domain + `LAN_GATEWAY_IP` answer); ownership is never inferred from
suffixes, caches or artifacts. Matching unmanaged records remain untouched and
are never silently adopted; conflicting answers and duplicate collisions fail
closed. `nhome.local`, unrelated rewrites, wildcards and TXT handling are never
changed.

Execution is solely through the protected main-owned job-scoped GOST/VPN
([site-dns-tunnel.sh](../../scripts/ci/site-dns-tunnel.sh), reusing the #1616
ownership pattern): the relay is scoped to the validated AdGuard endpoint only,
the actual endpoint/port/TLS/authentication and rewrite API are preflighted,
and job-owned processes/aliases/files are cleaned up on `always()`. The
K8s-API-only identity tunnel is not proof of AdGuard routing. There is no
Kubernetes CronJob, DNS reconciler controller, ExternalDNS, or AdGuard
credential in Kubernetes.

## Public edge policy

[edge-policy.mjs](../../scripts/ci/site-registry/edge-policy.mjs) renders the
reviewed allow/deny contract and the checked-in
[edge-policy.fixture.json](../../scripts/ci/site-registry/edge-policy.fixture.json):
only approved enabled Nession MCP hosts with exact `/mcp` pass; private/unknown
Host/SNI (including direct-IP forced Host and SNI mismatch), alternate paths,
spoofed forwarding headers and non-Cloudflare direct-origin sources are denied
with no wildcard or private-route fallback. nitops#2 consumes this contract for
actual enforcement; CF Universal SSL is unchanged and MCP origin policy must be
Full (strict) effective, never a blind zone-wide change.

## Legacy Origin CA retirement

[retire-origin-ca.mjs](../../scripts/ci/site-registry/retire-origin-ca.mjs) gates
removal of the `issue-tls` action and Origin CA implementation on **both**:

1. a recorded #4588 cutover readiness
   ([origin-ca-cutover-readiness.json](../../scripts/ci/site-registry/origin-ca-cutover-readiness.json):
   `status=recorded`, `cutoverVerified=true`, exact GitOps revision,
   authenticated edge TLS readback Run identity, approver and date), and
2. zero remaining consumers in source and GitOps (deterministic identifier
   scan; the gate itself and docs are allowlisted).

Until then the mechanism remains available and the source invariant passes as
`mechanism-present`. Retirement removes only TLS issuance: public DNS and the
generic SealedSecret mechanism are preserved, #4588 owns the legacy GitOps TLS
objects, and retirement/rollback never republishes private DNS.

## Errors

- Missing/invalid Environment values: provision the exact names above; the
  workflow fails closed without guessing.
- Stale plan: re-run `plan`, review the new receipt, then `apply`.
- Conflict/unowned record: inspect the provider manually; never auto-delete or
  adopt. Deletion/adoption requires a reviewed approval bound to the exact record.
- Legacy-host pending: complete the #4588 canonical host migration for the
  site before LAN registration.
- VPN/preflight failure: the LAN job fails closed and cleans up; check relay
  policy and the approved endpoint, never widen the tunnel scope.

Relevant Cloudflare documentation:
- https://developers.cloudflare.com/api/resources/dns/subresources/records/
- https://developers.cloudflare.com/api/resources/ips/methods/list/
- https://developers.cloudflare.com/api/resources/zones/methods/get/
- https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
