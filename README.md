# gitops — Nession deployment desired state

Orphan branch consumed by ArgoCD. **Application source lives on `main`; this
branch carries deployment desired state only** (issue #592). Deployment
history on this branch doubles as the audit log:

```
deploy(staging-01): abc1234    ← manual deploy of a validated main commit
deploy(preprod): 0.36.0        ← release promotion
deploy(production): 0.36.0     ← release promotion (Environment approval)
```

## Who writes here

- `.github/workflows/deploy.yml` (on `main`) — manual `workflow_dispatch` deploys to any environment at an exact SHA.
- `.github/workflows/release.yml` (on `main`) — release promotions to preprod/production at SemVer tags.
- Humans — only for rollback (`git revert` a deploy commit + ArgoCD re-sync).

`gitops-guard` CI rejects non-`gitops/**` paths and non-SemVer tags in
`environments/production/**`. Push commits on top of the remote tip; two
writers never race thanks to the `gitops-writer` concurrency group plus a
rebase-retry loop in `scripts/gitops-commit.sh`.

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

## Cutover (Phase 2) checklist

1. Record pre-cutover state: `kubectl -n argocd get applications -o yaml`,
   `kubectl get pv,pvc -A`, `kubectl -n nession get pods -o wide`.
2. Protect legacy shared storage from ArgoCD prune (not part of this tree):
   ```
   kubectl annotate pv nession-nfs argocd.argoproj.io/sync-options=Prune=false
   kubectl -n nession annotate pvc nession-server-data claude-tools argocd.argoproj.io/sync-options=Prune=false
   ```
3. Re-point the root app once:
   `kubectl apply -f argocd/app-of-apps.yaml` (source → `gitops`).
4. Verify: production zero-copy rollout (existing data visible under
   `/data` and `/root/.claude`), `nession-staging-01`/`nession-preprod`
   namespaces created, legacy `-staging` resources pruned (expected blast
   radius — their data stays orphaned on NFS under `/mnt/share/k8s/staging`
   until Phase 6 teardown).
5. Rollback if broken: `kubectl apply -f <pre-cutover app-of-apps backup>` —
   NFS data is never touched by the cutover either way.
