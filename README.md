# gitops — Nession deployment desired state

Orphan branch consumed by ArgoCD. **Application source lives on `main`; this
branch carries deployment desired state only** (issue #592, scoped 2026-09-05
to deployment decoupling — the development flow keeps its staging-branch
gates and staging→main releases). Deployment history doubles as audit log:

```
deploy(staging): abc1234       ← staging-branch auto-deploy (retained flow)
deploy(staging-01): abc1234    ← manual deploy of a validated commit
deploy(production): 0.36.0     ← release promotion (Environment approval)
```

## Environments

| env | namespace | storage | driven by | role |
|-----|-----------|---------|-----------|------|
| `staging` | `nession` (`-staging` names) | legacy shared NFS via subPath, incl. the historical shared claude-home | `staging.yml` auto-deploy on every staging-branch push | **the retained staging env** — byte-identical replica of the pre-cutover overlay |
| `staging-01` | `nession` (`-staging-01` names) | own PVs → `/mnt/share/k8s/staging-01{,/claude-home}` | `deploy.yml` manual dispatch at an exact SHA | on-demand validation of specific commits |
| `preprod` | `nession` (`-preprod` names) | own PVs → `/mnt/share/k8s/preprod{,/claude-home}` | nothing (dispatch-ready via `deploy.yml`) | **dormant** — reserved; not part of the release flow |
| `production` | `nession` (unsuffixed names) | zero-copy PVs → the pre-existing `/mnt/share/k8s/production` + `/mnt/share/k8s/nession/claude-home` | `release.yml` `promote-production` behind GitHub Environment `production` approval | live |

All environments live in the shared **`nession`** namespace. Each overlay
sets `nameSuffix` (`-staging`, `-staging-01`, `-preprod`; production is the
unsuffixed base), so their deployments, services, ingress and storage are
distinguished by name, not by namespace. The trusted deployment-identity
policy derives the expected workloads from `namespace` + `nameSuffix` and
requires the pod `env` label to match.

## Who writes here

All three are `main`-side workflows that invoke `scripts/gitops-commit.sh`
(the only gitops writer — kustomize edit + `deploy(<env>): <ref>` commit +
rebase-retry push):

- `.github/workflows/staging.yml` → job `deploy-staging-gitops`: staging-branch push auto-deploys `staging` at the built SHA.
- `.github/workflows/deploy.yml`: manual `workflow_dispatch` deploys any environment at an exact SHA.
- `.github/workflows/release.yml` → job `promote-production`: release promotions to `production` at SemVer tags (Environment approval).
- Humans — only for rollback (`git revert` a deploy commit + ArgoCD re-sync).

Do **not** put `[skip ci]` in deploy commits. Note that GitHub does not fire
workflows for pushes made with `GITHUB_TOKEN` — the workflow-bot deploy
commits therefore never run `gitops-guard`; their defense is
`gitops-commit.sh`, which refuses to write non-SemVer tags to `production`
pre-push. Guard runs on human pushes (rollback reverted, hand edits) as the
second line.

## Server rollout strategy

