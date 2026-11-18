# Staging-only standalone Nession MCP (#3902)

This is a **separate Argo CD Application** (`nession-mcp-staging`) and a
single stateless Deployment/ClusterIP Service (`nession-mcp-staging`) in the
shared `nession` namespace. Production, preprod, and staging-01 are unchanged.
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
by default. The app intentionally exposes no public Ingress/DNS/TLS until
approved and configured. A missing/invalid Secret fails closed.

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
