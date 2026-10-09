---
name: nession-env
description: Use when setting up or repairing the Nession development environment, installing required tools/dependencies, or diagnosing missing-command/dependency failures.
---

# Nession Development Environment

This Skill owns **environment bootstrap and missing-tool repair**. Development workflow belongs to `nession-development`; CI runner setup belongs to `nession-cicd`.

## Required toolchain

Read pinned versions/config from repository owners instead of copying them here:

- Rust: `rust-toolchain.toml`
- Rust workspace/config: `Cargo.toml`, `.cargo/`
- Node/Web: `web/package.json`, lockfile
- task runner: `just`
- tmux: required for agent/session runtime tests
- Git
- Node/npm
- Rust/cargo

Some workflows additionally require Docker, `kubectl`, GitHub CLI, Playwright/browser tooling, or `cargo-llvm-cov`.

## Quick verification

```bash
rustc --version
cargo --version
node --version
npm --version
git --version
just --version
tmux -V
```

Then:

```bash
cargo check
cd web && npm install
```

Use `npm ci` in clean CI-style installs where the lockfile is authoritative.

## Rust

Use the pinned `rust-toolchain.toml`; do not hardcode a second Rust version in this Skill.

If components are missing:

```bash
rustup component add rustfmt clippy
```

Coverage workflows may require:

```bash
cargo install cargo-llvm-cov
rustup component add llvm-tools-preview
```

## Node / Web

Install a supported Node version, then from `web/`:

```bash
npm install
npm run dev
```

When lint/test tooling reports missing packages, first ensure installation matches the committed lockfile; do not edit lint/test configuration to compensate for an incomplete install.

## tmux

The agent runtime requires tmux. Installing tmux does not change Nession's socket-isolation contract; read `crates/nession-agent/AGENTS.md` for that.

## Docker / Kubernetes

Use Docker/Kubernetes tooling only for tasks that need it. Release image publication/deployment remains owned by CI/CD; load `nession-cicd` before changing deployment state.

## Playwright / browser tools

For Web visual/interaction validation load `nession-web-design`.

Project MCP/browser configuration is repository/tool specific; diagnose availability from the active client rather than assuming every agent exposes the same tool name.

## Common failure order

When a command is missing/fails before project logic runs:

1. confirm the command exists and version is compatible;
2. confirm repository dependencies are installed;
3. confirm PATH/shell environment;
4. confirm required local service/runtime (for example tmux);
5. only then debug application code.

A missing prerequisite is environment ERROR, not a reason to weaken a Gate.

## Non-goals

This Skill does not define:

- quality thresholds;
- workflow/release policy;
- protocol/design rules;
- product architecture.

Those stay with their canonical owners.
