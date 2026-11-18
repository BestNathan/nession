# Staging-only standalone Nession MCP (#3902)

This is a **separate Argo CD Application** (`nession-mcp-staging`) and a
single stateless Deployment/ClusterIP Service (`nession-mcp-staging`) and an
HTTPS-only public Higress Ingress in the shared `nession` namespace. Production, preprod, and staging-01 are unchanged.
This service is not the embedded `/mcp` route inside Server/Agent containers.

## Image and version contract

`scripts/gitops-commit.sh staging <short-sha>` (main source) verifies all
four ACR OCI indices (`server`, `agent`, `ui`, `mcp`) support linux/amd64
and linux/arm64, then changes this overlay's `mcp-<short-sha>` and
`environments/staging/nession`'s three image tags in **one GitOps commit**.
The independent Argo apps reconcile separately, so the same desired source
revision does not guarantee simultaneous *runtime* readiness. Inspect both.

## Mandatory Secret preflight (before merging/enabling the Argo app)

An operator must provision `nession-mcp-config-staging` with one key,
`mcp.toml`. Start from the checked-in `mcp.example.toml`, fill the inbound
bearer token and the *different* staging Server backend token. The Server
backend token must match the existing staging Server credential, which is
managed separately. Never commit either credential, copy the token into a
ConfigMap, bake it into an image, or reuse inbound and outbound tokens.

From a trusted workstation with configured `kubectl` access:

```sh
# Edit a PRIVATE file (not tracked by git) based on mcp.example.toml.
kubectl -n nession create secret generic nession-mcp-config-staging \
  --from-file=mcp.toml=/secure/path/mcp.toml \
  --dry-run=client -o yaml | kubectl apply -f -
```

The config must bind `0.0.0.0:9090`, allow the actual HTTP Host and point
`[backend.server].endpoint` to `ws://nession-server-staging:18080`. MCP
clients authenticate separately from Server/Agent; Origin requests are denied
by default. The operator MUST allow the exact public DNS Host in
`mcp.toml`, not disable Host validation. A missing/invalid MCP config Secret
fails closed before the listener starts.

## Public HTTPS MCP entry point (operator prerequisites)

The staging-only Ingress is `nession-mcp-staging`, with
`ingressClassName: higress` and the single **Exact** path `/mcp` mapped to
the MCP Service port 9090. The supported external endpoint is:

```text
https://staging.mcp.nession.bestnathan.top/mcp
```

**Before merging the GitOps app PR / enabling ingress:**

1. Create/verify the public DNS A/AAAA/CNAME record
   `staging.mcp.nession.bestnathan.top` pointing to the externally reachable
   **Higress gateway**. A GitOps Ingress manifest does not create public DNS.
2. Provision a valid, publicly trusted, unexpired TLS certificate with SAN
   `staging.mcp.nession.bestnathan.top`, including the full intermediate
   chain, in the **operator-owned** Kubernetes TLS Secret
   `nession-mcp-staging-tls` in namespace `nession`. No certificate private
   key is committed to Git. If the cluster's existing Higress-managed
   certificate automation provisions that exact Secret, reuse that owner;
   otherwise create it securely, for example:
   ```sh
   kubectl -n nession create secret tls nession-mcp-staging-tls \
     --cert=/secure/path/fullchain.pem --key=/secure/path/privkey.pem \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. Provision the separate `nession-mcp-config-staging` Secret shown above.
   Its `allowed_hosts` must include the public hostname, and its inbound
   bearer token must be different from the outbound Server credential.
4. Verify the existing Higress Controller reconciles this Ingress and TLS
   Secret, DNS resolves publicly, and its gateway is actually reachable
   from the internet. The manifest explicitly requests TLS termination and
   HTTP→HTTPS redirection using Higress-compatible
   `higress.io/ssl-redirect: "true"` (no plaintext MCP forwarding).
   MCP itself speaks plain HTTP **inside the cluster** behind TLS termination.
5. Do not enable permissive CORS or anonymous MCP calls to make clients work.
   `allowed_origins = []` rejects browser Origins by default; native MCP
   clients can call it with `Authorization: Bearer <inbound-token>`.

After Argo CD sync, verify from a **machine outside** the cluster:

```sh
# HTTP redirects to HTTPS, never serves MCP content directly.
curl -sS -I http://staging.mcp.nession.bestnathan.top/mcp

# Check real TLS trust chain and endpoint auth refusal (no -k).
curl -si https://staging.mcp.nession.bestnathan.top/mcp
# Expect HTTP 401 without Authorization (not 200 or HTML).

# With the private inbound token, use an MCP client to send
# initialize and tools/list over the same HTTPS endpoint, and call
# a safe read-only Tool against the staging Server.
```

A green TCP probe only proves local listener health, **not** public DNS,
gateway TLS, authentication, external client reachability, or backend health.
Live external handshake/readback is a separate deployment acceptance check,
not an assumption from a PR merge or Argo CD Synced status.

## Verification and rollback

```sh
kubectl -n nession rollout status deployment/nession-mcp-staging
kubectl -n nession get deploy/nession-mcp-staging svc/nession-mcp-staging
kubectl -n nession port-forward service/nession-mcp-staging 9090:9090
```

Authenticate an MCP client at `http://localhost:9090/mcp` using the inbound
token; verify `tools/list` and a safe read through the staging Server.
Do not treat a TCP readiness pass as proof that remote Server tools work.

For rollback, revert the relevant GitOps desired-state commit or pin a
previous published staging SHA through the trusted deployment writer; never
retag/rebuild images by hand. The MCP app can also be rolled back independently,
but doing so temporarily breaks its same-SHA desired-state alignment.
