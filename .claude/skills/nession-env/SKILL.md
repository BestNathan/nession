---
name: nession-env
description: Use when setting up the Nession development environment, missing CLI tools or commands, onboarding a new developer, or build/dev failures caused by missing dependencies (rustc, cargo, node, npm, tmux, docker, kubectl, gh, rtk, or Claude plugins/skills)
---

# Nession Development Environment

## Overview

Documents every tool, language, plugin, and skill required to develop, build, and deploy Nession. When a command fails with "not found" or a skill doesn't exist, this is the single source of truth for what's needed and how to install it.

## Quick Verification

Run these to check what's missing:

```bash
rustc --version   # need ≥ 1.88
cargo --version   # bundled with Rust
node --version    # need ≥ 20
npm --version     # bundled with Node
tmux -V           # need ≥ 3.0 (agent only)
docker --version  # need ≥ 27
kubectl version --client   # need ≥ 1.30
gh --version      # need ≥ 2.50
rtk --version     # need ≥ 0.40
git --version     # need ≥ 2.40
```

## 1. Development Languages

### Rust

| Item | Version | Purpose |
|------|---------|---------|
| rustc | ≥ 1.88 | Rust compiler |
| cargo | bundled | Build system, package manager |
| rustup | latest | Rust toolchain manager (optional) |

**Install:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Restart shell, then:
rustup default stable
```

**Verify:**
```bash
rustc --version && cargo --version
```

### Node.js

| Item | Version | Purpose |
|------|---------|---------|
| node | ≥ 20 | JavaScript runtime |
| npm | bundled | Package manager (for web/) |

**Install (macOS):**
```bash
brew install node@20
```

**Install (Linux):**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Verify:**
```bash
node --version && npm --version
```

## 2. CLI Tools

### Required

| Tool | Min Version | Purpose | Install |
|------|-------------|---------|---------|
| git | 2.40 | Version control | `brew install git` / `apt install git` |
| tmux | 3.0 | Terminal multiplexer (agent host) | `brew install tmux` / `apt install tmux` |

### Build & Deploy

| Tool | Min Version | Purpose | Install |
|------|-------------|---------|---------|
| docker | 27 | Container builds | [docker.com](https://docs.docker.com/engine/install/) |
| kubectl | 1.30 | Kubernetes cluster management | `brew install kubectl` / [k8s docs](https://kubernetes.io/docs/tasks/tools/) |
| gh | 2.50 | GitHub CLI (PRs, releases) | `brew install gh` / [cli.github.com](https://cli.github.com) |
| rtk | 0.40 | Token-optimized CLI proxy (RTK) | See [RTK.md](~/.claude/RTK.md) |

### Optional

| Tool | Purpose | Install |
|------|---------|---------|
| kustomize | K8s manifest management (bundled with kubectl ≥ 1.31) | `brew install kustomize` |
| cargo-chef | Docker layer caching for Rust builds | `cargo install cargo-chef --locked` |
| just | Command runner (alternative to make) | `brew install just` / `cargo install just` |

### rtk Setup

rtk rewrites common CLI commands to save tokens. If `rtk --version` fails:

```bash
# Check if rtk binary exists
which rtk

