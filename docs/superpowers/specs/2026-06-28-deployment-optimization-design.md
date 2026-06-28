# Deployment Optimization Design: Docker Build & ArgoCD Standardization

**Date**: 2026-06-28  
**Status**: Approved  
**Scope**: Optimize CI Docker build efficiency and standardize CD with ArgoCD

---

## Problem Statement

1. **Docker build is slow**: Multi-platform (amd64 + arm64) Rust builds take 10-15 minutes due to frequent dependency recompilation
2. **Manual CD process**: After CI pushes images to GHCR, deployment files are manually updated, lacking full GitOps automation

---

## Solution Overview

### Part 1: Docker Build Optimization

#### Approach: Cargo Chef Pattern + sccache

**1. Enhanced Dockerfile with cargo-chef**

Use the `cargo chef` pattern to separate dependency compilation from source compilation:

```dockerfile
# Stage 1: Prepare recipe
FROM rust:1.87-bookworm AS planner
WORKDIR /build
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Build dependencies (cached layer)
FROM rust:1.87-bookworm AS cacher
WORKDIR /build
COPY --from=planner /build/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# Stage 3: Build web UI
FROM node:20-alpine AS web-builder
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# Stage 4: Build application (with sccache)
FROM rust:1.87-bookworm AS server-builder
WORKDIR /build
# Install sccache
RUN cargo install sccache
ENV RUSTC_WRAPPER=sccache
ENV SCCACHE_DIR=/sccache

# Copy cached dependencies
COPY --from=cacher /build/target target
COPY --from=web-builder /build/dist /usr/share/nginx/html

# Now copy source code (changes frequently)
COPY . .
RUN cargo build --release --bin nession-server

# Stage 5: Runtime
FROM debian:bookworm-slim AS runtime
# ... (existing runtime setup)
```

**Benefits**:
- Dependencies only rebuild when `Cargo.toml`/`Cargo.lock` change
- Source code changes don't trigger dependency recompilation
- Expected 60-80% faster builds after cache warm-up

**2. sccache Integration in GitHub Actions**

```yaml
- name: Setup sccache
  uses: mozilla-actions/sccache-action@v0.0.9

- name: Build and push
  uses: docker/build-push-action@v6
  with:
    # ... existing config
    cache-from: type=gha,scope=buildx
    cache-to: type=gha,mode=max,scope=buildx
```

**3. Multi-Platform Optimization**

Continue building both amd64 and arm64, but with better caching:
- Use `sccache` with S3/GCS backend for cross-platform cache sharing
- Or maintain separate cache keys per platform

**Expected Results**:
- Initial build: ~10-15 minutes (same as current)
- Incremental builds (source changes): ~2-3 minutes
- Dependency changes: ~8-10 minutes (still faster than current)

---

### Part 2: ArgoCD Standardized Deployment

#### Directory Structure

```
argocd/
  application.yaml          # ArgoCD Application resource
  app-project.yaml          # (optional) AppProject for multi-tenant isolation
k8s/
  kustomization.yaml        # Enhanced with images: transformer
  deployment.yaml
  service.yaml
  ingress.yaml
  namespace.yaml
  secret.yaml
  pvc.yaml
```

#### ArgoCD Application Manifest

**File**: `argocd/application.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nession
  namespace: argocd
spec:
  project: default
  
  source:
    repoURL: https://github.com/bestnathan/nession.git
    targetRevision: main
    path: k8s
  
  destination:
    server: https://kubernetes.default.svc
    namespace: nession
  
  syncPolicy:
    automated:
      prune: true           # Delete resources not in git
      selfHeal: true        # Revert manual changes
    syncOptions:
      - CreateNamespace=true
      - PruneLast=true
      - ApplyOutOfSyncOnly=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

#### Kustomize Image Transformer

**File**: `k8s/kustomization.yaml` (updated)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: nession

images:
  - name: ghcr.io/bestnathan/nession
    newTag: latest  # CI will update this

resources:
  - namespace.yaml
  - secret.yaml
  - deployment.yaml
  - service.yaml
  - ingress.yaml
```

#### CI Workflow Enhancement

**Updated GitHub Actions workflow**:

```yaml
name: Docker

on:
  push:
    branches: [main]
    tags: ['v*']

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository_owner }}/nession

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write      # Need write to commit kustomization.yaml
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Setup sccache
        uses: mozilla-actions/sccache-action@v0.0.9

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=buildx
          cache-to: type=gha,mode=max,scope=buildx
        env:
          SCCACHE_BUCKET: ""  # Configure if using external cache
          SCCACHE_S3_USE_SSL: "true"

      - name: Update Kustomize image tag
        run: |
          cd k8s
          IMAGE_TAG=${{ steps.meta.outputs.version }}
          kustomize edit set image ghcr.io/${{ github.repository_owner }}/nession:${IMAGE_TAG}

      - name: Commit and push kustomization.yaml
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add k8s/kustomization.yaml
          git diff --staged --quiet || git commit -m "chore: update image tag to ${{ steps.meta.outputs.version }}"
          git push
```

---

## Automated Workflow

**Complete GitOps flow**:

1. Developer pushes code to `main` branch
2. GitHub Actions triggers:
   - Builds multi-platform Docker image with optimized caching
   - Pushes to GHCR with SHA tag
   - Updates `k8s/kustomization.yaml` with new image tag
   - Commits and pushes the change
3. ArgoCD detects the commit:
   - Syncs the updated `kustomization.yaml` to cluster
   - Pulls the new image
   - Rolls out the deployment
4. Application is live in ~3-5 minutes (build) + ~30 seconds (sync)

---

## Implementation Checklist

### Phase 1: Docker Build Optimization
- [ ] Refactor Dockerfile to use cargo-chef pattern
- [ ] Add sccache to build stages
- [ ] Update GitHub Actions workflow with sccache-action
- [ ] Configure buildx cache properly
- [ ] Test build times and verify caching works

### Phase 2: ArgoCD Setup
- [ ] Create `argocd/` directory
- [ ] Write `argocd/application.yaml`
- [ ] Update `k8s/kustomization.yaml` with images transformer
- [ ] Update GitHub Actions to auto-commit kustomization.yaml
- [ ] Apply ArgoCD Application manifest to cluster
- [ ] Verify automated sync works end-to-end

---

## Success Criteria

1. **Build time**: Incremental builds complete in < 3 minutes (vs current 10-15 min)
2. **Deployment automation**: Zero manual steps between code push and deployment
3. **Reliability**: ArgoCD self-heals and prunes resources automatically
4. **Visibility**: All deployment state tracked in git with audit trail

---

## Notes

- Multi-platform builds (amd64 + arm64) are retained as required
- sccache can be extended with S3/GCS backend for cross-runner cache sharing
- ArgoCD Application can be extended with AppProject for multi-tenant isolation
- Consider adding ArgoCD Image Updater for more advanced image tag strategies
