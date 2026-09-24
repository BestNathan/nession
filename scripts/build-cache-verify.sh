#!/usr/bin/env bash
# Measure and report local multi-worktree Cargo/sccache behaviour (#986 §4).
#
# This is a DIAGNOSTIC, not a gate. #986 is explicit that it must not become a
# CI gate, so it reports what it measures instead of asserting a promise. The
# one thing it fails on is a real structural violation: two worktrees sharing a
# target directory, which would couple their Cargo locks and mutable state.
#
# Why the cross-checkout probe looks the way it does — each of these was
# measured while answering #986's goal 8 against real sccache:
#   * It drives `cargo build`, not `sccache rustc`. Invoking sccache directly
#     passes several inputs and sccache reports it "non-cacheable: multiple
#     input files", so the probe measured nothing.
#   * It sets CARGO_INCREMENTAL=0. Cargo's dev profile enables incremental by
#     default and sccache cannot cache incremental units — without this the
#     probe compiles nothing cacheable and hits/misses both stay 0.
#   * It polls for the counters to move. `sccache --show-stats` lags the build,
#     so reading once straight after cargo reports a stale 0/0.
#   * It never runs `sccache --stop-server` or sets SCCACHE_BASEDIRS: the server
#     is shared machine-wide, and restarting it with a variable exported changes
#     the config every build on the box then inherits.
set -uo pipefail

# --isolation-only skips the cross-checkout probe (which compiles). Used by the
# selftest so it stays fast and hermetic, and useful on its own when you only
# want to know whether the targets are still separate.
#
# NSESSION_VERIFY_WORKTREE_LIST names a file of worktree roots, one per line, to
# check instead of asking git. That is the test seam: the isolation check is the
# only path that can fail, so the selftest has to be able to feed it a known
# violation without creating one in the real repository.
isolation_only=0
if [ "${1:-}" = "--isolation-only" ]; then
  isolation_only=1
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "build-cache-verify: not inside a Git worktree" >&2
  echo "  Fix: run this from the Nession repository" >&2
  exit 1
}
cd "$repo_root" || exit 1