# If missing, install via plugin or build from source
# See ~/.claude/RTK.md for full setup
```

## 3. Claude Code Plugins

Install via Claude Code's plugin system (`/plugin` command or settings).

### Required Plugins

| Plugin | Purpose |
|--------|---------|
| superpowers | Brainstorming, TDD, planning, code review, worktree, debugging |
| superpowersexy | Requirements clarification, architecture writing |

**Check installed plugins:**
```bash
ls ~/.claude/plugins/cache/
```

**Install if missing:**
In Claude Code, use `/plugin` to browse and install from the marketplace. Search for "superpowers" and "superpowersexy".

### Optional Plugins

| Plugin | Purpose |
|--------|---------|
| cc-yes | Auto-confirm safe operations |
| claude-code-warp | Faster terminal interaction |
| claude-hud | Heads-up display overlay |
| claude-plugins-official | Official plugin collection |
| bbc-plugins | Additional utility plugins |

## 4. Skills

### Project Skills (bundled in repo)

| Skill | Location | Purpose |
|-------|----------|---------|
| nession-cicd | `.claude/skills/nession-cicd/` | Version bumps, PR creation, CI/CD troubleshooting |
| nession-env | `.claude/skills/nession-env/` | This skill — environment setup |

### User Skills (installed globally)

Core workflow skills (come with superpowers plugin):
- `superpowers:brainstorming` — Design before coding
- `superpowers:writing-plans` — Implementation plans from specs
- `superpowers:subagent-driven-development` — Execute plans via subagents
- `superpowers:executing-plans` — Execute plans in parallel sessions
- `superpowers:test-driven-development` — RED-GREEN-REFACTOR
- `superpowers:systematic-debugging` — Root cause analysis
- `superpowers:requesting-code-review` — Code review workflow
- `superpowers:receiving-code-review` — Handle review feedback
- `superpowers:verification-before-completion` — Verify before claiming done
- `superpowers:finishing-a-development-branch` — Merge/PR/cleanup
- `superpowers:using-git-worktrees` — Isolated feature workspaces
- `superpowers:using-superpowers` — Skill discovery and usage

**Check available skills:**
In Claude Code, type `/` to see available slash commands. Or check:
```bash
ls ~/.claude/skills/
```

**If a skill is missing:** Install its parent plugin via `/plugin` in Claude Code.

## 5. One-Shot Environment Setup

For a new machine, run these in order:

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# restart shell

# 2. Node.js (macOS)
brew install node@20
# or Linux: see Node.js section above

# 3. System tools (macOS)
brew install tmux git docker kubectl gh

# 4. rtk (if configured — see ~/.claude/RTK.md)

# 5. Clone and install project deps
git clone <repo-url> nession
cd nession
cargo build
cd web && npm install && npm run build

# 6. Claude plugins — use /plugin in Claude Code to install:
#    - superpowers
#    - superpowersexy

# 7. Verify
rustc --version && cargo --version
node --version && npm --version
tmux -V && docker --version && kubectl version --client
gh --version && rtk --version
cargo test && cd web && npm run build
```

## Common Issues

### `cargo: command not found`
Rust not installed or not in PATH. Run `rustup` install, then restart shell.

### `npm: command not found`
Node.js not installed. See Node.js install section.

### `tmux: command not found`
tmux not installed. Only needed for running `nession-agent` locally (agent manages tmux sessions). Server and CLI don't need it.

### `docker: command not found`
Docker not installed or Docker Desktop not running. Install from [docker.com](https://docs.docker.com/engine/install/).

### `kubectl: command not found`
kubectl not installed. Only needed for k8s deploys. Install via brew or package manager.

### `gh: command not found`
GitHub CLI not installed. Needed for PR creation and release management. Install from [cli.github.com](https://cli.github.com).

### `rtk: command not found`
rtk proxy not installed. Without it, use raw commands directly (e.g., `git status` instead of `rtk git status`). See `~/.claude/RTK.md`.

### shadcn `cn` import fails
Tailwind/shadcn not initialized. Run from `web/`: `npx shadcn@latest init` then `npm install`.

### Vite dev server won't start
Check port 13000 not in use: `lsof -i :13000`. Check `web/vite.config.ts` for correct proxy target.

### `skipped: missing skill` when invoking /slash-command
Plugin not installed. Use `/plugin` in Claude Code to install the plugin that provides that skill.

## Non-Goals

- Does NOT cover IDE/editor setup (VS Code, Zed, etc.)
- Does NOT cover cloud provider CLI setup (aws, gcloud, etc.)
- Does NOT cover production infrastructure beyond k8s manifests
- Does NOT replace individual tool documentation — links provided for deep dives
