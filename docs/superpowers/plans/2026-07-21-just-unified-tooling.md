# just 统一构建入口 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 引入 `just` 统一 hook 和 CI 命令入口，实现分层质量门禁。

**Architecture:** justfile 提供 Rust 和 Web 两组命令；pre-commit 只跑快速检查（fmt+clippy+eslint+tsc），pre-push 跑测试和覆盖率，CI 通过 just 调用全量检查。

**Tech Stack:** just, bash hooks, GitHub Actions

---

### Task 1: 创建 justfile

**Files:**
- Create: `justfile`

- [ ] **Step 1: 创建 justfile，包含所有 Rust 和 Web 命令**

```makefile
# ── Rust ────────────────────────────────────────────────────────────────────

# Format check (fast, safe to run on every commit)
fmt:
    cargo fmt --all -- --check

# Clippy strict mode — must pass with 0 warnings
lint:
    cargo clippy --workspace -- -D warnings

# Full test suite
test:
    cargo test --workspace

# Per-crate coverage check against thresholds
coverage:
    ./scripts/check-coverage.sh

# Fast pre-commit checks (fmt + clippy)
quick: fmt lint

# Full CI checks
check: fmt lint test coverage

# ── Web ─────────────────────────────────────────────────────────────────────

# Lint + type-check (fast, pre-commit)
web-lint:
    cd web && npx eslint . --report-unused-disable-directives --max-warnings 0
    cd web && npx tsc --noEmit

# Unit tests (pre-push)
web-test:
    cd web && npx vitest run --reporter=default

# Coverage check (pre-push, ≥ 80% threshold)
web-coverage:
    cd web && npx vitest run --coverage --reporter=default

# ── Full pre-push ───────────────────────────────────────────────────────────
pre-push: test coverage web-test web-coverage

# ── Helpers ──────────────────────────────────────────────────────────────────

# List all available commands
_default:
    @just --list
```

- [ ] **Step 2: 验证 justfile 语法**

```bash
just --fmt --check justfile 2>/dev/null || echo "justfmt not available, skipping"
just --list
```

- [ ] **Step 3: Commit**

---

### Task 2: 重写 pre-commit hook

**Files:**
- Modify: `.githooks/pre-commit`

- [ ] **Step 1: 用精简版替换 pre-commit，调用 just 命令**

保留增量检测逻辑（只检查变更文件类型），但把实际检查命令替换为 `just` 调用。移除 test/coverage。

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

STAGED_RUST=$(git diff --cached --name-only --diff-filter=ACM | grep '\.rs$' || true)
STAGED_TSX=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' | grep '^web/' || true)
STAGED_ALL=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_ALL" ]; then
  exit 0
fi

HAS_ERROR=0

# ── Rust: quick (fmt + clippy) ──
if [ -n "$STAGED_RUST" ]; then
  echo -e "${YELLOW}→ just quick${NC}"
  if just quick; then
    echo -e "${GREEN}✓ just quick${NC}"
  else
    echo -e "${RED}✗ just quick — fix errors above${NC}"
    HAS_ERROR=1
  fi
fi

# ── Web: lint (eslint + tsc) ──
if [ -n "$STAGED_TSX" ]; then
  echo -e "${YELLOW}→ just web-lint${NC}"
  if just web-lint; then
    echo -e "${GREEN}✓ just web-lint${NC}"
  else
    echo -e "${RED}✗ just web-lint${NC}"
    HAS_ERROR=1
  fi
fi

if [ $HAS_ERROR -eq 1 ]; then
  echo -e "\n${RED}Commit blocked — fix issues above${NC}"
  exit 1
fi

echo -e "\n${GREEN}All checks passed ✓${NC}"
exit 0
```

- [ ] **Step 2: 验证 hook 可执行**

```bash
chmod +x .githooks/pre-commit
```

- [ ] **Step 3: 测试 pre-commit（无变更时跳过，有 .rs 变更时跑 just quick）**

```bash
# 无变更
git commit --allow-empty -m "test: empty commit (pre-commit test)"
# 预期：跳过，exit 0