`base/nession/deployment-server.yaml` uses `strategy.type: Recreate`. The
Server holds an exclusive lifetime lock on its durable image build root
(`/data/server/images/build/.owner.lock`, #3334); `RollingUpdate` would start a
replacement while the old pod still owns the lock, so the new manager would
fail closed and the rollout would deadlock (#3454). Recreate terminates the old
pod before starting the replacement, preserving the documented single-owner
condition. Do not change this to RollingUpdate without first replacing the
lifetime lock with a rolling-update-safe ownership model.

## Guard and app management

- `gitops-guard` CI (this branch's `.github/workflows/`) rejects any
  non-desired-state path (`argocd/`, `base/`, `environments/`, README and the
  guard itself are the only allowed ones) and non-SemVer tags in
  `environments/production/**`. Stateless: validates the whole tree at HEAD.
- ArgoCD apps are **self-managed**: `argocd/app-of-apps.yaml` was applied once
  (`kubectl apply`) → `nession-root` owns the four child apps in
  `argocd/apps/`. (They were previously declared in the nitops repo — handed
  over 2026-09-05; nitops no longer references nession anywhere.)
- Every child app carries `syncOptions: [CreateNamespace=true, Replace=true]`.
  **Replace matters**: without it ArgoCD 3-way-merges and keeps live-only
  fields the manifest dropped (measured: old `subPath` survived onto new
  zero-copy PV paths, mounting `/mnt/share/k8s/production/production`).
- Changes to child-app specs reach the cluster via the **root app's** sync —
  refreshing a child alone is not enough.

## Layout

```
argocd/                    root app + child apps (source of truth for ArgoCD)
base/nession/              env-agnostic deployments/services/ingress/secret
environments/<env>/nession one overlay per environment: namespace,
                           nameSuffix, PV/PVC, claims, ingress hosts, image tags
```

**Adding an environment** = add `environments/<env>/nession/` + a child app
in `argocd/apps/` + its DNS records. If more than one extra environment is
foreseen, switch the static child apps to an ApplicationSet first.

## Canonical hostnames and TLS ownership (#4588)

Every Server/Agent/UI site has a **canonical single-label** `bestnathan.top`
host (`env-service-nession`, production omits the env and server prefix):

| env | server | agent | ui | mcp |
|---|---|---|---|---|
| production | `nession` | `agent-nession` | `ui-nession` | `mcp-nession` (dormant) |
| staging | `staging-nession` | `staging-agent-nession` | `staging-ui-nession` | `staging-mcp-nession` (active) |
| staging-01 | `staging-01-nession` | `staging-01-agent-nession` | `staging-01-ui-nession` | — |
| preprod | `preprod-nession` | `preprod-agent-nession` | `preprod-ui-nession` | — |

(suffix `.bestnathan.top`). The nested `<env>.nession.*` / `<env>.agent.nession.*`
names are retained as LAN compatibility during migration and retired only after
cutover readback; `nhome.local` hosts and their manual AdGuard records are
preserved verbatim. Server/Agent/UI are private; only the existing MCP sites may
be public (exact `/mcp`, authenticated). DNS activation and the public/private
route policy are owned by the site-registry issue #4589, not by this branch.

**TLS ownership.** cert-manager, the DNS-01 ClusterIssuer and the single wildcard
Certificate `*.bestnathan.top` live in the **nitops** repo (BestNathan/nitops#2),
in the serving `slb` namespace; the target Secret is owned exclusively by
cert-manager and SLB nginx is the actual client-facing TLS terminator forwarding
HTTP to Higress. Nession installs no cert-manager, issues no certificate, and
writes no competing Certificate/Issuer/SealedSecret. The canonical hosts are
covered by the nitops wildcard SAN; Nession ingress objects declare no
bestnathan.top TLS block of their own once the legacy Higress Origin CA TLS
(`environments/staging/mcp/sealed-tls.json` → `nession-mcp-staging-tls`) is
retired. That retirement, and any consumption switch, is **blocked** until a
sanitized cutover readback receipt is recorded; rollback restores route/config
desired state only and never rolls back cert-manager or deletes shared Secrets.

The executable contract owners are `scripts/gitops-host-contract.mjs` (SC-01:
canonical hosts, backends, preserved nhome.local, dormant MCP) and
`scripts/gitops-tls-contract.mjs` (SC-03: ownership, readiness-gated retirement)
on `main`, run as the `gitops-host-contract` / `gitops-tls-contract` Gates against
this branch. Live LAN/public probes and certificate readback are the separate
operational gate (SCN-07); a green PR is not a rollout.

## Bootstrap checklist for a NEW environment

1. NFS: create the directories on the NFS server
   (`/mnt/share/k8s/<env>` and `/mnt/share/k8s/<env>/claude-home`),
   correct ownership/perms (production's dirs already exist).
2. DNS: the canonical single-label hosts `<env>-nession`, `<env>-agent-nession`,
   `<env>-ui-nession` on `bestnathan.top` (production: `nession`, `agent-nession`,
   `ui-nession`), plus the preserved `<env>.nession.*` / `<env>.agent.nession.*` /
   `<env>.ui.nession.*` on `nhome.local`. LAN split-horizon DNS and any public MCP
   record are reconciled by the protected site workflow (#4589), not by hand.
3. Shared-namespace resources ArgoCD cannot create from manifests: the
   `ghcr-secret` docker-registry secret already exists in namespace `nession`
   and is used by every environment; only a different target namespace would
   need its own mirror.
4. ArgoCD child app (`argocd/apps/`).
5. Wait for sync, verify pods Running and data dirs visible.

## Cutover record (executed 2026-09-05)

All done and verified (historical record; the per-environment namespaces in
step 4 were later converged — see the 2026-10-27 correction below):

1. ✅ Pre-cutover state recorded (apps / PV / PVC / pods).
2. ✅ Production switched to zero-copy PVs (`prod-data`, `prod-claude-home`
   → the pre-existing NFS dirs); live data verified on the new mounts
   (`server.db` history intact, claude-home full state). Rollout used the
   surviving `nession` app name (rename would cascade-delete via the
   resources-finalizer).
3. ✅ `staging` env adopted byte-identically (455-line render, 0 diff) — no
   pod churn; storage objects moved into `environments/staging` manifests.
4. ✅ `nession-staging-01` + `nession-preprod` created (namespaces, PVCs,
   `ghcr-secret`, fresh NFS dirs); first images `*-cfb4cc9` / `*-0.35.0`.
5. ✅ Nitops handover: `apps/nession.yaml` + `apps/nession-staging.yaml`
   deleted there (nitops PR #1) — apps app relinquished the Applications.
6. ✅ `nession-root` applied once from `argocd/app-of-apps.yaml`; all four
   child apps tracked by it, all Synced.
7. ✅ Post-cutover fixes: `Replace=true` restored (see Guard section);
   dead production storage objects pruned; Released out-of-band PV deleted;
   double-subPath junk dirs removed from NFS.

Storage leftovers (deliberate, known):

- Out-of-band PV `nession-nfs-staging-server` — never in any manifest but
  bound by the staging data claim (`nession-server-data-staging`). Working;
  left unmanaged rather than risk rebinding. Adopt or retire it next time
  staging storage changes.
- The `Prune=false` annotations from the cutover on legacy objects are gone
  with the objects they protected.

Rollback if broken: revert the deploy commit on this branch
(`git revert` + push — ArgoCD syncs back). NFS data is never touched by
desired-state changes.

## Namespace convergence (2026-10-27)

Owner model: one shared `nession` namespace, environments distinguished by
`nameSuffix`. `staging-01` (`663025754`) and `preprod` (`16d02512f`) moved off
their own namespaces into `nession` as `nameSuffix: -staging-01` / `-preprod`,
keeping their existing NFS dirs. Their ArgoCD apps keep the lane names but now
target `nession`. The old `nession-staging-01` / `nession-preprod` namespaces
are empty; the `kube-root-ca.crt` configmap is namespace-controller managed.
