# Production standalone MCP pilot (#4529)
Internal-only pilot: dedicated Argo CD Application, ClusterIP and no enrolled public Ingress.
The initial candidate is the existing staging GitOps tag mcp-924b161 (source 924b1615347aaf057c7fc7725469ccf2e88fb2f0).
Verify actual GHCR manifest and required architectures through trusted CI before activation. Mixed-version production compatibility remains unproven.
1. Merge production inbound registry support to main; manually dispatch Deploy / Seal GitOps Secret for production using the protected Environment.
2. Confirm encrypted resource enrollment and successful sealing, render the overlay and verify candidate architectures (protected run 45666573325 succeeded).
3. Enroll the dedicated nession-mcp-production Argo CD Application with ClusterIP only. Never update Server, Agent or UI as part of this pilot. Verify Pod readiness and internal MCP first. Enroll ingress.yaml in a separate reviewed change only after existing origin TLS/forwarding and no direct public HTTP bypass are verified.
4. Check authenticated initialize, tools/list and read-only Server agent-list; reject missing/invalid tokens; do not log tokens. If compatibility fails, remove only pilot Application.
The backend credential is referenced directly from nession-secret/auth-token; no separate copied Secret. The inbound Secret is nession-mcp-inbound-production/token. No staging ciphertext or credentials are reused.
Bearer only until proxy query-token log handling is verified. Cloudflare DNS is unchanged; existing operator-managed TLS termination must be confirmed before activation.
