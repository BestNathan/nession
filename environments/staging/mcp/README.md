# Staging standalone MCP GitOps desired state (#3902, #3914)

This overlay owns the independent MCP Deployment, Service and staging HTTPS
Ingress, not the embedded Server/Agent MCP endpoint. The public route is
`https://staging-mcp-nession.bestnathan.top/mcp` with an Exact `/mcp`
path through Higress to the MCP Service (9090). Its existence in GitOps does
not prove that Cloudflare → origin Nginx → Kubernetes/Higress forwarding,
Cloudflare Full (strict) origin TLS, HTTP redirect, and actual authenticated
Streamable HTTP requests have passed. A 404 from the operator's origin Nginx
is not a positive MCP endpoint test (#3945).

## Config ownership: GitOps only (user decision 2026-11-19)

`mcp.toml` is a checked-in, **nonsecret** file under this directory. Its
settings include bind address, `/mcp`, Host/Origin policies, Query Token
switch, and the internal staging Server WebSocket endpoint
`ws://nession-server-staging:18080`. There is **no GitHub Environment Variable
for MCP TOML** and no `${VARIABLE}` substitution.

`kustomization.yaml` uses `configMapGenerator` to produce the read-only
ConfigMap `nession-mcp-settings-<content-hash>` from `mcp.toml`, and
automatically rewrites the Deployment's ConfigMap volume reference. A checked-in
config change changes the generated name / pod template and rolls MCP to
consume it. The fixed file mount is `/etc/nession/mcp.toml`.

### Secrets are the only separate inputs

| Process env | Kubernetes Secret / key | Operator source |
|---|---|---|
| `NESSION_MCP_INBOUND_TOKEN` | `nession-mcp-inbound-staging/token` | GitHub Environment **Secret** `staging/NESSION_MCP_INBOUND_TOKEN`, sealed into `sealed-inbound.json` |
| `NESSION_MCP_BACKEND_SERVER_TOKEN` | `nession-mcp-backend-server-staging/token` | GitHub Environment **Secret** `staging/NESSION_MCP_BACKEND_SERVER_TOKEN`, sealed into `sealed-backend-server.json` |

Both `secretKeyRef` fields are required (`optional: false`); missing
credentials block Pod startup rather than enabling anonymous access.
The two MCP credentials are separate. The backend Server credential must
equal the value of the staging Server/Agent canonical auth token; this
standalone MCP Secret is an independent Kubernetes object, **not** a second
Server identity. Provision/rotate consistently, otherwise MCP tool calls fail.
Historical `MCP_CONFIG_TOML` Environment Secret and the encrypted legacy
`sealed-secret.json` remain only for rollback until new runtime validation
succeeds; the former is NOT a config source for the new Deployment.

The existing staging Server token was previously committed in plaintext under
`base/nession/secret.yaml`, so it is security debt; rotate it in a coordinated
Server + Agent + MCP migration. This GitOps change does not replace it or
silently switch Server/Agent credentials. Injected environment Secrets require
MCP Pod restart after rotation.

## Safe cutover prerequisites and order

1. Merge the independently reviewed **main** Secret publisher PR, which
   registers exactly `staging/NESSION_MCP_INBOUND_TOKEN` and
   `staging/NESSION_MCP_BACKEND_SERVER_TOKEN`. Confirm a staging MCP image
   built from a SHA containing the env-credential loader (#3950) and standalone
   Query Token implementation (#3995) exists in ACR (both architectures).
2. Set two GitHub **Environment Secrets**:
   `staging/NESSION_MCP_INBOUND_TOKEN` to a strong, independently generated raw
   token; `staging/NESSION_MCP_BACKEND_SERVER_TOKEN` to the **exact current**
   staging Server/Agent auth token value. Do not provide either as a repository
   Variable, JSON envelope, issue comment or GitOps file. The main-owned
   `Deploy / Seal GitOps Secret` workflow is manual-only, accepts only these
   two registered exact names and encrypts one Secret per invocation.
   `SEALED_SECRETS_CERT_PEM` is the controller's existing public X.509
   certificate and NOT a credential.
3. Dispatch the workflow **twice**, selecting each Secret individually:
   `NESSION_MCP_INBOUND_TOKEN` writes `sealed-inbound.json` and
   `NESSION_MCP_BACKEND_SERVER_TOKEN` writes `sealed-backend-server.json`.
   Verify both files are enrolled by the authorized publisher and Argo CD
   reconciles both exact K8s Secrets `nession-mcp-inbound-staging/token`
   and `nession-mcp-backend-server-staging/token`. If a concurrent change
   updates Kustomization, reconcile this PR against the new GitOps branch
   HEAD before merging.
4. **Before enabling `allow_query_token = true` publicly**, configure
   Cloudflare/Higress/origin Nginx logs to omit/redact request query strings.
   Query credentials must not appear in access logs, diagnostics, browser
   histories or copied tickets. Verify external TLS trust and the HTTPS
   redirect. No plaintext credentials may appear in GitOps/CI artifacts.
5. Only then merge this desired-state PR to `gitops`. Argo CD mounts the
   generated ConfigMap and injects **both** independently sealed Secrets into
   the MCP Pod. Confirm the
   published ACR MCP tag is recent enough, the Deployment becomes Ready,
   and `POST /mcp` initializes with the inbound token both in
   `Authorization: Bearer` and in URL-encoded `?token=...`; invalid/absent
   credentials must return 401. Call `tools/list` and a safe read-only Tool
   through the staging Server. A TCP probe alone is insufficient.
6. After live acceptance, explicitly retire the unused legacy config Secret
   and old GitHub `MCP_CONFIG_TOML` entry; do not remove rollback resources
   before proving the new credential path. Query-token mode is an
   accommodation for headerless clients, not OAuth.

## Version, rotation and rollback

`scripts/gitops-commit.sh staging <short-sha>` is the source-owned release
writer for image tag advancement. It verifies all four ACR image indices
(server/agent/ui/mcp) for amd64 and arm64 and updates their tags in one
GitOps commit. Do not patch image tags or build images manually to bypass it.

Re-running the trusted Secret publisher replaces only the selected encrypted
`sealed-inbound.json` or `sealed-backend-server.json` entry; a SealedSecret
update does **not** automatically restart pods consuming a Secret via
environment variables. Trigger a
controlled MCP rollout after rotating the inbound token. Coordinate Server
token changes across all three workloads. To roll back configuration,
revert the reviewed GitOps desired-state merge or use a previously verified
image/Secret configuration; never publish a real token in history.

Read-only verification commands:

```sh
kubectl -n nession get sealedsecret nession-mcp-inbound-staging
kubectl -n nession get secret nession-mcp-inbound-staging -o jsonpath='{.type}{"\\n"}'
kubectl -n nession get sealedsecret nession-mcp-backend-server-staging
kubectl -n nession get secret nession-mcp-backend-server-staging -o jsonpath='{.type}{"\\n"}'
kubectl -n nession get deploy/nession-mcp-staging svc/nession-mcp-staging
kubectl -n nession rollout status deployment/nession-mcp-staging
```

Do not print the Secret data, token-bearing request URL or full TLS Secret.
