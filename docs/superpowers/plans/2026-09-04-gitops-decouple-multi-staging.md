# GitOps 多环境发布模型 Implementation Plan (issue #592)

> ⚠ **Scope amended 2026-09-05 (owner decisions recorded on issue #592).** This
> plan's development-flow half was withdrawn: no feature→main, no release-please,
> no quality/e2e retarget — the staging-branch gate, staging→main releases and
> version-bump ritual are fully retained. What shipped is the deployment
> decoupling (Phase 0-2 + the amended Phase 3 executed 2026-09-05): `gitops`
> orphan branch consumed by ArgoCD, self-managed `nession-root` app-of-apps
> (after the nitops handover), per-env overlays incl. the retained byte-identical
> `environments/staging`, production zero-copy PVs, and staging.yml/release.yml
> writing gitops deploy commits (`scripts/gitops-commit.sh`; production behind
> Environment approval). `environments/staging-01` serves on-demand SHA deploys
> (`deploy.yml`); `preprod` is dormant. Phases below marked 🔒 executed 2026-09-05.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 标 🔒 的任务/步骤只能由仓库 owner 执行(集群或 GitHub 设置权限),agent 执行到该处即停下汇报。

**Goal:** 把 ArgoCD 消费的 desired state 从 `main` 迁到孤儿 `gitops` 分支,改为目录式多环境(staging-01/preprod/production),feature 分支经门禁直入 `main`,release-please 批量 SemVer 发布,生产 promotion 走 GitHub Environment 审批。

**Architecture:** 单一 GitHub 仓库承载两条分支:`main` = 应用源码历史(conventional commits),`gitops` = 部署 desired-state 历史(仅 bot 推送,兼作审计日志)。环境隔离按目录而非分支。`main` 上不再有任何触发部署的 workflow;部署 = 手动 dispatch(deploy workflow,按需构建 SHA 镜像)→ gitops deploy commit → ArgoCD 同步。

**Tech Stack:** GitHub Actions、ArgoCD Application/ApplicationSet、kustomize、release-please、ghcr、NFS PV/PVC、kubectl、gh CLI。

**Source of truth:** issue #592 正文(Requirements/Goals/Non-Goals/Decisions/Success Criteria/Edge Cases/Open Questions)。本计划与其冲突处,以 owner 在 issue 评论区的最新决策为准。

---

## 0. 执行者图例与阅读前置

| 标记 | 含义 |
|------|------|
| ☑ | agent 可执行(worktree 内) |
| 🔒 | owner 执行(集群 / GitHub 设置 / 手工审批) |
| ⚠ | 需要 owner 确认后 agent 才继续 |

**开工前必须已读:**
- issue #592 全文(2026-09-02 版,status: In Discussion)
- 本仓库 `CLAUDE.md` —— 注意:它描述的仍是**将被本计划替换**的旧流程(staging→main、--merge、version bump 四件套、main→staging 同步)。实施过程中凡与旧 CLAUDE.md 冲突处,以本计划 + issue #592 为准;旧文档的批量重写是 Phase 3 的显式任务。

**现状快照(2026-09-04 实测,来自仓库调查 + issue 正文):**

| 事实 | 值 |
|------|-----|
| 分支 | `main`(default)+ `staging`;无 `gitops`;origin 上 ~120 个历史 `chore/update-*-kustomize-*` 死分支(Non-Goal 不清理) |
| ArgoCD | `argocd/app-of-apps.yaml` + 2 个 child app(`nession`、`nession-staging`),全部 `targetRevision: main`,path `k8s/overlays/{production,staging}`,ns `nession`;root app 是手工 `kubectl apply` 引导,automated prune+selfHeal |
| 镜像 tag 惯例 | staging = `{server,agent,ui}-<sha7>`;production = `{server,agent}-0.35.0` / `ui-0.35.0`(SemVer 无 `v` 前缀);ghcr 无保留策略 |
| 存储 | 单 NFS PV(`192.168.2.105:/mnt/share/k8s`)+ 共享 PVC;overlay 用 `subPath: staging|production` 隔离;**缺陷:claude-home 挂载 staging 与 production 共用同一 `nession/claude-home` 目录** |
| workflow | `quality.yml`(PR→staging: rust-check/web-check)、`e2e.yml`(push/PR→staging + dispatch)、`staging.yml`(push→staging:16 job,update-staging-kustomize 写 main)、`release.yml`(push→main:16 job,version-check 门禁,update-prod-kustomize 写 main) |
| 版本 | 0.35.0;Cargo.toml 与 web/package.json 强同步(version-check 门禁) |

**当前 live tag:** staging overlay `server-6d9a76d`;production overlay `0.35.0`。HEAD `5af65a81`。

---

## 1. 目标文件结构

### 1.1 新建 `gitops` 孤儿分支(从 main 内容重组)

```
gitops/                                  ← 孤儿分支,ArgoCD 唯一消费源
├── .github/workflows/gitops-guard.yml   # guard CI(仅此分支存在,见 Task 1.6)
├── README.md                            # 分支职责、写入方、回滚指南
├── argocd/                              # 从仓库根移动;root app 仍手工引导一次
│   ├── app-of-apps.yaml                 # targetRevision: gitops(切换时手工 kubectl apply)
│   └── apps/                            # 首批 3 个静态 child app(见 Open Question 1)
│       ├── nession.yaml                 # production:沿用现 app 名,见 Task 1.5 注
│       ├── nession-preprod.yaml
│       └── nession-staging-01.yaml
├── base/nession/                        # 原 k8s/base;删除共享 pv-nfs.yaml 机制
│   ├── kustomization.yaml               # namespace/commonLabels 移除(下沉环境层)
│   ├── secret.yaml                      # 原样移动
│   ├── deployment-{server,agent,ui}.yaml
│   ├── service-{server,agent,ui}.yaml
│   └── ingress-{server,agent,ui}.yaml
└── environments/
    ├── staging-01/nession/              # 全新:ns nession-staging-01、自属 PVC、自属 claude-home
    │   ├── kustomization.yaml
    │   ├── pv-pvc.yaml                  # 新 PV → NFS 新子目录(空起步)
    │   └── patch-*.yaml                 # imagePullSecrets、ingress host、agent-env
    ├── preprod/nession/                 # 同 staging-01 形态
    └── production/nession/              # zero-copy:PV 直指现存 NFS 目录,去 subPath
        ├── kustomization.yaml
        ├── pv-pvc.yaml                  # 见 Open Question 3
        └── patch-*.yaml
```

### 1.2 `main` 上的变更集(Phase 3)

**Create:**
- `.github/workflows/release-please.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/release.yml`(v2:tag 触发)
- `.github/workflows/gitops-guard.yml`(仅存在于 gitops 分支——push 触发需 workflow 文件在目标分支上)
- `.release-please-manifest.json`、`.release-please-config.json`

**Modify:**
- `.github/workflows/quality.yml`(trigger → PR→main;加 conventional-commit job)
- `.github/workflows/e2e.yml`(trigger → PR→main)
- `scripts/deploy-watch.sh`(参数化 env/ns/期望 tag;watch gitops deploy commit + ArgoCD sync)
- `CLAUDE.md`、`.claude/skills/nession-cicd/SKILL.md`、`.claude/skills/nession-development/SKILL.md`
- `docs/superpowers/specs/2026-08-16-staging-pipeline-design.md`(标注退役)或新增 design doc

**Delete:**
- `k8s/**`、`argocd/**`(移至 gitops)
- `.github/workflows/staging.yml`(旧 release.yml 被 v2 覆盖删除)
- `scripts/bump-version.sh`(版本号归 release-please;如需保留手工回退入口则保留并降级,见 Task 3.8)

---

## 2. 排序铁律与原子性(违背任何一条都会造成中间态)

1. **P1(gitops 分支就绪)→ P2(集群切根 app)→ P3(main 变更集)**,顺序不可颠倒。理由:先让 ArgoCD 在 `main` 仍完整时实测 gitops 内容;反序会让 ArgoCD 出现 path-not-found 中间态。
2. **P3 的 main 删除必须单 commit 原子落地**:删 `k8s/` + `argocd/` + 删 `staging.yml` + 旧 `release.yml` 被 v2 覆盖,在同一 commit 内。staging.yml 的 update-staging-kustomize 若在 k8s/ 移除后被触发,会在 main 上复活 deploy-only 历史(issue Edge Case 点名);旧 release.yml 若残留,每次 main push 都会跑 16-job 空转。
3. **production zero-copy:先建新 PV/PVC,后删旧共享 PV。** 旧 PV 活到 Phase 6 旧 staging 资源清完后才删。
4. **preprod 与 production 引用同一镜像 digest**(issue Success Criteria)。
5. `gitops` 只接受 deploy commit,不接受任何非 gitops 路径变更(guard CI + 写方自校验双保险)。

---

## 3. Decision Gates(Open Questions 收敛表)

实施到标 ⚠ 的任务前,owner 必须先拍板对应行。默认值(下表中 **粗体**)为计划推荐,owner 未反对即按默认执行。

| Gate | 问题 | 阻塞 | 默认(推荐) |
|------|------|------|-------------|
| G1 | ApplicationSet 时机 | Task 1.5 | **首批静态 child app(3 文件),ApplicationSet 作为 Task 3.10 在 staging-02 之前落地**。理由:切根 app 是最高风险时刻,不叠加新抽象;Success Criteria 只要求"第二环境前"存在 |
| G2 | hostname 方案 + DNS 归属 | Task 1.4(ingress) | **`staging-01.`/`preprod.` 前缀 × {nession,agent,ui}.{nhome.local,bestnathan.top}**;DNS 手工建,记录进环境 bootstrap checklist(Task 1.8) |
| G3 | production zero-copy PV 精确布局 | Task 1.4(production) | 由 Task 0.1 实测表推导:每环境一组 PV 直指现 NFS 目录(production 数据目录 = 现 subPath 目标;claude-home:`nession/claude-home` 归 production 独有,staging-01/preprod 用各自新目录) |
| G4 | ghcr 保留策略 | 不阻塞 | 拆 follow-up issue,deadline = 第二环境启用前 |
| G5 | TLS | 不阻塞 | 拆 follow-up issue |
| G6 | **旧 staging 部署的切换归宿** | Task 2.3 预期清单 | 切根 app 后旧 child app 消失 → prune 当场删除旧 staging 资源(ns nession 内 `-staging` 后缀那套);数据留在 NFS `subPath: staging` 目录下不迁移、暂不删 |
| G7 | 切换窗口内 main 冻结 | Phase 3 前置 | 迁移 PR 合入 main 期间(预计 1-3 天)不合并任何 feat/fix PR;在途 staging PR 先合完再动 |
| G8 | quality/e2e 是否对 docs PR 也全跑 | Task 3.2 | **全跑**(owner 显式选择 full-strength 门禁);如需按路径收窄,是后续优化不是本计划范围 |

---

## Phase 0 — 基线快照(☑,约 0.5 天)

**产出:** 一份 `<worktree>/baseline-prod-render.yaml` + 一份挂载实测表,后续所有等价性判断的依据。

### Task 0.1: 录制 production 渲染基线

- [ ] 在**实施用的干净 worktree**(base `origin/main`)执行:

```bash
git worktree add /tmp/nession-base origin/main 2>/dev/null || true
cd /tmp/nession-base
kubectl kustomize k8s/overlays/production > /tmp/baseline-prod-render.yaml
kubectl kustomize k8s/overlays/staging   > /tmp/baseline-staging-render.yaml
wc -l /tmp/baseline-prod-render.yaml     # 预期:几百行,非空
```

- [ ] 读 `k8s/base/pv-nfs.yaml`、`k8s/base/*pvc*.yaml`、`k8s/base/deployment-{server,agent}.yaml`、两个 overlay 的 patch 文件,填下表(这是 G3 的输入,必须逐格实测,不得臆测):

| 项 | 值(实测填写) |
|----|----|
| 共享 PV 名 / NFS path / reclaimPolicy | |
| PVC 名 × 容量 × storageClass | |
| server 数据卷:volume 名、PVC、subPath(overlay 注入值) | |
| agent claude-home 卷:volume 名、PVC、subPath(production/staging 各自值) | |
| server/agent 的 `AGENT_AUTH_TOKEN`/`AUTH_TOKEN` secret 引用 | |
| staging 与 production overlay 的 images 三段 + 现 tag | |
| 三组 ingress host(现网) | |

- [ ] 提交基线到实施 worktree(`docs/` 提交或工作区保留均可,但 `/tmp` 两份渲染文件是后续 Task 1.7 等价性 diff 的输入,不要删)。

### Task 0.2: 冻结在途变更(G7)

- [ ] `gh pr list --state open --json number,title,baseRefName --jq '.[] | "\(.number)\t\(.baseRefName)\t\(.title)"'`
- [ ] 🔒 owner 确认:所有 base=staging 的 feat/fix PR 在 Phase 3 前合完或关闭;Phase 3 期间只合迁移 PR。
- [ ] 记录当前 staging/production 的 live tag(现状快照表),供 Phase 4 演练对照。

---

## Phase 1 — 构建 gitops 分支(☑,约 1-2 天,零集群影响)

**Worktree:** 从 origin/main 新建 `feat/gitops-branch-layout`(注意:此分支**只负责把内容组装到本地孤儿分支并推送**,main 上没有任何改动,因此该分支本身 merge 与否无所谓——若仓库要求 feat PR 才允许推分支,可改用 `chore/` 前缀直接推)。

### Task 1.1: 创建孤儿分支并搬移目录

- [ ] 在 worktree 内执行(所有命令在此 worktree 执行,`<REPO-ROOT>` = worktree 路径):

```bash
cd <REPO-ROOT>
git checkout --orphan gitops
git rm -rf .                     # 清空索引,保留工作区文件
git clean -fdqx                  # 清掉所有跟踪文件(此分支内容全新组装)
mkdir -p gitops
git mv k8s gitops/ 2>/dev/null || mv k8s gitops/    # git mv 在 orphan 上不可用,用 mv
```

- [ ] 手工重组为 §1.1 结构(移动 + 拆 base/environments),**每步 `git status` 确认无遗漏**,重组的精确动作见 Task 1.2-1.4。

### Task 1.2: `gitops/base/nession`(从原 k8s/base 派生)

- [ ] `gitops/base/nession/kustomization.yaml`:资源清单保留 secret/deployment/service/ingress;**删除** `namespace: nession`、`commonLabels`、`pv-nfs.yaml`/pvc 资源(它们拆成 per-env,下沉到 environments 层)。`secret.yaml` 原样保留。
- [ ] deployment 清单去掉 claude-home/data 卷对共享 PVC 的引用?**否**——base 保留 volume/PVC 名作为契约,per-env 层通过 `patchesStrategicMerge`/`patches` 改 `persistentVolumeClaim.claimName`。这样 base 与现有文件的 diff 最小。

### Task 1.3: `gitops/environments/<env>/nession` 骨架

- [ ] 每个环境目录一个 `kustomization.yaml` + `pv-pvc.yaml` + patch 文件。内容模板(以 staging-01 为例,preprod 同构;production 差异见 Task 1.4):

```yaml
# gitops/environments/staging-01/nession/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: nession-staging-01          # G2/G6 决定:每环境独立 ns
resources:
  - ../../../base/nession
  - pv-pvc.yaml
patchesStrategicMerge:
  - patch-imagepullsecrets.yaml        # 从原 overlay 平移(ghcr-secret)
  - patch-ingress-hosts.yaml           # staging-01.nession.{nhome.local,bestnathan.top}
  - patch-agent-env.yaml               # env: staging-01 标签等,从原 overlay 平移
commonLabels:
  env: staging-01
images:
  - name: ghcr.io/bestnathan/nession-server
    newTag: server-6d9a76d             # 首部署前用现 live tag 占位?不:空环境无镜像可用,占位 sha 即可,ArgoCD 首次同步前由第一次 deploy 覆盖
```

- [ ] `patch-imagepullsecrets.yaml`/`patch-agent-env.yaml` 从原 `k8s/overlays/staging` 对应文件平移,**逐字段 diff** 确认只改了 namespace/subPath/标签。

### Task 1.4: production zero-copy overlay(G3)

- [ ] 按 Task 0.1 实测表生成 `gitops/environments/production/nession/pv-pvc.yaml`:
  - server 数据卷 → 新 PV `nession-prod-data` → NFS path = 现 production subPath 目标目录(如 `/mnt/share/k8s/production` 或其实际值),claimName 指向新 PVC;deployment patch 掉 subPath 注入。
  - claude-home → 新 PV 直指 `nession/claude-home` 目录(production 独有,见 G6/issue Decisions)。
  - **旧共享 PV/PVC 对象不进入 gitops**(它们留在集群直到 Phase 6),新对象全部新名字,避免与现网对象同名冲突。
- [ ] `kubectl kustomize` 渲染 production,与 `/tmp/baseline-prod-render.yaml` 做等价性 diff:
  - 允许差异:namespace 相关无、PV/PVC 名、volume 的 claimName、subPath 消失、env 标签。
  - **不允许差异**:deployment 名/镜像 tag/端口/secret 引用/ingress host(production 域名不变)。
  - 渲染后对差异逐条人工确认,差异表随 commit 记录。

### Task 1.5: argocd 目录(G1)

- [ ] `gitops/argocd/app-of-apps.yaml` 照抄现 `argocd/app-of-apps.yaml`,只改:`targetRevision: gitops`。
- [ ] `gitops/argocd/apps/` 生成 3 个 child app(模板以 production 为例):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nession                     # ⚠ 沿用现 production app 名,不得改名
  namespace: argocd
  finalizers: [resources-finalizer.argoproj.io]
spec:
  project: default
  source:
    repoURL: https://github.com/BestNathan/nession.git
    targetRevision: gitops
    path: environments/production/nession
  destination:
    server: https://kubernetes.default.svc
    namespace: nession
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
```

- [ ] **改名 = 级联删除**:Application CR 带 `resources-finalizer` —— 若把 production app 从 `nession` 改名为 `nession-production`,根 app prune 会先删旧 CR,其 finalizer 随即级联删除它托管的全部生产资源,再等新 CR 重建 → 生产空窗。保持同名 `nession`,ArgoCD 只会原地 diff 新旧 source path 之间的差异(production overlay 同名的 Deployment/Service/Ingress 走滚动更新;PV/PVC 差异见 Task 2.2 注解保护)。
- [ ] staging-01/preprod 同构:path `environments/{staging-01,preprod}/nession`,destination.namespace `nession-staging-01` / `nession-preprod`。
- [ ] ⚠ G1/G6 确认后,在 commit message 里标注旧 `nession-staging` app 的去向(不入 gitops → 切根后被 prune;其 finalizer 级联清掉 legacy staging 资源 = 预期爆炸半径)。

### Task 1.6: gitops guard CI(此 workflow 文件**只存在于 gitops 分支**)

- [ ] `.github/workflows/gitops-guard.yml`(在 gitops 分支**仓库根**的 `.github/` 下——push 触发需要 workflow 文件存在于目标分支;分支结构见 §1.1):

```yaml
name: gitops-guard
on:
  push:
    branches: [gitops]
permissions: { contents: read }
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: reject non-gitops paths and non-semver production tags
        run: |
          # 首次推送(孤儿分支建分支)无 HEAD^:event.before 为全零时退回 diff-tree
          if [ "${{ github.event.before }}" != "0000000000000000000000000000000000000000" ]; then
            CHANGED=$(git diff --name-only "${{ github.event.before }}" HEAD)
          else
            CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD)
          fi
          # 1) 只允许 gitops/**、README 与本 workflow 自身;其余(如 crates/、web/)一律拒绝
          BAD=$(echo "$CHANGED" | grep -vE '^(gitops/|README\.md$|\.github/workflows/gitops-guard\.yml$)') || true
          [ -z "$BAD" ] || { echo "non-gitops path in gitops branch push: $BAD"; exit 1; }
          # 2) environments/production 里的 tag 必须是 SemVer(无 v 前缀,如 0.36.0)
          for f in $(echo "$CHANGED" | grep '^gitops/environments/production/' || true); do
            grep -E '^\s+newTag:' "$f" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+' \
              || { echo "non-semver tag in production: $f"; exit 1; }
          done
