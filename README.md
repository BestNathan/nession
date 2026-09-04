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

## Who writes here

- `.github/workflows/staging.yml` (on `main`) — staging-branch push auto-deploys `staging` at the built SHA.
- `.github/workflows/deploy.yml` (on `main`) — manual `workflow_dispatch` deploys to any environment at an exact SHA.
- `.github/workflows/release.yml` (on `main`) — release promotions to production at SemVer tags (Environment approval).
- Humans — only for rollback (`git revert` a deploy commit + ArgoCD re-sync).

`gitops-guard` CI rejects any non-desired-state path (`argocd/`, `base/`,
`environments/`, README and the guard itself are the only allowed ones) and
non-SemVer tags in `environments/production/**`. Push commits on top of the
remote tip; two writers never race thanks to the `gitops-writer` concurrency
group plus a rebase-retry loop in `scripts/gitops-commit.sh`.

## Layout

```
argocd/                    root app + child apps (source of truth for ArgoCD)
base/nession/              env-agnostic deployments/services/ingress/secret
environments/<env>/nession one overlay per environment: namespace, PV/PVC,
                           claims, ingress hosts, image tags
```

**Adding an environment** = add `environments/<env>/nession/` + its DNS
records (ApplicationSet will replace the static child apps before staging-02).

## Bootstrap checklist for a NEW environment

1. NFS: create the directories on the NFS server
   (`/mnt/share/k8s/<env>` and `/mnt/share/k8s/<env>/claude-home`),
   correct ownership/perms.
2. DNS (manual): `<env>.nession.*`, `<env>.agent.nession.*`,
   `<env>.ui.nession.*` on both `nhome.local` and `bestnathan.top`.
3. Namespace resources ArgoCD cannot create from manifests:
   - `ghcr-secret` docker-registry secret (mirror from namespace `nession`):
     `kubectl -n <ns> create secret docker-registry ghcr-secret --from-file=.dockerconfigjson=<(kubectl -n nession get secret ghcr-secret -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d)`
4. ArgoCD child app (`argocd/apps/`) or ApplicationSet entry.
5. Wait for sync, verify pods Running and data dirs visible.

## Cutover checklist (executed 2026-09-05)

1. ✅ Recorded pre-cutover state (apps / PV / PVC / pods).
2. ✅ `Prune=false` annotated on the out-of-band legacy PVs/PVCs
   (`nession-nfs{-server,-staging,-staging-server}`, `claude-tools{,-staging}`,
   `nession-server-data{,-staging}`) — they stay until Phase 6 teardown.
3. ✅ NFS dirs created for `staging-01`/`preprod` (`/mnt/share/k8s/<env>[/claude-home]`).
4. ✅ New namespaces + `ghcr-secret` created for `nession-staging-01`/`nession-preprod`.
5. ⏳ Nitops handover: delete `apps/nession.yaml` + `apps/nession-staging.yaml`
   from the nitops repo (apps app-of-apps relinquishes nession).
6. ⏳ Apply root app once:
   `kubectl apply -f argocd/app-of-apps.yaml` (source → `gitops`) — nession
   apps become self-managed from this branch.
7. Verify: production zero-copy rollout (existing data visible under `/data`
   and `/root/.claude`); `staging` env adopted with no pod churn (byte-identical
   manifests); `nession-staging-01`/`nession-preprod` namespaces sync.

Rollback if broken: `kubectl apply -f <pre-cutover apps backup>` — NFS data is
never touched by the cutover either way.
