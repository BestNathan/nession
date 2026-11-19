# Staging-only standalone Nession MCP (#3902)

This is a **separate Argo CD Application** (`nession-mcp-staging`) and a
single stateless Deployment/ClusterIP Service (`nession-mcp-staging`) in the
shared `nession` namespace. The Higress HTTPS Ingress manifest for
`https://staging-mcp-nession.bestnathan.top/mcp` is included in the
staging MCP Kustomization (#3945). It is an Exact `/mcp` HTTPS route to
`nession-mcp-staging:9090`, not a catch-all. Its presence in desired state
does **not** prove the live Ingress, TLS Secret, Host allowlist, source
Nginx-to-Higress forwarding, or external MCP authentication is working.
HTTP must redirect to HTTPS before credentialed traffic is used.
The previously deployed Kubernetes certificate was self-signed and issued for
`staging.mcp.nession.bestnathan.top`, which does NOT cover the new hostname. Both the public
Host allowlist and certificate must be replaced via protected Secrets before
reactivating this Ingress. Ordinary clients must receive a trusted TLS chain.
Never disable certificate verification to make a bearer-authenticated MCP
client connect. A staged manifest is not evidence that DNS, externally trusted
TLS, HTTP redirect, or authenticated MCP requests have passed live tests.
Production, preprod, and staging-01 are unchanged.
This service is not the embedded `/mcp` route inside Server/Agent containers.

## Image and version contract

`scripts/gitops-commit.sh staging <short-sha>` (main source) verifies all
four ACR OCI indices (`server`, `agent`, `ui`, `mcp`) support linux/amd64
and linux/arm64, then changes this overlay's `mcp-<short-sha>` and
`environments/staging/nession`'s three image tags in **one GitOps commit**.
The independent Argo apps reconcile separately, so the same desired source
revision does not guarantee simultaneous *runtime* readiness. Inspect both.

## Encrypted MCP configuration via GitHub Environments (#3912 / PR #3913)

The GitHub Environment is **`staging`**, matching
`gitops/environments/staging` exactly. It holds independent GitHub Secrets
for this environment. The operator provides **`MCP_CONFIG_TOML`** as one
Environment Secret whose value is the complete **raw `mcp.toml` text**,
not JSON/base64 or a bundle. The repository variable
`SEALED_SECRETS_CERT_PEM` contains the controller's **public X.509 RSA
certificate PEM** (not the SSH public key used by Argo CD, and never the
controller private key). See `docs/engineering/sealed-secret-generation.md`
on `main`.

The main-owned `Deploy / Seal GitOps Secret` workflow already exists and
has successfully published both encrypted resources to this overlay. For the
new hostname, after the source registry update is merged to `main`, edit
the existing private `staging/MCP_CONFIG_TOML` and
`staging/MCP_TLS_PEM_BUNDLE` GitHub Environment Secrets independently, and
run the workflow manually once per selected target to reseal their content.
The existing Sealed Secrets Controller generates the ordinary Kubernetes
Secrets `nession-mcp-config-staging` (key `mcp.toml`) and
`nession-mcp-staging-tls` (keys `tls.crt`/`tls.key`). No workflow
Kubernetes credentials or controller private key are required. The main-push
bootstrap of the producer **only** seals `MCP_CONFIG_TOML` and cannot replace
the required manual PEM/TLS rotation.

Start from the checked-in `mcp.example.toml`; set separate nonempty inbound
and staging Server backend tokens. The Server credential must be **rotated**
if it is the existing credential previously committed in plain text. The
config must bind `0.0.0.0:9090`, explicitly allow the public Host, and use
`ws://nession-server-staging:18080` as the backend URL. Browser Origins
remain refused by default. Missing/invalid config fails closed; never commit
either token or place it in a ConfigMap.

## Public HTTPS MCP entry point (operator prerequisites)

The staging-only Ingress (declared in the Kustomization, subject to Argo reconciliation) is
`nession-mcp-staging`, with
`ingressClassName: higress` and the single **Exact** path `/mcp` mapped to
the MCP Service port 9090. The supported external endpoint is:

```text
https://staging-mcp-nession.bestnathan.top/mcp
```

**Before reactivating the public MCP endpoint (GitOps config alone is NOT sufficient):**

1. In Cloudflare's `bestnathan.top` zone create/verify the **first-level**
   proxied record (one DNS label `staging-mcp-nession`) and its matching
   active Cloudflare **Edge certificate**; confirm Cloudflare → Higress
   **Origin TLS** certificate trust under Full (strict) before forwarding
   authenticated MCP traffic. Create/verify the public DNS A/AAAA/CNAME record
   `staging-mcp-nession.bestnathan.top` pointing to the externally reachable
   **Higress gateway**. A GitOps Ingress manifest does not create public DNS.
2. Provision a **new** valid TLS certificate with SAN
   `staging-mcp-nession.bestnathan.top` and its matching private key.
   **Use the reviewed SealedSecret workflow**, not plaintext `kubectl create
   secret`, when GitOps owns this Secret. First reconcile any existing
   cert-manager/Higress/nitops owner of that exact name to avoid two writers.
   Once the #3945 registered-hostname change is merged to main, put the
   renewed PEM bundle (leaf, ordered intermediates, then matching unencrypted private key) into GitHub
   Environment `staging` Secret `MCP_TLS_PEM_BUNDLE`, and manually run
   `Deploy / Seal GitOps Secret` selecting `staging/MCP_TLS_PEM_BUNDLE`.
   Use a publicly trusted certificate, or a Cloudflare Origin CA certificate
   if the origin is reached only through Cloudflare and Full (strict).
   That produces encrypted `sealed-tls.json` in this overlay and instructs
   the Sealed Secrets controller to create a `kubernetes.io/tls` Secret
   `nession/nession-mcp-staging-tls` with `tls.crt` + `tls.key`.
   See `docs/engineering/sealed-secret-generation.md` on main for validation,
   rotation and expiration requirements. The key never enters plaintext Git.
3. Update the existing **private GitHub Environment** `MCP_CONFIG_TOML`
   so `[mcp].allowed_hosts` contains the new hostname but NOT the old name,
   retaining internal Kubernetes Service hosts and distinct inbound/outbound
   bearer tokens; re-run `Deploy / Seal GitOps Secret` selecting
   `staging/MCP_CONFIG_TOML`. The repo's `mcp.example.toml` documents the
   allowed hosts. Verify **both** Kubernetes Secrets exist after Argo CD/
   Sealed Secrets reconcile: `nession-mcp-config-staging` and
   `nession-mcp-staging-tls`. Verify actual TLS SAN and that the running
   pod sees the new config; reload/restart the Deployment if necessary.
   Verify DNS, external Edge HTTPS trust, and origin TLS independently.
   Host allowlist must include the public
   hostname, and inbound/outbound bearer tokens must differ.
4. **Activation / live verification:** `ingress.yaml` is now declared by
   `kustomization.yaml` in a separately reviewed GitOps activation (#3945).
   Verify that Argo reconciles the real Higress Ingress, that its TLS
   Secret serves the exact new SAN, and that DNS resolves publicly.
   The external origin Nginx-to-K8s/Higress forwarding is independently
   configured by the operator; until then an Nginx 404 is expected and
   must not be mistaken for an MCP 404. Verify Cloudflare Full (strict)
   origin trust, HTTPS redirect, and Host policy before credentialed use.
   Roll back the GitOps activation if a prerequisite fails.
   MCP itself speaks plain HTTP **inside the cluster** behind TLS termination.
   For query-token clients, first deploy the merged standalone query-token
   implementation to the actual staging MCP image, and set
   `[mcp].allow_query_token = true` in the **protected** `MCP_CONFIG_TOML`
   before re-sealing it; the checked-in example is not live configuration.
   Higress's default access log `path` can include query parameters.
   Redact query parameters in **both** Higress gateway access logs and
   the external origin Nginx/proxy logs before enabling URL tokens.
   Do not include a real token in curl examples, Issues, PRs or logs.

5. Do not enable permissive CORS or anonymous MCP calls to make clients work.
   `allowed_origins = []` rejects browser Origins by default; native MCP
   clients can call it with `Authorization: Bearer <inbound-token>`.

After Argo CD sync, verify from a **machine outside** the cluster:

```sh
# HTTP redirects to HTTPS, never serves MCP content directly.
curl -sS -I http://staging-mcp-nession.bestnathan.top/mcp

# Check real TLS trust chain and endpoint auth refusal (no -k).
curl -si https://staging-mcp-nession.bestnathan.top/mcp
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

Read-only resource checks (do not print full TLS Secret YAML, which exposes
base64-decodable private key material):

```sh
kubectl -n nession get sealedsecret nession-mcp-staging-tls
kubectl -n nession get secret nession-mcp-staging-tls -o jsonpath='{.type}{"\\n"}'
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
