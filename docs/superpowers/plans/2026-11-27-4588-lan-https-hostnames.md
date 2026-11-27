# #4588 — Unified LAN HTTPS/WSS hostnames and cert-manager TLS consumption

Status: implementation plan (provenance). Canonical contract owners: issue #4588
(owner decision 2026-11-26), sibling #4589 (site registry / DNS / workflow
retirement), BestNathan/nitops#2 (cert-manager / issuer / wildcard certificate /
actual SLB TLS termination).

## Verified baseline (2026-11-27, main c30b693a3 + origin/gitops)

- GitOps desired state lives on the orphan `gitops` branch; structural changes
  are PRs targeting `gitops` (precedent #4531/#4539). `scripts/gitops-commit.sh`
  only advances image tags. Main-side checkers render `origin/gitops`
  (`scripts/gitops-storage-contract.mjs` + Gate pattern).
- `base/nession/ingress-{server,agent,ui}.yaml` and
  `environments/{staging,staging-01,preprod}/nession/patch-ingress.yaml` declare
  nested `<env>.{nession,agent.nession,ui.nession}.bestnathan.top` plus parallel
  `nhome.local` hosts. Production server host `nession.bestnathan.top` is
  already the canonical single-label name.
- `environments/staging/mcp/` is enrolled and active: canonical host
  `staging-mcp-nession.bestnathan.top`, exact `/mcp`, Higress TLS from legacy
  Origin CA `sealed-tls.json` (Secret `nession/nession-mcp-staging-tls`).
- `environments/production/mcp/ingress.yaml` exists with canonical host
  `mcp-nession.bestnathan.top` but is **excluded** from the Kustomization
  (dormant; #4529 activation prerequisites apply). staging-01/preprod have no
  MCP overlay and must not gain one.
- `SERVER_ALLOWED_ORIGINS` (patch-server-env / production patch) lists nested
  bestnathan.top http+https origins and nhome.local http origins.
- Agent advertised endpoint: `AGENT_CONNECT_URL` → `connect_url`
  (`deploy/entrypoint-agent.sh`); production base
  `ws://agent.nession.nhome.local/ws`, staging
  `ws://staging.agent.nession.nhome.local/ws`. No multi-endpoint env projection
  exists yet; `advertise_addresses` is the designed multi-path mechanism.
- Web client scheme derivation (`web/src/app/useAppConnection.ts`) already maps
  page `https:` → `wss`, `http:` → `ws`; candidate URLs are never scheme-rewritten
  (`addressSelection.ts`). Server has no cookie auth (bearer only); CORS is the
  Origin allowlist (`origin_policy_allows`, `nession-common`
  `validate_origin_allowlist`, `nession-mcp` allowed_hosts/allowed_origins).
- `AgentConfig::validate` does not yet validate `connect_url` /
  `advertise_addresses[].url` schemes — fail-closed gap closed by this change.
- nitops#2 is OPEN with no certificate readiness readback: cert-manager
  installation / wildcard Certificate Ready is **unverified**. Activation and
  legacy retirement therefore stay blocked (SC-03 guard enforces this).

## Canonical hostname contract (shared with #4589)

Suffix `.bestnathan.top`, exactly one label before the suffix (no partial-label
wildcard). `env-service-nession` naming; production omits env and server prefix.

| env | server | agent | ui | mcp |
|---|---|---|---|---|
| production | nession | agent-nession | ui-nession | mcp-nession (dormant ingress) |
| staging | staging-nession | staging-agent-nession | staging-ui-nession | staging-mcp-nession (active) |
| staging-01 | staging-01-nession | staging-01-agent-nession | staging-01-ui-nession | — (no MCP) |
| preprod | preprod-nession | preprod-agent-nession | preprod-ui-nession | — (no MCP) |

Visibility (consumed from #4589): Server/Agent/UI private in every environment;
only staging-mcp and production-mcp may be public, exact `/mcp`, authenticated.
`nhome.local` hosts and AdGuard manual records are preserved verbatim. Legacy
nested bestnathan.top hosts/origins are retained as LAN compatibility during
migration and retired only after cutover readback (no continued public exposure
of private services).

## TLS ownership / consumption contract (SC-03)

- nitops owns cert-manager, the DNS-01 ClusterIssuer and the single wildcard
  Certificate `*.bestnathan.top` in the serving `slb` namespace; the target
  Secret is owned exclusively by cert-manager. SLB nginx is the actual
  client-facing TLS terminator for `*.bestnathan.top` and forwards HTTP to
  Higress. Nession installs no cert-manager, issues no certificate, and writes
  no competing SealedSecret/Certificate for that Secret.
- Nession consumes the certificate indirectly: canonical hosts must be covered
  by the nitops wildcard SAN; Nession ingress objects declare no bestnathan.top
  TLS block of their own once the legacy Higress Origin CA TLS is retired.
- Legacy chain (retirement owned by #4588 for GitOps objects, #4589 for the
  workflow/scripts): `deploy-configure-site.yml` issue-tls →
  `scripts/ci/issue-cloudflare-origin-ca.mjs` → `scripts/ci/seal-gitops-secret.mjs`
  TLS target → `environments/staging/mcp/sealed-tls.json` →
  `nession-mcp-staging-tls` → staging MCP ingress `spec.tls`.
- Retirement of the legacy GitOps TLS objects, and any switch of ingress TLS
  consumption to the cert-manager Secret, is **blocked** until a sanitized
  cutover readback receipt is recorded (GitOps revision, actual gateway
  identity, certificate serial/expiry/chain, run/attempt; no key material).
  Rollback restores route/config desired state; it never rolls back cert-manager
  or deletes shared Secrets.

## Delivery

Two PRs, both `Refs #4588`:

1. **gitops PR (base `gitops`)** — desired-state preparation, non-activating:
   canonical hosts added to base/env ingress (nhome.local + legacy nested
   retained), `SERVER_ALLOWED_ORIGINS` extended with https-only canonical
   origins, `AGENT_ADVERTISE_URLS` canonical WSS endpoints added (legacy
   nhome.local `connect_url` retained), README contract. No TLS object change,
   no dormant activation, no image promotion change. Merging rolls the
   server/agent pods of each lane (env change); new names resolve nowhere until
   #4589 DNS activation, so nothing is exposed.
2. **main PR (base `main`)** — application/config hardening, deterministic
   contract checkers + Gates + self-tests, docs/knowledge update:
   - `AgentConfig::validate` fail-closed ws/wss URL validation (+ tests).
   - `deploy/entrypoint-agent.sh` `AGENT_ADVERTISE_URLS` projection (+ config-only
     test seam) and an integration test feeding the real projection to the real
     `AgentConfig` parser.
   - Web `deriveServerSocketUrl` pure helper + unit tests (https→wss, http→ws,
     no downgrade); `useAppConnection` consumes it.
   - SC-02 exact-head transport/config negative tests (server WS origin policy,
     MCP Host/Origin/exact path, origin allowlist) with canonical host fixtures.
   - SC-01 `scripts/gitops-host-contract.mjs` + Gate + self-test: renders
     origin/gitops (or fixture tree), proves canonical single-label hosts,
     correct env backends, unchanged nhome.local, dormant MCP not activated.
   - SC-03 `scripts/gitops-tls-contract.mjs` + Gate + self-test: single
     certificate ownership, no duplicate issuer/Secret writer, readiness-gated
     consumption switch and retirement (receipt required), rollback safety.
   - Docs: `cloudflare-site-provisioning.md` TLS model + hostname contract +
     retirement gate (workflow/script retirement remains #4589's); knowledge
     update per nession-knowledge.

Merge order: the gitops PR must merge before the main PR's live-render
`gitops-host-contract` Gate can pass (it renders `origin/gitops`). Self-tests
prove the checkers deterministically at the PR SHA regardless.

## Verification / evidence

- SCN-01 for SC-01/02/03: exact PR SHA source + targeted manifest/render and
  config/protocol negative tests (new Gates + existing Rust/Web suites).
- Live LAN/public probes, certificate chain/renewal readback and deployed
  acceptance are the separate operational gate (SCN-07) and remain **Pending**:
  nitops#2 readiness unverified, #1616 production identity lane prerequisite.
  PR green is not rollout. nhome.local, credentials/auth, image promotion
  contract and unrelated workloads unchanged.
