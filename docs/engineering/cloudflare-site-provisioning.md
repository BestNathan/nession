# Protected Cloudflare site configuration (#3963)

This operator-owned [Deploy / Configure Site](../../.github/workflows/deploy-configure-site.yml)
workflow manages the registered site's **Cloudflare DNS only**. The
reviewed registry and provider implementation live in
[scripts/ci/configure-cloudflare-site.mjs](../../scripts/ci/configure-cloudflare-site.mjs).
DNS success does not prove external HTTPS, Cloudflare Origin TLS, MCP
authentication, or Argo CD reconciliation.

## First registered site

| Field | Fixed reviewed value |
|---|---|
| Site key | `staging-mcp` |
| GitHub Environment | `staging` |
| Zone | `bestnathan.top` |
| Hostname | `staging-mcp-nession.bestnathan.top` |
| Record | `A`, `proxied: true`, TTL Auto |
| Source | protected GitHub Environment origin IPv4 variable |

The Actions dispatcher selects only a reviewed site key and `plan` or
`apply`. It cannot supply a custom domain, Zone, record type or API endpoint.

## GitHub Environment setup

In BestNathan/nession → Settings → Environments → `staging`, set:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Environment **Secret** | API Token limited to `bestnathan.top`, `Zone / DNS / Edit`; list/read is included in Edit. Grant `Zone / Zone / Read` only if required. Never use a Global API Key or an account-wide token. |
| `CLOUDFLARE_ZONE_ID` | Environment **Variable** | Exact 32-hex-character Zone ID (not account ID). |
| `CLOUDFLARE_ORIGIN_IPV4` | Environment **Variable** | Real **public IPv4** of the Higress ingress gateway/load balancer, reachable from Cloudflare on port 443. Not Cloudflare anycast IP from a proxied `curl` result. |

Use required reviewers and restrict Environment deployment branches to
`main`. The workflow also enforces exact repository and main-ref checks,
reads only this registered site, and has no GitHub write permissions.
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

The existing staging MCP Origin certificate is self-signed for the **old**
hostname; replacing it remains required. Rotate
`staging/MCP_TLS_PEM_BUNDLE` through the
[protected SealedSecret workflow](sealed-secret-generation.md), verify the
actual Kubernetes certificate SAN, then update and re-seal the
`staging/MCP_CONFIG_TOML` Host allowlist. The future ConfigMap/ENV-token
migration (#3914) is a separate change. The GitOps
`environments/staging/mcp/ingress.yaml` is intentionally excluded from
Kustomize during the hostname migration (#3945); a separate reviewed
GitOps activation is required after DNS, both TLS layers, authenticated
MCP configuration and operator readback are verified.

DNS workflow execution alone does **not** generate an Origin CA private key,
write any Kubernetes/SealedSecret resource, activate public Ingress or
modify the Cloudflare Zone's SSL/TLS mode. Automating Origin CA issuance,
secure offline TLS sealing and live readiness is a later separately
reviewed authority boundary. Never emit plaintext secrets or use insecure
TLS verification with bearer tokens.

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
