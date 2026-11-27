# Protected Cloudflare site configuration (#3963)

This operator-owned [Deploy / Configure Site](../../.github/workflows/deploy-configure-site.yml)
workflow manages the registered site's **Cloudflare DNS and explicit Origin CA TLS issuance**. The
reviewed registry and provider implementation live in
[scripts/ci/configure-cloudflare-site.mjs](../../scripts/ci/configure-cloudflare-site.mjs).
DNS success does not prove external HTTPS, Cloudflare Origin TLS, MCP
authentication, or Argo CD reconciliation.

## Canonical hostnames and cert-manager TLS consumption (#4588)

The hostname/TLS model below the public edge is owned by #4588 (Nession
host/TLS migration), #4589 (private-by-default site registry, split DNS and
MCP-only public exposure) and BestNathan/nitops#2 (cluster certificate
infrastructure). The current contract:

- Every Server/Agent/UI site has a **canonical single-label** `bestnathan.top`
  host (`env-service-nession`; production omits the env and server prefix):
  production `nession` / `agent-nession` / `ui-nession` / `mcp-nession`; staging
  `staging-nession` / `staging-agent-nession` / `staging-ui-nession` /
  `staging-mcp-nession`; staging-01 and preprod follow the same env prefix. The
  nested `<env>.nession.*` names are retained as LAN compatibility during
  migration and retired only after cutover readback. `nhome.local` hosts and
  their manual AdGuard records are preserved verbatim.
- **Certificate ownership is single and external to Nession.** nitops owns
  cert-manager, the DNS-01 ClusterIssuer and the one wildcard Certificate
  `*.bestnathan.top` in the serving `slb` namespace; the target Secret is owned
  exclusively by cert-manager. SLB nginx is the actual client-facing TLS
  terminator for `*.bestnathan.top` and forwards HTTP to Higress — ingress TLS
  is not assumed to be the effective client-facing certificate. Nession installs
  no cert-manager, issues no second wildcard, and writes no competing
  Certificate/Issuer/SealedSecret. Cloudflare Universal SSL still terminates
  public client TLS at the edge; only the approved MCP sites may be public.
- Nession consumes the certificate through host/SAN coverage at SLB. The legacy
  staging MCP Higress Origin CA TLS (`environments/staging/mcp/sealed-tls.json`
  → `nession-mcp-staging-tls`) is retired, and any consumption switch made, only
  after a sanitized cutover readback receipt is recorded (GitOps revision, actual
  gateway identity, certificate serial/expiry/chain, run/attempt; no key
  material). Rollback restores route/config desired state only; it never rolls
  back cert-manager or deletes shared Secrets.
