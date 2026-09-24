# Local Build Cache Across Worktrees

This file explains what the local build cache actually shares, and — the part that
matters — **when it will not give you a hit**. It exists because "sccache is enabled"
reads like "worktrees share compilation", and they do not. Decided and implemented in
[#986](https://github.com/BestNathan/nession/issues/986) / PR #988.

## The three layers

```
worktree A -> private target A ┐
worktree B -> private target B ├─ one local sccache (shared, machine-wide)
worktree C -> private target C ┘
                  +
     CoW dependency seed, once, when a worktree is created
```

| Layer | Scope | Shared with other worktrees? |
|---|---|---|
| `target/` | one per worktree | **No.** Private directory, private Cargo lock, private incremental state |
| CoW seed | main → new worktree, at creation | One-way, one-time. Worktrees never share a target and never seed back |
| sccache | machine-wide, one cache dir | The *cache* is shared; whether a given compilation can *hit* it is another matter (below) |

`target/` staying private is deliberate: a shared target couples Cargo's mutable build
state, its directory lock, and `cargo clean` across every worktree using it. The seed
gets you a warm start without that coupling by clone-sharing the *unmodified dependency
blocks* (APFS `clonefile` / Linux reflink) and then deleting every workspace-member
artifact with `cargo clean --workspace`, so no stale workspace output is carried across
a checkout boundary.

The seed is best-effort and **never falls back to a full copy**. It is skipped when the
source and destination are not on the same CoW-capable volume, when `Cargo.lock` or
`rust-toolchain.toml` differ, or when the destination already has a `target/`.

## When sccache does NOT hit

sccache keys on the compiler invocation. Anything that changes that invocation is a
different key, and a different key is a miss. In practice:

**1. A different checkout path — i.e. any other worktree.** The absolute paths of the
crate and its sources are part of the key, so `/repo/crates/x` and
`/repo/.claude/worktrees/feat-y/crates/x` are different keys.

> **Concretely: worktree B does not reuse worktree A's compilation**, even for
> byte-identical sources and the same toolchain.

Upstream sccache documents `SCCACHE_BASEDIRS` for cross-checkout normalization, but the
Rust hash-key support for it is **not complete**, and #986 deliberately does not rely on
it. Do not add `SCCACHE_BASEDIRS` expecting worktree reuse — it will also change the
cache keys for every build on the machine, since the server is shared.

**2. Incremental compilations.** Cargo's `dev` profile enables incremental by default
and sccache cannot cache incremental units. This is the single largest non-cacheable
reason in day-to-day work, and it is a deliberate trade: #986 explicitly rejects
disabling workspace-wide incremental to buy hit rate.

**3. Crate type and invocation shape.** sccache reports the reasons itself; run
`sccache --show-stats` and read the `Non-cacheable reasons:` block. The common ones are
`incremental`, `crate-type`, `multiple input files`, and `missing input`.

**4. Different build inputs.** Toolchain, `RUSTFLAGS`, features, and profile all change
the key. A miss caused by one of these is not a worktree problem — do not attribute it
to the cache.

**5. CI.** All four workflows set `RUSTC_WRAPPER: ""` at workflow scope, so the wrapper
is bypassed entirely and GitHub Actions keeps using its existing `rust-cache` path. CI
never starts sccache. This preserves the decision made in #126 (`c135bc0`).

## Commands

```bash
just build-cache-status    # current state: private target, seed source, sccache stats
just build-cache-verify    # measures behaviour, incl. cross-checkout hit/miss
just seed-worktree-target  # seed this worktree's target by hand (creation does it)
```

`build-cache-status` shows what is configured. **`build-cache-verify` shows what
happens** — it reports the toolchain, whether the wrapper is active, sccache
availability, that every worktree keeps its own target, and then runs an identical
cacheable probe at two different paths plus a same-path control, so a cross-checkout
miss is distinguishable from "the cache is broken". It is a diagnostic, not a gate
(#986 §4), and it fails only on a real structural violation — two worktrees resolving
to the same target.

Interpreting the probe: the **same-path control hitting** is what makes a
**different-path miss** meaningful. If the control misses too, the run is inconclusive
rather than evidence about worktrees.

To reset the counters for a clean baseline:

```bash
sccache --zero-stats
sccache --stop-server && sccache --start-server   # do NOT have SCCACHE_BASEDIRS
                                                  # exported when you do this
```

The server is shared machine-wide. Restarting it while a variable is exported changes
the configuration every build on the box then inherits — that is how a
`SCCACHE_BASEDIRS=/tmp` ends up silently applied to everyone.

## What this means in practice

- A fresh worktree starts with dependencies already built (CoW seed) — that is where
  most of the cold-start win comes from.
- A worktree does **not** reuse another worktree's compilation of *your* crates, and
  neither does `main` reuse a worktree's. Expect workspace crates to rebuild per
  checkout.
- Nothing here promises "a new worktree compiles from zero".
