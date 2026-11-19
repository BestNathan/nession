# GitHub Environments -> one SealedSecret per raw Secret (#3912)

One GitHub Environment Secret maps to exactly one Kubernetes Secret and one
encrypted SealedSecret Kubernetes resource. The GitHub Secret holds original
raw text, **not JSON, base64, or a multi-secret bundle**. A single Kubernetes
TLS Secret has two required data keys: tls.crt and tls.key.

## Environment naming convention

GitHub Environment names must match GitOps environment directory names:
- staging -> gitops/environments/staging
- staging-01 -> gitops/environments/staging-01
- preprod -> gitops/environments/preprod
- production -> gitops/environments/production

The workflow permits the separate **staging/MCP_CONFIG_TOML** and
**staging/MCP_TLS_PEM_BUNDLE** targets. Additional pairs need a reviewed
registry entry and workflow choice; inputs may not define
an arbitrary namespace, output path, or secret name. Multiple independent
GitHub Secrets can coexist under the same GitHub Environment without being
merged into a single Kubernetes Secret.

## Registered resource

| GitHub Environment | GitHub Secret | Kubernetes Secret | data key | GitOps encrypted resource |
|---|---|---|---|---|
| staging | MCP_CONFIG_TOML | nession/nession-mcp-config-staging (Opaque) | mcp.toml | environments/staging/mcp/sealed-secret.json |
| staging | MCP_TLS_PEM_BUNDLE | nession/nession-mcp-staging-tls (kubernetes.io/tls) | tls.crt + tls.key | environments/staging/mcp/sealed-tls.json |

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


## Staging MCP HTTPS TLS — one raw PEM Secret (#3936)

**Only use this workflow when Nession GitOps owns the staging MCP TLS Secret.**
If cert-manager, Higress or nitops already manages that same Secret, decide on
one owner and coordinate migration before sealing it. The Sealed Secrets
controller's public encryption certificate is different from the HTTPS cert.

Under GitHub Settings → Environments → staging → Environment Secrets, create
MCP_TLS_PEM_BUNDLE. Its original raw value is **PEM, not JSON/base64**:
first the leaf certificate, next any ordered intermediate certificates,
then the corresponding **unencrypted private key**. Example structure
(placeholders here are NOT valid credentials; never upload placeholders):

~~~text
-----BEGIN CERTIFICATE-----
<leaf certificate>
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
<intermediate certificate, when present>
-----END CERTIFICATE-----
-----BEGIN PRIVATE KEY-----
<matching private key>
-----END PRIVATE KEY-----
~~~

PKCS#1 RSA/EC keys are also supported. The original bundle must contain only
certificate blocks followed by exactly one matching unencrypted private key.
Do not put private keys in Git, Issues, comments or workflow input text.

The loader checks hostname SAN staging-mcp-nession.bestnathan.top, cert validity
(now and more than seven days remaining), key match, and ordered intermediate
chain signatures. It rejects unexpected PEM blocks, duplicate or encrypted
keys, wrong hostname, bad chain, expired/soon-expiring certificates and
mismatched keys **before sealing**. This is not an independent public CA trust
test; external verification is still required.

Once this implementation is merged to main, manually run:
https://github.com/BestNathan/nession/actions/workflows/deploy-seal-gitops-secret.yml
with environment=staging and secret=MCP_TLS_PEM_BUNDLE. The existing protected
Environment gate and offline strict kubeseal path applies. The single GitHub
Secret becomes Kubernetes Secret nession/nession-mcp-staging-tls with type
kubernetes.io/tls and exactly two encrypted keys (tls.crt, tls.key), published
as environments/staging/mcp/sealed-tls.json. Its Kustomization resource entry
is added idempotently alongside sealed-secret.json for MCP configuration.
No plaintext key is committed or uploaded as an artifact.

The main-push bootstrap remains hard-bound to MCP_CONFIG_TOML. It does NOT
attempt TLS automatically: TLS generation/renewal requires explicitly
selecting the new target and provisioning the PEM bundle. For renewal,
replace the raw Environment Secret and manually run the same TLS selection;
then verify Argo CD/Sealed Secrets reconciliation and the actual active
certificate after the Ingress controller reload. Maintain an independent
expiration monitor. Sealing does not automatically renew certificates.

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

Migration order: (1) stage the updated GitOps Ingress and temporarily exclude `ingress.yaml`; (2) after the registered hostname check above reaches `main`, replace Environment Secret `staging/MCP_TLS_PEM_BUNDLE` with a new trusted fullchain PEM and matching private key for the **new** SAN, then manually run `Deploy / Seal GitOps Secret` selecting that target; (3) update `staging/MCP_CONFIG_TOML` with `allowed_hosts` including the new public hostname and no old hostname, keeping the private Service host entries and separate inbound/backend tokens, then seal it with the same workflow's `MCP_CONFIG_TOML` selection; (4) verify the **actual Kubernetes TLS certificate SAN and MCP config** (and pod config reload/restart), Cloudflare DNS, Edge TLS and origin trust; (5) enable the staged Ingress via a separate GitOps PR only after preflight. Never include TLS private keys or bearer tokens in an issue/PR/log, and never use insecure TLS verification with auth tokens.

A `kubernetes.io/tls` Secret existing is not proof its SAN changed. The current old self-signed certificate cannot satisfy Cloudflare Full (strict) origin verification. Use a publicly trusted certificate (or an explicitly Cloudflare-trusted Origin CA certificate for proxied-only traffic) and verify the presented Edge certificate and origin TLS separately. Manual Certbot DNS challenge does not auto-renew without automation.