```

- [ ] ⚠ 验证一条 GitHub 行为:push 触发类 workflow 的 required-check 需要在 default branch;gitops-guard 在 gitops 分支上**能跑但不一定能被分支保护引用为 required**。部署/release workflow 写 gitops 前自校验为兜底(见 Task 3.6 的 push 步骤),guard 只作报警。实测后把结论写进 README。

### Task 1.7: 分支验证与推送

- [ ] 逐环境渲染验证:

```bash
for env in staging-01 preprod production; do
  kubectl kustomize gitops/environments/$env/nession > /tmp/gitops-$env.yaml || exit 1
done
diff <(grep -vE 'namespace: nession(-|$)' /tmp/gitops-production.yaml) /tmp/baseline-prod-render.yaml   # 见 1.4 允许差异清单,逐条过
```

- [ ] `git add gitops/ && git commit -m "chore: assemble gitops orphan branch (issue #592)"`
- [ ] 🔒 owner 复核渲染差异表后:`git push origin gitops`(首次推送孤儿分支)。
- [ ] 验证:`git ls-remote origin gitops` 有输出;`kubectl kustomize` 三环境全部通过。**此刻 ArgoCD 仍在看 main,零影响。**

### Task 1.8: gitops README + 环境 bootstrap checklist

- [ ] `gitops/README.md`:分支职责、谁可写(bot 仅 deploy/release workflow)、回滚操作(见 Phase 4 drill)、**新环境 bootstrap checklist**(G2 DNS 手工建记录;目录 + ApplicationSet 模板 + DNS = 加环境的全部步骤)。
- [ ] 推送 README 变更到 gitops。

---

## Phase 2 — 集群切换(🔒 owner,约 1 小时操作 + 观察,最高风险)

> 执行窗口:Phase 1 全部完成后、Phase 3 开始前。旧 `staging` 部署的删除发生在**本阶段第一次同步**(见 G6),owner 须预先知悉。

### Task 2.1: 切换前记录

- [ ] `kubectl -n argocd get applications -o yaml > /tmp/pre-cutover-apps.yaml`(留底,回滚用)
- [ ] `kubectl get pv,pvc -A | grep -E 'nfs|claude|server-data'` 记录现 PV/PVC 集
- [ ] `kubectl -n nession get pods -o wide` 记录 production + legacy staging 的 pod 集(切换后可对照谁被 prune)

### Task 2.2: 重指根 app

- [ ] **先保护旧共享 PV/PVC(防 prune 级联删除)**。新 gitops 清单不含旧 PV/PVC 对象 → re-point 后 ArgoCD prune 会把它们当"被删资源"尝试删除;旧 PVC 此刻仍被旧 deployment 引用,删除会造成挂载抖动甚至数据面风险。注解让 ArgoCD 忽略它们(Phase 6 才手工删):

```bash
# 名称取自 Task 0.1 实测表
kubectl annotate pv <共享PV名> argocd.argoproj.io/sync-options=Prune=false
kubectl -n nession annotate pvc <nession-server-data> <claude-tools> argocd.argoproj.io/sync-options=Prune=false
```

- [ ] `kubectl apply -f <gitops 分支最新>/argocd/app-of-apps.yaml`(source 已指向 gitops)
- [ ] 观察:`kubectl -n argocd get applications -w`——预期:`nession`(production,同名原地改源)/ `nession-preprod` / `nession-staging-01` 出现并 Sync;旧 `nession-staging` app 被根 app prune 移除。
- [ ] 若 root app 报错/滚动异常:`kubectl apply -f /tmp/pre-cutover-apps.yaml` 立即回滚(零拷贝生产数据在 NFS 上,任何时刻可重指回 main 不丢数据)。

### Task 2.3: 验证(G6)

- [ ] production 零拷贝:`kubectl -n nession rollout status deployment/nession-server` 后,exec 进 pod 确认既有数据可见:

```bash
kubectl -n nession exec deploy/nession-server -- ls <数据挂载路径>     # 路径见 0.1 实测表;预期:旧文件全在
kubectl -n nession exec deploy/nession-agent  -- ls <claude-home 路径>  # 预期:现网 .claude 内容在(生产仍指 nession/claude-home)
```

- [ ] staging-01/preprod:`kubectl get ns nession-staging-01 nession-preprod`(存在);数据目录为空起步(新 NFS 子目录)。
- [ ] 预期清理(对照 2.1 记录):app `nession`(production)原地改源 → 生产资源滚动更新,**非删除**;旧 `nession-staging` CR 被根 app prune → finalizer 级联删掉全部 legacy `-staging` 资源;旧共享 PV/PVC 因 Task 2.2 的 Prune=false 注解**仍在**(Phase 6 手工删)。
- [ ] `./scripts/deploy-watch.sh prod` 或手工 rollout 检查全绿。
- [ ] **通过标准:production pod 全部 Running 且旧数据可见。** 通过后通知实施 agent 进入 Phase 3。

---

## Phase 3 — main 切换变更集(☑ agent 执行 + 🔒 owner 审批)

> 前置:Phase 2 完成。分支一律 base origin/main;PR base `main`。顺序:PR-1(门禁重指)→ PR-2(main 删除 + workflow 换代,原子)→ PR-3(脚本/文档)。

### Task 3.1: PR-1 — quality.yml / e2e.yml 重指(单个 PR)

**Files:**
- Modify: `.github/workflows/quality.yml:3-5`(trigger `branches: [staging]` → `branches: [main]`)
- Modify: `.github/workflows/e2e.yml:3-8`(trigger 中 staging → main;`workflow_dispatch` 保留)
- Modify: `.github/workflows/quality.yml`(新增 job)

- [ ] quality.yml 新增 conventional-commit 检查 job(PR 标题 + commit subject,与 release-please 输入对齐):

```yaml
  commitlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: check PR title
        uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          types: [feat, fix, chore, docs, refactor, ci, deploy, release]
      - name: check commit subjects on branch
        run: |
          base=$(git merge-base origin/main HEAD)
          git log --format=%s $base..HEAD | while read s; do
            echo "$s" | grep -qE '^(feat|fix|chore|docs|refactor|ci|deploy|release)(\([^)]+\))?!?: ' \
              || { echo "non-conventional commit: $s"; exit 1; }
          done
