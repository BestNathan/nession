# GitHub Environments -> one SealedSecret per raw Secret (#3912)

One GitHub Environment Secret maps to exactly one Kubernetes Secret and one
encrypted SealedSecret Kubernetes resource. The GitHub Secret holds original
raw text, **not JSON, base64, or a multi-secret bundle**. A single Kubernetes
TLS Secret has two required data keys: tls.crt and tls.key.

## Current Staging MCP config ownership (#3914, 2026-11-19)

The **nonsecret** standalone MCP TOML is reviewed and committed directly
as `gitops/environments/staging/mcp/mcp.toml`. Kustomize generates a
read-only ConfigMap. There is no GitHub Environment Variable for MCP
configuration and no `${VARIABLE}` string interpolation.

GitHub Environment `staging` contains **Secrets only** for the MCP
credential cutover: `NESSION_MCP_INBOUND_TOKEN` is an independent, raw bearer
credential sealed to `nession/nession-mcp-inbound-staging` key `token`;
`NESSION_MCP_BACKEND_SERVER_TOKEN` is a separate raw GitHub Environment
Secret sealed to `nession/nession-mcp-backend-server-staging` key `token`.
The **backend credential value must match** the canonical staging Server/Agent
shared token; the additional MCP Secret object is a deployment boundary,
not permission to invent or independently rotate a different Server token.
Coordinate Server, Agent, and MCP credential changes together.

After the new MCP OCI image includes the env-credential loader and the
operator has added **both** GitHub Environment Secrets
`staging/NESSION_MCP_INBOUND_TOKEN` and `staging/NESSION_MCP_BACKEND_SERVER_TOKEN`,
manually dispatch **Deploy / Seal GitOps Secret** with ONLY `environment =
staging`. The registered staging environment requires **both** Secret
values. The workflow validates both before producing ciphertext; any absent,
empty or invalid required Secret stops the entire run, without publishing
a partial set. Both strict encrypted outputs (`sealed-inbound.json` and
`sealed-backend-server.json`) are checked and published in **one** GitOps
commit, with the shared Kustomization enrollment. There is no per-Secret
selection input, arbitrary resource name, or YAML path.
The operator approves the protected GitHub Environment once per run.
Verify the SealedSecrets controller materializes **both** exact Kubernetes
Secrets before switching the MCP Deployment. The backend token value must
match the staging Server's actual auth token, or MCP tool calls will fail.

**Migration safety:** The environment-batch publisher is intentionally **not**
the TLS certificate issuer; TLS is owned by `Deploy / Configure Site`.
Existing `MCP_CONFIG_TOML` Environment Secret,
`sealed-secret.json` and its Kubernetes Secret remain legacy rollback
material until the read-only ConfigMap and credential injection are verified
live. Do not enable the new Deployment before the new image and **both**
MCP Secrets are present. Environment-variable credentials are loaded at process
startup; restart MCP after either Secret is rotated and coordinate backend credential rotation with Server/Agent. No credential content
belongs in GitOps TOML, PRs or request/edge logs. Redact query parameters at
Higress and Nginx before setting `allow_query_token = true`.

### Legacy history (#3912)

The following historical bootstrap notes describe the original full-TOML
Secret workflow, not the current preferred configuration or current manual
dispatcher input. Do not follow the `MCP_CONFIG_TOML` setup steps for a new
configuration.

## Environment naming convention

GitHub Environment names must match GitOps environment directory names:
- staging -> gitops/environments/staging
- staging-01 -> gitops/environments/staging-01
- preprod -> gitops/environments/preprod
- production -> gitops/environments/production