- The executable contract owners are `scripts/gitops-host-contract.mjs` (SC-01)
  and `scripts/gitops-tls-contract.mjs` (SC-03), run as the
  `gitops-host-contract` / `gitops-tls-contract` Gates against the `gitops`
  branch. The canonical host table and TLS contract are also recorded in the
  `gitops` branch README. Live LAN/public probes and certificate readback are
  the separate operational gate (SCN-07, #1616 identity lane); a green PR is not
  a rollout.

The Origin CA `issue-tls` action documented below is the **legacy** issuance
path. Its workflow/script retirement is owned by #4589 and is blocked until the
#4588 cutover readback is recorded and no consumer remains; the generic
SealedSecret mechanism and protected DNS workflow are preserved.

## First registered site

| Field | Fixed reviewed value |
|---|---|
| Site key | `staging-mcp` |
| GitHub Environment | `staging` |
| Zone | `bestnathan.top` |
| Hostname | `staging-mcp-nession.bestnathan.top` |
| Record | `A`, `proxied: true`, TTL Auto |
| Source | protected GitHub Environment origin IPv4 variable |

The Actions dispatcher selects only a reviewed site key and `plan`, `apply` or
`issue-tls`. It cannot supply a custom domain, Zone, record type or API endpoint.

## GitHub Environment setup

In BestNathan/nession → Settings → Environments → `staging`, set:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Environment **Secret** | **The existing operator-provided Cloudflare API Token is reused for DNS and Origin CA**; it must have rights for both `Zone / DNS / Edit` and `Zone / SSL and Certificates / Edit`. No second Token is required. Its access scope is an operator-owned policy decision. |
| `CLOUDFLARE_ZONE_ID` | Environment **Variable** | Exact 32-hex-character Zone ID (not account ID). |
| `CLOUDFLARE_ORIGIN_IPV4` | Environment **Variable** | Real **public IPv4** of the Higress ingress gateway/load balancer, reachable from Cloudflare on port 443. Not Cloudflare anycast IP from a proxied `curl` result. |

Use required reviewers and restrict Environment deployment branches to
`main`. The workflow also enforces exact repository and main-ref checks,
reads only this registered site. DNS jobs have read-only GitHub permission; the TLS job uses scoped `contents: write` only to publish encrypted GitOps state.
Token and origin IP are not printed in the workflow log.

If exposure of origin IP is an operational concern, restrict access to
the Environment variables and DNS administration. Do not put the CF API Token,
MCP bearer tokens, or TLS private keys into normal variables or checked-in
configuration.

## Run

Choose GitHub Actions → `Deploy / Configure Site` → `Run workflow`,
branch `main`, site `staging-mcp`.

1. Run action `plan`. Validate input, active Zone, exact hostname records,
   Cloudflare's official Edge IP ranges and current desired/observed state.
   It reports only `create`, `noop`, `update`, or `blocked`.
   **No provider mutations occur in plan.**
2. After reviewing the plan and Origin TLS readiness, run `apply`.
   Only the first registered site's A record may be created or PATCHed.
   A write is not considered successful until exact provider readback
   confirms the desired address and proxy state.
3. Identical runs are no-ops. An existing owned record can be updated, but
   duplicate A records, CNAME/AAAA conflicts and mismatched unmanaged
   records are refused. A matching unmanaged record remains untouched; it
   is not silently adopted. The fixed DNS comment identifies Nession-owned
   records. The workflow **never deletes** Cloudflare resources.
4. Editing GitHub Environment variables does **not** automatically dispatch
   a workflow. Run `plan` and `apply` again for an intended origin change.

For operational rollback of a Nession-owned A record, restore the prior
origin IP Environment Variable and run `plan` then `apply`. DNS deletion
or adoption of an unmanaged record requires separate operator review.

## Issue and seal Cloudflare Origin CA TLS (explicit action)

After a successful DNS `apply` verified by Cloudflare API, choose
`site=staging-mcp`, `action=issue-tls` in the **same** Actions workflow.

The same existing `staging/CLOUDFLARE_API_TOKEN` is used in the protected TLS
job; the workflow first verifies that the exact DNS record is Nession-owned,
proxied and points to the configured Origin IPv4. Only then does it generate
an RSA private key and CSR **locally on the runner**, request a certificate
via Cloudflare `POST /client/v4/certificates` for exactly
`staging-mcp-nession.bestnathan.top`, and validate the SAN, key match,
validity and certificate scope.

It uses existing `vars.SEALED_SECRETS_CERT_PEM` to encrypt a strict
`SealedSecret` offline, reusing the registered Kubernetes identity
`nession/nession-mcp-staging-tls` and encrypted
`environments/staging/mcp/sealed-tls.json`. Plaintext key files are
mode 0600 and removed from the runner. The shared `gitops-writer`
concurrency group prevents competing GitOps writers.
There are no extra TLS Environment Secrets to upload; the legacy
`MCP_TLS_PEM_BUNDLE` manual selection is retired. This is an explicit
issuance and rotation action, **not** part of repeatable DNS `apply`,
which remains read-only when `plan` and DNS-only when `apply`.

A successful action confirms Cloudflare issued a certificate and GitOps
received ciphertext, **not** that the Kubernetes Secret was reconciled or
Higress is serving the new certificate. Confirm the decrypted certificate
**SAN on the running cluster**. Cloudflare Origin CA certs are trusted by
Cloudflare on proxied origins using `Full (strict)`, not by direct public
browsers. The workflow deliberately does **not** change Zone-wide SSL mode.

## TLS and application readiness are separate

The one-label host `staging-mcp-nession.bestnathan.top` can be covered by
Cloudflare Universal SSL at the **Edge**, provided the Zone/Edge certificate
is active. That Edge certificate is distinct from the certificate installed
on **Higress Origin**.

For Cloudflare `Full (strict)`, the Origin certificate must cover the new
hostname and be a valid publicly trusted CA or Cloudflare Origin CA
certificate. Origin CA may be trusted by Cloudflare but not by a direct
off-proxy browser. Do not relax the whole Zone's SSL mode to make
a broken Origin pass.

The previously deployed staging MCP Origin certificate was self-signed for
the **old** hostname. After `issue-tls`, verify that the actual Kubernetes
certificate has rotated to the new SAN, then update and re-seal the
`staging/MCP_CONFIG_TOML` Host allowlist. The ConfigMap/ENV-token migration
(#3914) has since landed: the nonsecret Host allowlist lives in
`environments/staging/mcp/mcp.toml` and the inbound token in a SealedSecret.
The GitOps `environments/staging/mcp/ingress.yaml` is now **enrolled** in the
Kustomization (the #3945 hostname-migration exclusion is historical); the
canonical host `staging-mcp-nession.bestnathan.top` is active. Under #4588 this
legacy Higress Origin CA TLS is consumed at the nitops-owned SLB instead, and
its retirement is gated on the cutover readback receipt described above.

DNS-only `plan/apply` never issues certificates or publishes Kubernetes
resources. Explicit `issue-tls` does issue and seal the TLS Secret but
**does not** activate public Ingress or alter the Zone's SSL mode.
Never emit plaintext secrets or use insecure TLS verification with bearer tokens.

## Errors

- Bad IP or Cloudflare Edge IP: supply the true public Higress gateway.
- Wrong Zone: verify `CLOUDFLARE_ZONE_ID` belongs to active `bestnathan.top`.
- DNS blocked: inspect duplicate/conflicting/unowned records in Cloudflare
  manually; do not automatically delete or adopt them.
- HTTP/API errors: check Token permissions and Environment approvals.
- Post-write readback mismatch: the action **failed**; run plan again and
  inspect current provider state before retrying.

Relevant Cloudflare documentation:
- https://developers.cloudflare.com/api/resources/dns/subresources/records/
- https://developers.cloudflare.com/api/resources/ips/methods/list/
- https://developers.cloudflare.com/api/resources/zones/methods/get/
- https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/
