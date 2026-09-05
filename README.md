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
| `staging-01` | `nession-staging-01` | own PVs → `/mnt/share/k8s/staging-01{,/claude-home}` | `deploy.yml` manual dispatch at an exact SHA | on-demand validation of specific commits |
| `preprod` | `nession-preprod` | own PVs → `/mnt/share/k8s/preprod{,/claude-home}` | nothing (dispatch-ready via `deploy.yml`) | **dormant** — reserved; not part of the release flow |
| `production` | `nession` | zero-copy PVs → the pre-existing `/mnt/share/k8s/production` + `/mnt/share/k8s/nession/claude-home` | `release.yml` `promote-production` behind GitHub Environment `production` approval | live |

## Who writes here

All three are `main`-side workflows that invoke `scripts/gitops-commit.sh`
(the only gitops writer — kustomize edit + `deploy(<env>): <ref>` commit +
rebase-retry push):

- `.github/workflows/staging.yml` → job `deploy-staging-gitops`: staging-branch push auto-deploys `staging` at the built SHA.
- `.github/workflows/deploy.yml`: manual `workflow_dispatch` deploys any environment at an exact SHA.
- `.github/workflows/release.yml` → job `promote-production`: release promotions to `production` at SemVer tags (Environment approval).
- Humans — only for rollback (`git revert` a deploy commit + ArgoCD re-sync).

Do **not** put `[skip ci]` in deploy commits — `gitops-guard` must run on every
push to this branch.

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
environments/<env>/nession one overlay per environment: namespace, PV/PVC,
                           claims, ingress hosts, image tags
```

**Adding an environment** = add `environments/<env>/nession/` + a child app
in `argocd/apps/` + its DNS records. If more than one extra environment is
foreseen, switch the static child apps to an ApplicationSet first.

## Bootstrap checklist for a NEW environment

1. NFS: create the directories on the NFS server
   (`/mnt/share/k8s/<env>` and `/mnt/share/k8s/<env>/claude-home`),
   correct ownership/perms (production's dirs already exist).
2. DNS (manual): `<env>.nession.*`, `<env>.agent.nession.*`,
   `<env>.ui.nession.*` on both `nhome.local` and `bestnathan.top`.
3. Namespace resources ArgoCD cannot create from manifests:
   - `ghcr-secret` docker-registry secret (mirror from namespace `nession`):
     `kubectl -n <ns> create secret docker-registry ghcr-secret --from-file=.dockerconfigjson=<(kubectl -n nession get secret ghcr-secret -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d)`
4. ArgoCD child app (`argocd/apps/`).
5. Wait for sync, verify pods Running and data dirs visible.

## Cutover record (executed 2026-09-05)

All done and verified:

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
