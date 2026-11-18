# GitHub Environments -> one SealedSecret per raw Secret (#3912)

One GitHub Environment Secret maps to exactly one Kubernetes Secret and one
encrypted SealedSecret Kubernetes resource. The GitHub Secret holds the original
raw text, **not JSON, base64, or a multi-secret bundle**.

## Environment naming convention

GitHub Environment names must match GitOps environment directory names:
- staging -> gitops/environments/staging
- staging-01 -> gitops/environments/staging-01
- preprod -> gitops/environments/preprod
- production -> gitops/environments/production

The workflow currently permits **only staging/MCP_CONFIG_TOML**. Additional
pairs need a reviewed registry entry and workflow choice; inputs may not define
an arbitrary namespace, output path, or secret name. Multiple independent
GitHub Secrets can coexist under the same GitHub Environment without being
merged into a single Kubernetes Secret.

## Registered resource

| GitHub Environment | GitHub Secret | Kubernetes Secret | data key | GitOps encrypted resource |
|---|---|---|---|---|
| staging | MCP_CONFIG_TOML | nession/nession-mcp-config-staging | mcp.toml | environments/staging/mcp/sealed-secret.json |

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
the public Nession MCP HTTPS Ingress. ACME/cert-manager or a trusted
gateway certificate remains a separate prerequisite.

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
   staging.mcp.nession.bestnathan.top Host; set 0.0.0.0:9090 and the actual
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