The **Deploy / Seal GitOps Secret** workflow now exposes only
**staging/NESSION_MCP_INBOUND_TOKEN** and **staging/NESSION_MCP_BACKEND_SERVER_TOKEN**
as one mandatory environment batch. The existing legacy full-TOML registry remains
for historical ciphertext validation and rollback only, not for the current
manual workflow. The existing `MCP_TLS_PEM_BUNDLE` registry
entry is retained solely as a bounded strict SealedSecret target consumed by
**Deploy / Configure Site → issue-tls** (#3992). The TLS private key is minted
ephemerally in the protected runner, not uploaded to a GitHub Environment
Secret. No workflow may accept an arbitrary namespace, output path or host.

## Registered resource

| GitHub Environment | GitHub Secret | Kubernetes Secret | data key | GitOps encrypted resource |
|---|---|---|---|---|
| staging | NESSION_MCP_INBOUND_TOKEN | nession/nession-mcp-inbound-staging (Opaque) | token | environments/staging/mcp/sealed-inbound.json |
| staging | NESSION_MCP_BACKEND_SERVER_TOKEN | nession/nession-mcp-backend-server-staging (Opaque) | token | environments/staging/mcp/sealed-backend-server.json |
| staging | MCP_CONFIG_TOML (legacy/rollback only) | nession/nession-mcp-config-staging (Opaque) | mcp.toml | environments/staging/mcp/sealed-secret.json |
| staging | *issued by Configure Site / issue-tls* | nession/nession-mcp-staging-tls (kubernetes.io/tls) | tls.crt + tls.key | environments/staging/mcp/sealed-tls.json |

The target registry in scripts/ci/seal-gitops-secret.mjs is the sole owner of
the allowed mapping and Kustomize overlay path.

## IMPORTANT: SSH public keys are not sealing certificates

The proposed line beginning with "ssh-ed25519 AAAA..." and ending
"argocd-nitops" is an **SSH public key**, probably used for Argo CD
repository access. It CANNOT be used with kubeseal to encrypt a SealedSecret.
It does not match the Sealed Secrets controller's own encryption key.

The controller deployed in BestNathan/nitops is
kube-system/sealed-secrets-controller. Fetch its **public X.509 RSA
certificate**, not its private key or Argo CD SSH key, from a trusted machine
with Kubernetes access:

~~~sh
kubeseal --controller-name sealed-secrets-controller \
  --controller-namespace kube-system --fetch-cert > sealed-secrets-public.pem
openssl x509 -in sealed-secrets-public.pem -noout -subject -fingerprint -sha256 -enddate
~~~

The PEM begins with "-----BEGIN CERTIFICATE-----". Set the GitHub Actions
Repository Variable SEALED_SECRETS_CERT_PEM to that **raw PEM text**.
An Environment Variable with the same name can override it when deploying
another cluster. The workflow validates RSA X.509 and rejects SSH keys,
private keys, expired/invalid certificates. The Sealed Secrets controller
private key must remain in Kubernetes, with an independent secure backup.

That public certificate is DIFFERENT from the TLS certificate needed by
the public Nession MCP HTTPS Ingress. Staging MCP TLS can instead be explicitly
provisioned through the protected TLS target described below, after resolving
any pre-existing cert-manager/ACME/Higress certificate owner.

## First-time setup and operation

1. In Nession GitHub Settings -> Environments, create/protect the Environment
   **staging** (not "staging-mcp"). Require owner approval and restrict
   deployment branches to trusted main. This Environment will contain every
   independently managed staging Secret.
2. Create Repository Variable SEALED_SECRETS_CERT_PEM, using the full raw PEM
   fetched from the **live Sealed Secrets controller** as above.
3. Create one Environment Secret MCP_CONFIG_TOML. Paste the ORIGINAL, private,
   multiline TOML config text directly, using the template in
   gitops/environments/staging/mcp/mcp.example.toml. It must use distinct
   nonempty MCP inbound and Server backend tokens; include the exact
   staging-mcp-nession.bestnathan.top Host; set 0.0.0.0:9090 and the actual
   staging Server endpoint. No JSON quotes, escaping, or base64.
4. Merge MCP GitOps overlay PR #3905, then merge the workflow PR #3913.
   A new MCP Pod may remain pending until its missing Secret is reconciled.
5. In GitHub Actions select "Deploy / Seal GitOps Secret", with
   environment = staging and secret = MCP_CONFIG_TOML, on main.
   The protected Environment is approved, then the workflow validates the
   public cert and exact registry mapping, uses the one selected Secret,
   runs pinned kubeseal offline with strict scope, and commits only the
   encrypted sealed-secret.json file and Kustomize resource reference
   under gitops/environments/staging/mcp.
6. Argo CD reconciles the encrypted SealedSecret object. The existing
   controller converts it into the Kubernetes Opaque Secret. Verify Secret
   reconciliation, MCP Pod readiness, then an authenticated MCP request from
   outside the cluster.

## Security / rotation contract

- GitHub Actions does not receive the Sealed Secrets controller private key
  or any kubeconfig; the public cert is safe to distribute.
- GitHub Environment Secrets are not readable as plaintext via GitHub's
  REST API; they are injected only into an authorized workflow execution.
- One workflow invocation seals one registered raw GitHub Secret. Never
  print it or store the plaintext Kubernetes Secret in GitOps/artifacts.
- A temporary plaintext Secret document exists only in 0600 runner files and
  is removed after the sealing step. The checked-in resource contains
  only encryptedData and strict resource identity.
- Strict sealing binds ciphertext to the precise namespace and Secret name.
  The output file path is restricted to the same GitOps environment.
- Re-running may produce different ciphertext due to encryption randomness,
  but never duplicates the Kustomize resource reference.
- Controller key rotation: update the public PEM variable and re-seal affected
  entries as needed; securely back up the controller's private key material.
- Previously committed plaintext Server tokens and nitops TLS private keys
  need coordinated rotation. Re-encryption does not reverse their exposure.
- GitOps Sync / CI success is NOT evidence of a live usable Kubernetes Secret,
  public HTTPS TLS, or an authenticated remote MCP handshake.
\n## Main-merge one-time bootstrap (#3912)\n\nA restricted `push` trigger runs when `.github/workflows/deploy-seal-gitops-secret.yml` itself is merged to `main`. This trigger selects only the registered `staging/MCP_CONFIG_TOML` resource. GitHub Environment protection/approval still applies, and the validated GitOps MCP overlay must exist before the run. Unrelated pushes to `main` do NOT regenerate the ciphertext. On later credential changes use the existing manual `workflow_dispatch` and select the specific registered resource. The producer has no access to the SealedSecrets controller private key or to Kubernetes credentials.\n
## Strict GitOps publication (Bug #3921)

A successful offline seal does not imply the encrypted manifest has reached
GitOps. The source-owned publisher treats `gitops` as a data checkout and
commits only the registered `sealed-secret.json` and the matching
`kustomization.yaml`. Its `git status --porcelain=v1` parser preserves both
status columns (including the leading space of an unstaged ` M` record) so
the exact target-path allowlist cannot falsely reject valid Kustomize changes.
Unexpected paths still fail closed and do not get staged or committed.

Initial protected bootstrap run #44280180970 reached and passed the offline
`kubeseal` step but failed publication due to a trimmed status prefix.
The corrective publish workflow runs after the reviewed source fix is merged
to `main`; confirm both the successful Action and the actual encrypted
resource on `gitops` before relying on Argo CD reconciliation. Cluster
readiness itself requires an independent Kubernetes observation.


## Staging MCP HTTPS TLS — Cloudflare Origin CA issuance (#3936, #3992)

**One TLS Secret owner:** `Deploy / Configure Site → issue-tls` now owns
the staged site's Origin CA certificate issuance and strict SealedSecret
publication. The former `Deploy / Seal GitOps Secret → MCP_TLS_PEM_BUNDLE`
manual upload target is **retired**. Existing encrypted Kubernetes identity,
`nession/nession-mcp-staging-tls`, and GitOps resource
`environments/staging/mcp/sealed-tls.json` remain unchanged.

The Cloudflare DNS Zone, existing `staging/CLOUDFLARE_API_TOKEN` Environment
Secret, `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_ORIGIN_IPV4` Environment
Variables are **reused**. No additional Cloudflare credential is required by
the workflow. The token must have sufficient provider API permissions to call
Origin CA `POST /client/v4/certificates`. A successfully authorized DNS
request by itself does not prove that issuance is authorized.

After running `Deploy / Configure Site → apply` and seeing the provider
readback for a Nession-owned proxied record, manually run:

```sh
gh workflow run deploy-configure-site.yml -R BestNathan/nession --ref main \
  -f site=staging-mcp -f action=issue-tls
```

The trusted main source pins the exact first-level SAN
`staging-mcp-nession.bestnathan.top`, confirms active Cloudflare Zone and
owned proxied DNS before creating an RSA private key and CSR on the protected
runner. It requests a one-year Origin CA certificate through the Cloudflare
API, validates that the resulting leaf covers that exact SAN, matches the
locally generated private key, is not self-signed and has adequate validity.

The leaf/key bundle is written **only to ephemeral, mode 0600 runner files**.
The existing `SEALED_SECRETS_CERT_PEM` public certificate and pinned
`kubeseal --scope strict` produce encrypted `tls.crt` and `tls.key`
for the same resource identity. The existing bounded GitOps publisher writes
**only encrypted** `sealed-tls.json` and its Kustomization registration.
The runner deletes plaintext work files. No new `MCP_TLS_PEM_BUNDLE`
Environment Secret value is needed; do not attempt to provide a PEM in
workflow inputs, repository files, comments or artifacts.

This operation is deliberately **explicit**, not run on each DNS `apply`,
so retries do not unnecessarily mint/revoke certificates. A new
`issue-tls` run rotates the Origin CA certificate and the SealedSecret;
prior Cloudflare Origin CA certificates are not automatically revoked.
Monitor validity and plan renewal separately. Deployment and application
health still need independent readback; GitHub Actions success is not
Kubernetes success. The Sealed Secrets controller's public encryption
certificate is *not* the Cloudflare Origin CA certificate.

**Do not enable MCP ingress.yaml** merely because TLS encryption succeeded.
Confirm controller-created TLS Secret, Argo CD sync, public DNS, HTTPS trust
and HTTP redirect behavior first; then activate ingress.yaml through a
separate reviewed GitOps change. Live K8s acceptance is not implied by a
successful GitHub workflow.

Safe read-only K8s checks:

~~~bash
kubectl -n argocd get application nession-mcp-staging
kubectl -n nession get sealedsecret nession-mcp-staging-tls
kubectl -n nession get secret nession-mcp-staging-tls -o jsonpath='{.type}{"\n"}'
kubectl -n nession get ingress nession-mcp-staging
~~~

Avoid dumping the Kubernetes TLS Secret with -o yaml, which exposes
base64-decodable private-key material.

## One-level Cloudflare hostname migration (#3945)

The staging MCP endpoint is now `https://staging-mcp-nession.bestnathan.top/mcp`.
The old multi-label `staging.mcp.nession.bestnathan.top` DNS name is no longer allowed. Cloudflare Universal SSL on the `bestnathan.top` zone ordinarily covers first-level hosts such as `staging-mcp-nession.bestnathan.top`, not the old multi-level hostname. A Cloudflare DNS record and its active Edge certificate must still be verified independently.

Migration order: (1) keep the new GitOps Ingress staged but excluded from Kustomization; (2) after Cloudflare DNS apply verification, run `Deploy / Configure Site` with `action=issue-tls` using the existing protected Cloudflare Token to create an Origin CA cert and seal it directly; (3) independently update `staging/MCP_CONFIG_TOML` with the new public `allowed_hosts` and re-seal it using `Deploy / Seal GitOps Secret` with `secret=MCP_CONFIG_TOML`, retaining internal Service Host entries and bearer credentials; (4) verify the **deployed** Kubernetes TLS certificate SAN and effective running MCP config (restart when necessary), Cloudflare Edge TLS and Origin trust; (5) enable the staged Ingress via a separate GitOps PR only after preflight. Never expose the private key or tokens in issues, PRs or logs, and never disable TLS verification for bearer-authenticated clients.

A `kubernetes.io/tls` Secret existing is not proof its SAN changed. The current old self-signed certificate cannot satisfy Cloudflare Full (strict) origin verification. Use a publicly trusted certificate (or an explicitly Cloudflare-trusted Origin CA certificate for proxied-only traffic) and verify the presented Edge certificate and origin TLS separately. Manual Certbot DNS challenge does not auto-renew without automation.