work=$(mktemp -d "${TMPDIR:-/tmp}/nession-cache-verify.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM

violations=0
note() { printf '  %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; violations=$((violations + 1)); }
skip() { printf '  – %s\n' "$*"; }

echo "Local build-cache verification (#986)"
echo "workspace: $repo_root"
echo

# ---------------------------------------------------------------- toolchain
echo "toolchain"
if command -v rustc >/dev/null 2>&1; then
  note "$(rustc --version)"
else
  skip "rustc not on PATH"
fi
if [ -f "$repo_root/rust-toolchain.toml" ]; then
  note "rust-toolchain.toml: $(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$repo_root/rust-toolchain.toml")"
else
  skip "no rust-toolchain.toml"
fi
echo

# ------------------------------------------------------------------ wrapper
echo "rustc wrapper"
wrapper_cfg=$(sed -n 's/^rustc-wrapper *= *"\(.*\)"/\1/p' "$repo_root/.cargo/config.toml" 2>/dev/null)
if [ -n "$wrapper_cfg" ]; then
  resolved="$repo_root/$wrapper_cfg"
  if [ -x "$resolved" ]; then
    ok ".cargo/config.toml selects $wrapper_cfg (executable)"
  else
    bad ".cargo/config.toml selects $wrapper_cfg but it is missing or not executable"
  fi
else
  skip "no build.rustc-wrapper configured"
fi

if [ -n "${RUSTC_WRAPPER:-}" ]; then
  note "RUSTC_WRAPPER is set in this shell: $RUSTC_WRAPPER"
  note "  it OVERRIDES the repository config for builds started here"
else
  ok "no RUSTC_WRAPPER in the environment (repository config decides)"
fi

if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  note "CI is set — the wrapper deliberately execs rustc directly here, so this"
  note "  run measures the CI path, not the local one"
fi
echo

# ------------------------------------------------------------------ sccache
echo "sccache"
have_sccache=0
if command -v sccache >/dev/null 2>&1; then
  have_sccache=1
  ok "$(command -v sccache) ($(sccache --version 2>/dev/null | head -1))"
  sccache --show-stats 2>/dev/null | sed -n 's/^Cache location *\(.*\)/  location:\1/p'
  sccache --show-stats 2>/dev/null | sed -n 's/^Base directories *\(.*\)/  base directories:\1/p'
  # A non-empty BASEDIRS here is worth flagging: it is not required for Rust and
  # #986 decided not to rely on it, so its presence means someone set it by hand.
  if sccache --show-stats 2>/dev/null | grep -q '^Base directories *[^ ]'; then
    note "  (BASEDIRS is set; #986 does not depend on it for Rust — see the docs)"
  fi
else
  skip "sccache not installed — local builds fall back to plain rustc"
fi
echo

# --------------------------------------------------------- target isolation
echo "target isolation"
list_worktrees() {
  if [ -n "${NSESSION_VERIFY_WORKTREE_LIST:-}" ]; then
    cat "$NSESSION_VERIFY_WORKTREE_LIST"
  else
    git worktree list --porcelain | sed -n 's/^worktree //p'
  fi
}

# Read via process substitution rather than `mapfile`/a pipeline: the counter
# below must be incremented in THIS shell, and `mapfile` is bash 4+ while macOS
# still ships 3.2.
seen_paths=()
seen_owners=()
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  tgt="$wt/target"
  [ -e "$tgt" ] || { skip "$(basename "$wt"): no target yet"; continue; }

  if [ -L "$tgt" ]; then
    bad "$(basename "$wt"): target is a SYMLINK — its Cargo lock and mutable state are shared"
    continue
  fi

  real=$(cd "$tgt" && pwd -P)
  dup=""
  for i in "${!seen_paths[@]}"; do
    if [ "${seen_paths[$i]}" = "$real" ]; then dup="${seen_owners[$i]}"; break; fi
  done
  if [ -n "$dup" ]; then
    bad "$(basename "$wt"): target resolves to the same path as $dup ($real)"
  else
    seen_paths+=("$real")
    seen_owners+=("$(basename "$wt")")
    ok "$(basename "$wt"): private target ($(du -sh "$tgt" 2>/dev/null | cut -f1))"
  fi
done < <(list_worktrees)

if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  bad "CARGO_TARGET_DIR is set in this shell ($CARGO_TARGET_DIR) — every worktree built from it would share one target"
else
  ok "no CARGO_TARGET_DIR in the environment"
fi
echo

# ------------------------------------------------- cross-checkout behaviour
echo "cross-checkout cache behaviour"
if [ "$isolation_only" -eq 1 ]; then
  skip "skipped (--isolation-only)"
elif [ "$have_sccache" -ne 1 ]; then
  skip "no sccache — nothing to measure"
elif [ ! -x "$repo_root/scripts/rustc-wrapper.sh" ]; then
  skip "repository wrapper not executable — cannot reproduce the configured path"
elif [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  skip "CI disables the wrapper — run this locally to measure the local path"
else
  W="$repo_root/scripts/rustc-wrapper.sh"

  # Two byte-identical crates at different absolute paths, each with its own
  # cold target, plus rust-toolchain.toml so the pinned toolchain applies.
  mk() {
    mkdir -p "$1/src"
    printf '[package]\nname = "cacheprobe"\nversion = "0.1.0"\nedition = "2021"\n' > "$1/Cargo.toml"
    printf 'pub fn f() -> u32 {\n    let mut a = 0u32;\n    for i in 0..500u32 { a = a.wrapping_add(i); }\n    a\n}\n' > "$1/src/lib.rs"
    cp "$repo_root/rust-toolchain.toml" "$1/rust-toolchain.toml" 2>/dev/null || true
  }
  mk "$work/alpha"
  mk "$work/beta"

  stats() {
    sccache --show-stats 2>/dev/null | awk '
      $1=="Cache" && $2=="hits"   && NF==3 { h=$3 }
      $1=="Cache" && $2=="misses" && NF==3 { m=$3 }
      END { print h+0, m+0 }'
  }
  total() { stats | awk '{print $1+$2}'; }

  probe() { # $1 = project dir
    ( cd "$1" && env CARGO_INCREMENTAL=0 RUSTC_WRAPPER="$W" \
        CARGO_TARGET_DIR="$1/target" cargo build --lib --quiet ) >/dev/null 2>&1
  }

  # The counters lag the build; poll until they move (bounded).
  settle() { # $1 = previous total
    for _ in $(seq 1 40); do
      [ "$(total)" -gt "$1" ] && return 0
      sleep 0.25
    done
    return 1
  }

  read -r h0 m0 <<<"$(stats)"

  probe "$work/alpha"
  settle "$((h0 + m0))" || skip "counters did not move after the first build"

  read -r h1 m1 <<<"$(stats)"
  note "checkout A (cold):        hits +$((h1 - h0))  misses +$((m1 - m0))"

  probe "$work/beta"
  settle "$((h1 + m1))" || skip "counters did not move after the second build"

  read -r h2 m2 <<<"$(stats)"
  note "checkout B (same source): hits +$((h2 - h1))  misses +$((m2 - m1))"

  # Control: rebuild A at its own path. If the cache works at all this hits,
  # which is what makes a miss in B meaningful rather than "cache is broken".
  rm -rf "$work/alpha/target"
  probe "$work/alpha"
  settle "$((h2 + m2))" || skip "counters did not move after the control build"

  read -r h3 m3 <<<"$(stats)"
  note "control A (same path):    hits +$((h3 - h2))  misses +$((m3 - m2))"
  echo

  exec_a=$((m1 - m0))
  exec_b=$((h2 - h1))
  ctrl_hit=$((h3 - h2))

  if [ "$ctrl_hit" -gt 0 ]; then
    ok "the cache serves a rebuild at the SAME path — sccache is working"
  else
    skip "the same-path control did not hit; the measurement below is inconclusive"
    note "  (a concurrent build, or a cache write failure, can cause this)"
  fi

  if [ "$exec_a" -eq 0 ] && [ "$ctrl_hit" -eq 0 ]; then
    skip "not enough cacheable compilations to judge cross-checkout reuse"
  elif [ "$exec_b" -gt 0 ] || [ "$((m2 - m1))" -gt 0 ]; then
    note
    note "RESULT: a second checkout at a different path did NOT reuse the first"
    note "  checkout's compilation. That is the expected, documented behaviour:"
    note "  sccache keys include absolute paths, and Rust key normalization"
    note "  (SCCACHE_BASEDIRS) is not complete upstream — #986 deliberately does"
    note "  not rely on it. Worktrees share a cache only where keys happen to"
    note "  match, which for different checkout paths they do not."
  else
    note
    note "RESULT: the second checkout was served from cache. If this is new,"
    note "  upstream sccache may have gained Rust path normalization — see"
    note "  #986 open question 2 before relying on it."
  fi
fi
echo

# ---------------------------------------------------------------- next steps
echo "resetting the counters (only if you need a clean baseline)"
note "sccache --zero-stats          # zero the shared counters"
note "sccache --stop-server && sccache --start-server   # restart, do NOT export"
note "                              # SCCACHE_BASEDIRS while doing it"
echo

if [ "$violations" -gt 0 ]; then
  echo "build-cache-verify: $violations structural violation(s)" >&2
  echo "  Every worktree must keep its own target; see scripts/seed-worktree-target.sh" >&2
  exit 1
fi
echo "build-cache-verify: no structural violations ✓"
