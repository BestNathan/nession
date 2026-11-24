# Local Build Cache Across Worktrees

This file explains what the local build cache actually shares, and — the part that
matters — **when it will not give you a hit**. It exists because "sccache is enabled"
reads like "worktrees share compilation", and they do not. Decided and implemented in
[#986](https://github.com/BestNathan/nession/issues/986) / PR #988; the dedicated seed
base was added in [#4469](https://github.com/BestNathan/nession/issues/4469).

## The three layers

```
dedicated seed base (.claude/worktrees/_seed-base) --CoW clone--> new worktree target
main worktree (fallback, normally cold)            --CoW clone--> new worktree target

worktree A -> private target A ┐
worktree B -> private target B ├─ one local sccache (shared, machine-wide)
worktree C -> private target C ┘
```

| Layer | Scope | Shared with other worktrees? |
|---|---|---|
| `target/` | one per worktree | **No.** Private directory, private Cargo lock, private incremental state |
| CoW seed | dedicated seed base (main only as fallback) → new worktree, at creation | One-way, one-time. Worktrees never share a target and never seed back |
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

### Dedicated seed base (#4469)

The default seed source is the dedicated warm worktree
`<main-worktree>/.claude/worktrees/_seed-base`. It is a detached worktree on
`origin/main` (falling back to `main`/`HEAD` when there is no origin) and is maintained
with:

```bash
just seed-worktree-base            # create/update the base and warm its dev target
just seed-worktree-base-check      # read-only base state (path, target, dirty, ref)
bash scripts/seed-worktree-base.sh --no-fetch   # refresh from local refs only
bash scripts/seed-worktree-base.sh --release    # also warm the release profile
```

The warm command is `cargo build --workspace --all-targets --locked` inside the base. It
is intentionally **not** run from WorktreeCreate: a full workspace build does not belong
on the worktree-creation path. Refresh the base after `main` moves (especially when
`Cargo.lock` changes), or accept a cold start.

Source resolution (owned by `scripts/seed-worktree-target.sh`) is, first match wins:

1. `NSESSION_SEED_SOURCE` — an absolute path to an existing warm worktree. An invalid
   value is a loud `seed_status=failed`, not a silent fallback.
2. the dedicated base, when it has a `target/`;
3. the main worktree (historical fallback; normally cold because the root checkout is a
   read-only latest-main mirror).

A base whose `Cargo.lock`/`rust-toolchain.toml` no longer matches, a base with an active
Cargo build, or a missing base is an expected `seed_status=skipped` with the
`just seed-worktree-base` refresh path. Worktree creation still succeeds and never
publishes a partial target. The base is machine-local state and is never committed; the
base worktree is reserved for this purpose, not for feature work.

### Seed outcomes

The seed reports one machine-readable outcome on stdout (`seed_status=...`) and keeps
human diagnostics on stderr. Worktree creation treats all three as non-fatal:

| Outcome | Meaning | WorktreeCreate |
|---|---|---|
| `seeded` | A private CoW-backed dependency target was actually published; also prints `seed_source` and `seed_source_kind` | continue; report success |
| `skipped` | An expected safe condition (missing/stale/busy base, incompatible inputs, existing target, busy/uncertain source, unsupported filesystem) | continue; report the reason and retry path |
| `failed` | Unexpected classification, clone or cleanup failure, or an invalid explicit `NSESSION_SEED_SOURCE` | continue with an empty target; report the error and repair |

`skipped` and `failed` publish nothing and leave the existing target (if any) untouched.

### macOS APFS classification

Current macOS does not resolve an arbitrary subdirectory such as `target/` through
`diskutil info`; it returns an error plist with no `FilesystemType`. The seed therefore
resolves the backing BSD device first (`stat -f '%Sd'` → `disk3s5`) and asks `diskutil`
about that device. It requires **positive APFS classification and the same device**
before cloning. A missing `diskutil`/`plutil`/`stat`, or a failed extraction, is an
unexpected `failed` outcome, not a false "not APFS" skip; different devices and real
non-APFS volumes are expected `skipped` outcomes.

### CoW proof, not a copy

APFS support alone does not prove that `cp -c` cloned every file: `cp -c` falls back to
`copyfile(2)` when cloning is unavailable. On Darwin the seed measures the destination
volume's free space around the copy and compares the allocated growth with the source's
logical size. A fallback that consumes more than `max(64 MiB, 10% of the source)` is
discarded as `failed`; the volume allocation is the evidence that the published target
shares blocks. The real-APFS end-to-end receipt for #2735 records the same measurement
in the Issue report.

On Linux `cp -a --reflink=always` is already strict — it fails instead of copying — so
the Darwin allocation check is not used there.

### Source quiescence

Cargo holds `target/<profile>/.cargo-lock` open for the duration of a build. The seed
checks every existing lock with `fuser` before cloning; a busy lock, an unreadable
`fuser` result, or missing `fuser` tooling all skip rather than risk a mixed target.
It then creates a timestamp and, after the copy, refuses a snapshot if any source file
or directory (deletions update directory mtimes too) is newer than that timestamp. This
is a consistency rule, not a seed-only lock: ordinary Cargo builds keep respecting their
own lock.

### Existing target and safe retry

An existing `target/` is never replaced or deleted automatically.
`just seed-worktree-target` skips with the retry path. For an explicit reseed:

```bash
just seed-worktree-target-replace
```

That renames the existing target to a `.target-seed-backup.<timestamp>` sibling (a
rename, not a copy or deletion), publishes the new seed, and prints the backup path. An
interrupted attempt restores the backup. Remove the backup only after verifying the
seeded target; it exists precisely so the worktree's own build state is recoverable.

## When sccache does NOT hit

sccache keys on the compiler invocation. Anything that changes that invocation is a
different key, and a different key is a miss. In practice:

**1. A different checkout path — i.e. any other worktree.** The absolute paths of the
crate and its sources are part of the key, so `/repo/crates/x` and
`/repo/.claude/worktrees/feat-y/crates/x` are different keys.

> **Concretely: worktree B does not reuse worktree A's compilation**, even for
> byte-identical sources and the same toolchain.

Upstream sccache 0.20.0 (2026-11-23) added Rust `SCCACHE_BASEDIRS` support, so this
statement is true of the sccache 0.16 currently installed and of every earlier release,
not of every future version. This repository deliberately still relies on the dedicated
CoW seed base; adopting 0.20 needs a repo-scoped server, a per-worktree basedirs list and
real-build measurement ([#4469](https://github.com/BestNathan/nession/issues/4469)).
Do not add `SCCACHE_BASEDIRS` to the shared server expecting worktree reuse — it changes
the cache keys for every build on the machine.

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
just build-cache-status    # base path/target/compatibility, resolved source, sccache stats
just build-cache-verify    # measures behaviour, incl. cross-checkout hit/miss
just seed-worktree-base    # create/refresh the dedicated warm base
just seed-worktree-base-check      # read-only base state
just seed-worktree-target  # seed this worktree's target by hand (creation does it)
just seed-worktree-target-replace  # reseed when target/ exists; keeps a backup
```

`build-cache-status` reports the dedicated base, whether its target exists, whether its
`Cargo.lock`/`rust-toolchain.toml` match this worktree, and which source the next seed
would use. **`build-cache-verify` shows what
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

- A fresh worktree starts with dependencies already built (CoW seed from the dedicated
  base) **when the base exists and its `Cargo.lock`/`rust-toolchain.toml` match** — that
  is where most of the cold-start win comes from.
- If the base is missing, stale or busy, creation still succeeds and the worktree starts
  cold. Run `just seed-worktree-base`; reseed an existing target with
  `just seed-worktree-target-replace`.
- `main` is only a fallback: by repository policy it is a read-only latest-main mirror
  and normally has no `target/`.
- A worktree does **not** reuse another worktree's compilation of *your* crates, and
  neither does `main` reuse a worktree's. Expect workspace crates to rebuild per
  checkout. The installed sccache 0.16 makes this worse: its cross-checkout hit rate is
  zero even for identical dependency sources.
- Nothing here promises "a new worktree compiles from zero".