# 有 .rs 变更
touch test-hook.rs && git add test-hook.rs
git commit -m "test: pre-commit with rust file"
# 预期：跑 just quick
# 清理：git reset HEAD~1 --soft && rm test-hook.rs
```

- [ ] **Step 4: Commit**

---

### Task 3: 创建 pre-push hook

**Files:**
- Create: `.githooks/pre-push`

- [ ] **Step 1: 创建 pre-push hook**

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}→ pre-push: running full checks...${NC}"
echo ""

HAS_ERROR=0

# Rust: test + coverage
echo -e "${YELLOW}→ just test${NC}"
if just test; then
  echo -e "${GREEN}✓ just test${NC}"
else
  echo -e "${RED}✗ just test${NC}"
  HAS_ERROR=1
fi

echo ""
echo -e "${YELLOW}→ just coverage${NC}"
if just coverage; then
  echo -e "${GREEN}✓ just coverage${NC}"
else
  echo -e "${RED}✗ just coverage${NC}"
  HAS_ERROR=1
fi

# Web: test + coverage
echo ""
echo -e "${YELLOW}→ just web-test${NC}"
if just web-test; then
  echo -e "${GREEN}✓ just web-test${NC}"
else
  echo -e "${RED}✗ just web-test${NC}"
  HAS_ERROR=1
fi

echo ""
echo -e "${YELLOW}→ just web-coverage${NC}"
if just web-coverage; then
  echo -e "${GREEN}✓ just web-coverage${NC}"
else
  echo -e "${RED}✗ just web-coverage${NC}"
  HAS_ERROR=1
fi

echo ""

if [ $HAS_ERROR -eq 1 ]; then
  echo -e "${RED}Push blocked — fix issues above${NC}"
  exit 1
fi

echo -e "${GREEN}All pre-push checks passed ✓${NC}"
exit 0
```

- [ ] **Step 2: 设置可执行权限**

```bash
chmod +x .githooks/pre-push
```

- [ ] **Step 3: Commit**

---

### Task 4: 更新 CI workflows 使用 just

**Files:**
- Modify: `.github/workflows/cicd.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: 更新 cicd.yml 的 rust-check job**

把:
```yaml
- run: cargo fmt --all -- --check
- run: cargo clippy -- -D warnings
- run: cargo test
```

替换为:
```yaml
- uses: extractions/setup-just@v2
- run: just check
```

注：`just check` 包含 fmt + lint + test + coverage。`coverage` 需要 `cargo-llvm-cov`，所以 CI 需要先安装它：
```yaml
- run: cargo install cargo-llvm-cov 2>/dev/null || true
```

另外需要安装 `jq`（coverage 脚本依赖）：
```yaml
- run: sudo apt-get install -y jq
```

- [ ] **Step 2: 更新 cicd.yml 的 web-check job**

把:
```yaml
- run: cd web && npm run lint
- run: cd web && npx tsc --noEmit
- run: cd web && npm test
```

替换为:
```yaml
- uses: extractions/setup-just@v2
- run: just web-lint
- run: just web-test
```

- [ ] **Step 3: 同样更新 release.yml 的 rust-check 和 web-check job**

- [ ] **Step 4: Commit**

---

### Task 5: 端到端验证

- [ ] **Step 1: 在本地跑 just quick 确认通过**

```bash
just quick
```

- [ ] **Step 2: 在本地跑 just web-lint 确认通过**

```bash
just web-lint
```

- [ ] **Step 3: 验证 pre-commit hook 能被 git 找到**

```bash
git config core.hooksPath
# 预期：.githooks
ls -la .githooks/pre-commit .githooks/pre-push
# 预期：两个文件都可执行
```

- [ ] **Step 4: 干跑 pre-push（不实际推送）**

```bash
# 跳过 CI 更新验证，确认 justfile 和 hooks 正确即可
```
