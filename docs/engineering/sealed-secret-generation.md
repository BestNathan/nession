# Protected GitHub Environment → SealedSecret (#3912)

The private Sealed Secrets controller key remains inside Kubernetes. The
main-owned GitHub Actions workflow only needs the controller's PUBLIC sealing
certificate. It does not need kubectl or a Kubernetes credential.

## First target: staging-mcp

Target mapping is fixed in scripts/ci/seal-gitops-secret.mjs:
- GitHub Environment: staging-mcp
- K8s Secret: nession / nession-mcp-config-staging, Opaque, key mcp.toml
- Encrypted output: gitops/environments/staging/mcp/sealed-secret.json
- Kustomize enrollment: gitops/environments/staging/mcp/kustomization.yaml

Future resources are added through reviewed allowlist/workflow changes, not
through arbitrary workflow inputs.

## Owner setup

1. Read the PUBLIC certificate from the existing controller Service in nitops:

   kubeseal --fetch-cert --controller-namespace kube-system \
     --controller-name sealed-secrets-controller > public.pem

   Verify its SHA256 fingerprint against the trusted controller; never export
   the Sealed Secrets controller PRIVATE key to GitHub.

2. Create protected GitHub Environment "staging-mcp" with required reviewers
   and main-branch restriction. Add public variable
   SEALED_SECRETS_CERT_B64 = base64-encoded public.pem (single line).
   Put it at the repository level to reuse a single cluster sealing certificate
   across environments, or override it at Environment level if targets use
   different clusters. The private controller key never goes to GitHub.
   Example: base64 < public.pem | tr -d '\n'

3. Add Environment Secret K8S_SECRET_DATA_JSON as a JSON map. It must contain
   EXACTLY one key, "mcp.toml", with the entire private TOML configuration.
   The TOML needs [mcp], [backend.server], both different nonempty auth tokens,
   listen_address = "0.0.0.0:9090", and a Host allowlist including
   staging.mcp.nession.bestnathan.top. Use the config template from GitOps
   PR #3905 but fill credentials inside GitHub's protected Environment only.

4. Merge GitOps staging MCP overlay PR #3905 before running the workflow.
   The new pod may be pending until its sealed config is reconciled. The first
   workflow run adds sealed-secret.json and registers it in Kustomization.

5. In Actions run "Deploy / Seal GitOps Secret" from main with target staging-mcp.
   The protected Environment approval then permits offline sealing and the
   encrypted GitOps commit. Argo CD and the Sealed Secrets controller reconcile
   the resulting ordinary Kubernetes Secret.

## Security and lifecycle

- The workflow is main-only and uses a target allowlist; it never executes code
  from the gitops branch, reads unrelated Environment Secrets, or prints tokens.
- Ordinary K8s Secret JSON exists only in restrictive runner temporary files,
  cleaned on step exit. GitOps receives only encrypted SealedSecret JSON.
- Strict scope binds ciphertext to exact namespace AND Secret name. Do not
  use cluster-wide or namespace-wide modes.
- SealedSecret encryption is randomized: repeated invocations can produce a new
  ciphertext even if credentials are unchanged. The Kustomize resource entry
  is idempotent; run only for explicit provisioning and credential rotation.
- When the sealing controller renews its keypair, update the GitHub Environment
  public certificate from the live controller and re-seal as appropriate.
  Preserve an encrypted recovery backup of controller private keys outside
  GitHub; do not freeze key rotation permanently.
- The sealing certificate is unrelated to the ingress HTTPS certificate.
  Public HTTPS still requires a trusted CA chain (for example ACME/cert-manager).
- Existing committed Server tokens and TLS private keys must be rotated; a
  SealedSecret cannot reverse previous plaintext disclosure.
- Verify the real SealedSecrets reconciliation, MCP pod startup and authenticated
  off-cluster /mcp handshake independently of Actions success.