```

- [ ] e2e.yml 注意:改 trigger 后,**本 PR 自己**(PR→main)就会触发 quality + e2e 全量跑(约分钟级);预期全绿(无运行时改动)。
- [ ] 验证:PR 合并到 main;确认 GitHub 侧 main 的 checks 出现 quality/e2e。
- [ ] commit:`ci: retarget quality and e2e gates to PRs against main (issue #592)`

### Task 3.2: 🔒 GitHub 设置(与 PR-1 合并时机配合)

- [ ] main 分支保护:required status checks = rust-check、web-check、e2e、commitlint(等 PR-1 落地后配置,否则 check 不存在配不上)。
- [ ] ⚠ G8 已默认全跑;若后续要按路径收窄,另行优化。

### Task 3.3: PR-2 — main 删除 + workflow 换代(原子 PR,本计划核心)

**Files:**
- Delete: `k8s/**`、`argocd/**`、`.github/workflows/staging.yml`、`.github/workflows/release.yml`(旧版)
- Create: `.release-please-config.json`、`.release-please-manifest.json`、`.github/workflows/release-please.yml`、`.github/workflows/release.yml`(v2)、`.github/workflows/deploy.yml`
- 验证:PR diff 必须同时含 k8s/ 删除与 workflow 换代,**拆开即违反 §2 铁律 2**

- [ ] **Step 1: 组装内容**(见 Task 3.4-3.7)
- [ ] **Step 2: 自检 PR diff**——只允许:删除 k8s/argocd/staging.yml/旧 release.yml;新增/替换上述 workflow 与 release-please 配置;其余一概不许
- [ ] **Step 3: 🔒 owner review**(重点:release.yml v2 的 job 门禁语义、deploy.yml 的 gitops 写权限)

### Task 3.4: release-please 配置(单版本不变量)

- [ ] `.release-please-config.json`:

```json
{
  "release-type": "cargo-workspace",
  "bump-minor-pre-major": true,
  "packages": {
    ".": {
      "release-type": "cargo-workspace",
      "extra-files": [
        { "type": "json", "path": "web/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "web/package-lock.json", "jsonpath": "$.version" },
        { "type": "json", "path": "web/package-lock.json", "jsonpath": "$.packages[''].version" }
      ]
    }
  }
}
```

- [ ] `.release-please-manifest.json`:`{ ".": "0.35.0" }`(当前版本)
- [ ] 说明:单包 + extra-files 同步 web 四件套 → 保住"全仓库单一版本号"不变量,旧 version-check 门禁随之死亡(其保证由 release-please 生成器承担)。Cargo.lock 由 cargo-workspace 插件自动更新。
- [ ] ⚠ 验证(沙箱,不碰仓库):clone 一份 main 到 /tmp,装 `npx release-please`(或 action 等效),`release-please manifest` 预览 dry-run 输出,确认版本号单值。

### Task 3.5: release-please.yml + release.yml v2(tag 触发)

- [ ] `.github/workflows/release-please.yml`:

```yaml
name: release-please
on:
  push: { branches: [main] }
permissions:
  contents: write
  pull-requests: write
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          release-type: cargo-workspace
          config-file: .release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] `.github/workflows/release.yml` v2 骨架(trigger 改 `push: tags: [v*]`;旧 release.yml 中 version-check 门禁与 update-prod-kustomize 删除;native 构建 job——build-linux-amd64/arm64、build-macos、create-release——**从旧文件原样搬入**,source = 删除前的旧 release.yml,按 commit 历史取):

```yaml
name: Release
on:
  push: { tags: ['v*'] }
concurrency: { group: release-${{ github.ref_name }}, cancel-in-progress: false }
jobs:
  version-consistency:
    runs-on: ubuntu-latest
    outputs: { ver: ${{ steps.v.outputs.ver }} }
    steps:
      - uses: actions/checkout@v4
      - id: v
        run: |
          RUST_VER=$(grep -m1 '^version' Cargo.toml | sed 's/.*"\(.*\)"/\1/')
          WEB_VER=$(node -p "require('./web/package.json').version")
          test "$RUST_VER" = "$WEB_VER" || { echo "version mismatch: $RUST_VER vs $WEB_VER"; exit 1; }
          echo "ver=$RUST_VER" >> "$GITHUB_OUTPUT"     # 轻量断言,兜底 release-please
  docker-build:        # 三段镜像,server/agent tag=ver,ui tag=ver(沿用旧 Dockerfile + arch 矩阵 + merge)
    needs: [version-consistency]
    # ... 从旧 release.yml docker 6 job + merge job 平移,产物 tag 不变(无 v 前缀,如 server-0.36.0)
  native-build:        # 从旧 release.yml 平移:build-linux-amd64/arm64、build-macos
    needs: [version-consistency]
  github-release:      # create-release job 平移;GitHub Release 由 release-please 创建,v2 只补 assets
    needs: [docker-build, native-build]
  promote-preprod:
    needs: [version-consistency, docker-build]
    environment: preprod
    concurrency: { group: gitops-writer, cancel-in-progress: false }   # 与 deploy.yml 同名组:跨 workflow 串行化 gitops 写
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/gitops-commit.sh preprod "${{ needs.version-consistency.outputs.ver }}"
  promote-production:
    needs: [version-consistency, promote-preprod, docker-build]
    environment: production     # required reviewers(见 Task 5 设置)
    concurrency: { group: gitops-writer, cancel-in-progress: false }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/gitops-commit.sh production "${{ needs.version-consistency.outputs.ver }}"   # semver tag → gitops-guard 放行
```

- [ ] 验证:v2 的 gitops 写步骤与 deploy.yml 共用同一个 retry 逻辑 → 抽成 workflow 内部 action 或脚本 `scripts/gitops-commit.sh`(见 Task 3.7),两处调用,避免双份 drift。

### Task 3.6: deploy.yml(手动部署,SC 核心)

**Files:**
- Create: `.github/workflows/deploy.yml`
- Create: `scripts/build-sha-images.sh`(sha 镜像构建,从旧 staging.yml 的 6 个 docker job + merge job 平移;prebuilt Dockerfile 已存在,无需本地 Rust 构建)

- [ ] `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'target environment (directory under gitops/environments/)'
        required: true
      sha:
        description: 'commit SHA to deploy (must exist on main)'
        required: true
concurrency: { group: gitops-writer, cancel-in-progress: false }   # 所有 gitops 写者共用(§2 铁律 + issue Edge Case)
permissions: { contents: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: validate inputs
        run: |
          git cat-file -e "${{ github.event.inputs.sha }}^{commit}" || { echo "sha not a commit: ${{ github.event.inputs.sha }}"; exit 1; }
          git ls-tree origin/gitops environments/${{ github.event.inputs.environment }}/nession/kustomization.yaml \
            || { echo "environment not on gitops: ${{ github.event.inputs.environment }}"; exit 1; }
      - name: build sha images
        run: ./scripts/build-sha-images.sh "${{ github.event.inputs.sha }}"   # {server,agent,ui}-<sha7>,脚本见下
      - name: write gitops deploy commit
        run: ./scripts/gitops-commit.sh \
              "${{ github.event.inputs.environment }}" "${{ github.event.inputs.sha }}"
```

- [ ] 说明:environment 用自由文本 + 对 gitops 目录实测校验(而非静态下拉)→ 加环境不改 workflow(G1/SC4)。
- [ ] `scripts/build-sha-images.sh` 平移源:旧 `.github/workflows/staging.yml` 的 `docker-{server,agent,ui}-amd64` 6 个 job + `merge` job(该文件在 PR-2 的删除前 commit 里可取),改动仅:入参从环境变量改 `$1`(commit sha)、去掉 16-job 门禁与 kustomize 步骤、保留 `.prebuilt` Dockerfile 构建与 `{prefix}-<sha7>` 多架构 manifest merge。

### Task 3.7: 抽共享脚本 `scripts/gitops-commit.sh` + 参数化 deploy-watch

- [ ] Create `scripts/gitops-commit.sh`(release v2 与 deploy.yml 共用;提交消息统一 `deploy(<env>): <ref>`,与 issue 建议的 commit history 格式一致——ref 手动部署时是 sha、发布时是 SemVer):

```bash
#!/usr/bin/env bash
# 用法:gitops-commit.sh <env> <ref>     # ref: 手动部署=commit sha;发布=v0.36.0 对应的 0.36.0
set -euo pipefail
env=$1; ref=$2
msg="deploy($env): $ref"
tmp=$(mktemp -d)
git clone --branch gitops --depth 1 "https://x-access-token:${GITHUB_TOKEN}@github.com/BestNathan/nession.git" "$tmp"
cd "$tmp/environments/$env/nession"
for img in server agent ui; do
  kustomize edit set image "ghcr.io/bestnathan/nession-${img}=ghcr.io/bestnathan/nession-${img}:${img}-${ref}"
done
git add -A
git -c user.name=nession-bot -c user.email=bot@nession.local commit -m "$msg"
# workflow 级 concurrency 已把 gitops 写者串行化;此处循环兜底跨 workflow 竞争:
# rebase 在远端最新 tip 之上重放本地 commit,重试 10 次
for i in $(seq 1 10); do
  git pull --rebase origin gitops && git push origin gitops && exit 0
  sleep "$((i * 3))"
done
echo "gitops push failed after retries: $msg"; exit 1
```

- [ ] Modify `scripts/deploy-watch.sh`:参数从 `staging|prod` 改为 `staging-01|preprod|prod`(或环境目录名);内部 env→namespace/标签/期望 tag 映射表按 Task 0.1 实测值;watch 对象从 chore-PR 改为 gitops deploy commit + ArgoCD sync;错误输出保留"原因 + 修复"两段式(仓库约定)。
- [ ] `scripts/bump-version.sh`:🔒 决定去留(默认退役删除;release-please 接手版本号)。若保留,注释标明仅作手工回退。

### Task 3.8: 文档与技能重写(与 PR-2 同批或紧随)

**Files(逐文件清单):**
- Modify `CLAUDE.md`:
  - 分支模型表:删 `staging` 行、`gitops` 职责新增;删 main→staging 同步 step 9、`--merge` 不变但目标全改 main
  - Merge 约定:`feat:/fix:` 等前缀扩为 conventional commits(`!` 破坏性变更、release-please 输入);`Closes #N` 回到 feature PR(默认分支 closes 生效)
  - 开发循环:PR base staging → **base main**;删 staging 验收段;版本 bump 章节 → release-please 章节
  - 新增:gitops 分支写权限、deploy workflow 用法、Environment production 审批
  - 删 `nession-cicd` skill 引用处或指向新内容
- Modify `.claude/skills/nession-cicd/SKILL.md`:整体重写为 gitops/deploy/release-please 模型(flow 图、deploy-watch 新参数、回滚流程)
- Modify `.claude/skills/nession-development/SKILL.md`:PR 目标改 main;claim/工作流不变;分支命名规则仍要求 feat//fix/
- Modify `docs/superpowers/specs/2026-08-16-staging-pipeline-design.md`:顶部标注"被 issue #592 取代,仅存档"
- Modify `docs/superpowers/plans/2026-08-16-staging-pipeline.md`:同标注
- 自检:`grep -rn 'staging → main\|base staging\|--auto.*staging\|main:refs/heads/staging' CLAUDE.md .claude/skills/ docs/` 应只剩存档标注

- [ ] commit:`docs: rewrite flow docs for gitops multi-staging model (issue #592)`(可与 PR-2 分开成 PR-3)

### Task 3.9: PR-2/PR-3 合并后验证

- [ ] `gh pr merge <PR-2> --merge`;观察 merge 本身**不再触发任何部署类 workflow**(release.yml 已在 merge 结果中消失,staging.yml 已删)。
- [ ] `gh run list --limit 10` 确认只有 quality/e2e(PR 门禁)在跑。
- [ ] 🔒 复核 §3 Gate 表全部状态,记录到 issue #592 评论区。

---

## Phase 4 — 新模型演练(owner 主导,agent 记录,逐条对应 Success Criteria)

> 每个 drill 前先跑一次"全绿"确认:main 无未合并 feat PR、gitops HEAD 与 ArgoCD 同步。

### Task 4.1: 首个 feature PR → main 直入
- [ ] 建一个真实小 feat 分支,PR base main;确认 quality(rust/web/commitlint)+ e2e 全 required 且全绿 → merge。验证:merge 后**无任何部署发生**;issue `Closes #N` 在 feature PR 上生效。

### Task 4.2: 手动部署演练
- [ ] `gh workflow run deploy.yml -f environment=staging-01 -f sha=<4.1 的 merge SHA>`
- [ ] 预期:`deploy(staging-01): <sha>` 出现在 gitops 历史;ArgoCD 同步;pod 跑 `server-<sha7>`;`./scripts/deploy-watch.sh staging-01` 绿。
- [ ] 同一 SHA 重复 deploy → 无新 commit(no-op 或显式 no-diff skip)。

### Task 4.3: 回滚演练
- [ ] `git clone gitops` → `git revert HEAD`(deploy commit)→ push → ArgoCD 同步回退 → pod 回到前一 tag。**这是运营回滚路径,必须验证可用。**

### Task 4.4: 发布演练(preprod → production 审批)
- [ ] 4.1 的 feat 合入后触发 release-please → 开 release PR(改版本号 + Cargo.lock + web 四件套)→ merge → `vX.Y.Z` tag → release.yml v2 构建。
- [ ] 预期:preprod 自动 promote;production job 停在 Environment approval;批准后 promote;`kubectl -n nession get deploy -o jsonpath='{.spec.template.spec.containers[*].image}'` 与 preprod 同 digest。
- [ ] GitHub Release assets(native 二进制 + install.sh)完整。

### Task 4.5: 同版本重试演练(issue #71 语义在新模型复现)
- [ ] 制造一次 production promote 失败(模拟)→ 重跑 release workflow → 同 tag 重建镜像、重写 gitops;验证无分支名/tag 冲突、无重复 GitHub Release。

### Task 4.6: 验收与 Success Criteria 核对
- [ ] 逐条过 issue #592 Success Criteria(共 13 条),未过的开 follow-up。

---

## Task 3.10: ApplicationSet(第二环境前落地,G1)

- [ ] `gitops/argocd/applicationset.yaml`(git directory generator,扫描 `environments/*/nession`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: { name: nession-envs, namespace: argocd }
spec:
  goTemplate: true                        # 需要 eq 条件,必须开 goTemplate
  generators:
    - git:
        repoURL: https://github.com/BestNathan/nession.git
        revision: gitops
        directories:
          - path: environments/*
  template:
    metadata:
      name: 'nession-{{ .path.basename }}'
    spec:
      project: default
      source:
        repoURL: https://github.com/BestNathan/nession.git
        targetRevision: gitops
        path: '{{ .path.path }}/nession'
      destination:
        server: https://kubernetes.default.svc
        # 命名约定:env → namespace nession-<env>,production 特例 → nession(沿用现名,Task 1.5 注)
        namespace: '{{ if eq .path.basename "production" }}nession{{ else }}nession-{{ .path.basename }}{{ end }}'
      syncPolicy:
        automated: { prune: true, selfHeal: true }
        syncOptions: [CreateNamespace=true]
```

- [ ] 加环境 = 新目录 + DNS(SC4);验证:删掉 Task 1.5 的三个静态 child app,由 ApplicationSet 接管,ArgoCD 无 diff、无重复管理告警。

---

## Phase 5 — GitHub 设置清单(🔒 owner)

| 项 | 值 | 时机 |
|----|----|------|
| main required checks | rust-check、web-check、e2e、commitlint | PR-1 落地后(Task 3.2) |
| `gitops` 分支保护 | 允许 bot/workflow 推送(GITHUB_TOKEN 受保护规则约束 → 用 bypass 名单或检查放行,issue Constraints 已点名);require gitops-guard(若 GitHub 允许非 default-branch workflow 作 required,否则只报警) | Phase 1 推送后 |
| Environment `preprod` | 无审批或自动 | Phase 3 前 |
| Environment `production` | required reviewers(owner) | Phase 3 前 |
| `staging` 分支保护 | 过渡期保留原样 | Phase 6 删分支时一并删 |
| ghcr 保留策略 | follow-up issue(G4) | 第二环境前 |

## Phase 6 — 旧机制拆除(🔒 owner,首个新管线 production 发布后)

- [ ] 删除 `staging` 分支 + 其保护规则(`gh api`/GitHub UI);确认无 workflow 再引用
- [ ] sweep 旧 namespace:legacy `-staging` 资源已在 Task 2.3 被 prune,人工复核 `kubectl get all -n nession | grep -i staging` 为空;删旧共享 PV/PVC(先确认无 claim 引用)
- [ ] NFS 旧子目录(`subPath: staging` 数据)`:确认无引用后按需删除或归档(数据决策,issue Non-Goal 只说不迁移,删不删另行定)
- [ ] origin 上 ~120 个 `chore/update-*-kustomize-*` 死分支:Non-Goal 不清理,记录在案
- [ ] 关闭 issue #592(逐条 Success Criteria 已过)并开 follow-up:GitOps secrets、ghcr retention、DNS checklist 归档、TLS 决策、staging 旧数据去留

---

## Edge Cases → 防护位置

| Edge Case(issue) | 防护 |
|-------------------|------|
| 并发 deploy 抢 gitops | `concurrency: gitops-writer` + gitops-commit.sh retry 循环(§2/3.6/3.7) |
| 回滚 | Phase 4 drill 验证的 git revert 路径(production 需 approval 或 bypass) |
| ghcr sha tag 堆积 | follow-up(G4) |
| DNS 晚于部署 | bootstrap checklist(Task 1.8) |
| 同版本重试 | release.yml v2 concurrency + release-please manifest 幂等 + 演练(Task 4.5) |
| 过渡窗口旧 trigger 复活 | §2 铁律 2:staging.yml 与 k8s/ 删除同 commit;PR-2 自检步骤 |
| gitops-guard 不可作 required check | 写方自校验(gitops-commit.sh)+ guard 报警(Task 1.6) |
| bot 推受保护分支被拒 | Phase 5 bypass 名单 |
| release-please 双版本漂移 | 单包 + extra-files(Task 3.4)+ version-consistency 断言 job |

## Success Criteria → Task 映射(自检)

| SC | Task |
|----|------|
| gitops 孤儿分支;ArgoCD 只消费 gitops;main 无 k8s//argocd/ | P1 全部、2.2、3.3 |
| staging-01/preprod/production 目录化 + 各自 ns/PVC;零拷贝无数据丢失 | 1.3、1.4、2.3 |
| 手动 deploy 任意门禁通过的 sha;gitops 历史 deploy 提交;pod 跑 sha 镜像 | 3.6、4.2 |
| 加环境只加目录(DNS 手工) | 1.8、3.10 |
| 验收绑定精确 sha;deploy commit 带 sha;无可变分支 tag | 3.6(commit 格式)、3.7 |
| quality+e2e required on main;feature 直入 main;Closes 生效 | 3.1、3.2、4.1 |
| merge main 永不部署 | 3.3(旧 workflow 换代)、3.9 |
| release-please PR;合即发布;单 build → preprod → production 同 digest | 3.4、3.5、4.4 |
| gitops CI 拒绝非 semver 写 production、拒绝应用源码路径 | 1.6、3.7 |
| 旧机制全清:update-*-kustomize、sync、k8s//argocd/、staging 分支、deploy-watch 参数化、CLAUDE.md+skills 更新 | 3.3、3.7、3.8、6 |
| 失败发布同版本可重试 | 3.5、4.5 |

## Execution Handoff

计划保存在 `docs/superpowers/plans/2026-09-04-gitops-decouple-multi-staging.md`(本文件,经 docs 通道合入 main 后作为实施索引)。实施时按 Phase 顺序推进;每个 Phase 之间以 issue #592 评论区决策记录为闸口。🔒 任务到达即停下向 owner 汇报,不代行。
