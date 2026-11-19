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
   Query Token implementation (#3995) is source-pinned and available in GHCR for amd64 and arm64. The
   historical running ACR tag `mcp-4774f3e` includes both implementations in
   its corresponding source, but rollout must follow the canonical GHCR writer.
2. Set two GitHub **Environment Secrets**:
   `staging/NESSION_MCP_INBOUND_TOKEN` to a strong, independently generated raw
   token; `staging/NESSION_MCP_BACKEND_SERVER_TOKEN` to the **exact current**
   staging Server/Agent auth token value. Do not provide either as a repository
   Variable, JSON envelope, issue comment or GitOps file. The main-owned
   `Deploy / Seal GitOps Secret` workflow is manual-only, accepts only these
   environment-only input and encrypts the entire required Secret set in
   one invocation. The registered staging set contains these two names;
   any missing/invalid required value fails the entire run without publishing
   a partial GitOps change.
   `SEALED_SECRETS_CERT_PEM` is the controller's existing public X.509
   certificate and NOT a credential.
3. Dispatch **Deploy / Seal GitOps Secret once**, choosing only the
   `staging` environment. It validates **both** required Secrets before
   sealing. It produces `sealed-inbound.json` and
   `sealed-backend-server.json`, and commits both along with their
   Kustomization registration in **one atomic GitOps commit**. Missing or
   invalid input or either malformed sealed output fails the whole run.
   Verify Argo CD reconciles both exact Kubernetes Secrets
   `nession-mcp-inbound-staging/token` and
   `nession-mcp-backend-server-staging/token`. If a concurrent change
   updates Kustomization, reconcile this draft PR against the latest GitOps
   HEAD before merging.
4. **Operator opt-in (2026-11-19):** staging `mcp.toml` sets
   `allow_query_token = true` for MCP clients that cannot send custom
   Authorization headers. The existing inbound token is required even when
   it is presented as the exactly named `?token=` query argument; Bearer
   authentication still works. The operator explicitly accepted enabling
   without waiting for Cloudflare/Higress/origin Nginx query-log redaction.
   **Risk:** full request-target logs, browser histories and copied URLs may
   expose this credential until those layers are separately hardened.
   Never print real tokens in GitOps, command arguments, URLs shared in
   Issues/PRs or CI artifacts.
5. Argo CD mounts the generated ConfigMap and injects the two separately
   sealed Secrets. Confirm the GHCR MCP image remains source-verified, the
   Deployment becomes Ready, and authenticated `POST /mcp` initializes using
   both `Authorization: Bearer` and the exact URL-encoded `?token=` form.
   Missing/invalid credentials must be rejected. Call `tools/list` and a safe
   read-only Server Tool. A TCP probe or public unauthenticated GET/401 alone
   is insufficient; a GitOps merge is not live acceptance.
6. After live acceptance, explicitly retire the unused legacy config Secret
   and old GitHub `MCP_CONFIG_TOML` entry; do not remove rollback resources
   before proving the new credential path. Query-token mode is an
   accommodation for headerless clients, not OAuth.

## Version, rotation and rollback

`scripts/gitops-commit.sh staging <short-sha>` is the source-owned release
writer for image tag advancement. It verifies all four GHCR image indices
(server/agent/ui/mcp) for amd64 and arm64 and updates their tags in one
GitOps commit. Do not patch image tags or build images manually to bypass it.

Re-running the trusted Secret publisher reseals **both** registered
credentials in one commit even if only one Secret value changed.
A SealedSecret update does **not** automatically restart pods consuming
a Secret via environment variables. Trigger a
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
