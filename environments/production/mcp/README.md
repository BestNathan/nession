# Production standalone MCP pilot (#4529)
Inactive overlay: no Argo CD Application is enrolled by this change.
The initial candidate is the existing staging GitOps tag mcp-924b161 (source 924b1615347aaf057c7fc7725469ccf2e88fb2f0).
Verify actual GHCR manifest and required architectures through trusted CI before activation. Mixed-version production compatibility remains unproven.
1. Merge production inbound registry support to main; manually dispatch Deploy / Seal GitOps Secret for production using the protected Environment.
2. Confirm encrypted resource enrollment and successful sealing, render the overlay, verify candidate digest, existing origin TLS/forwarding and no direct public HTTP bypass.
3. Review and enroll a dedicated nession-mcp-production Argo CD Application targeting this path. Never update Server, Agent or UI as part of this pilot.
4. Check authenticated initialize, tools/list and read-only Server agent-list; reject missing/invalid tokens; do not log tokens. If compatibility fails, remove only pilot Application.
The backend credential is referenced directly from nession-secret/auth-token; no separate copied Secret. The inbound Secret is nession-mcp-inbound-production/token. No staging ciphertext or credentials are reused.
Bearer only until proxy query-token log handling is verified. Cloudflare DNS is unchanged; existing operator-managed TLS termination must be confirmed before activation.
