#!/bin/sh
# Nession installer — downloads prebuilt binaries from GitHub Releases
# matching the current OS/architecture.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/BestNathan/nession/main/scripts/install.sh | sh
#
#   # or, after cloning:
#   ./scripts/install.sh [options]
#
# Options (also settable via environment):
#   -v, --version <ver>   Version to install (default: latest). e.g. 0.3.1 or v0.3.1
#   -d, --dir <path>      Install directory (default: /usr/local/bin, or ~/.local/bin
#                         when /usr/local/bin is not writable)
#   -b, --bins <list>     Comma-separated binaries for a fresh install
#                         (default: nession,nession-agent,nession-server)
#   -h, --help            Show this help
#
# Environment overrides: NESSION_VERSION, NESSION_INSTALL_DIR, NESSION_BINS,
#   NESSION_RELEASE_BASE_URL (mirror/test base; requires an explicit version and,
#   for an existing installation, NESSION_UPDATE_API_URL),
#   GITHUB_TOKEN
#
# First safe upgrade: only a CLI advertising the upgrade contract
# (nession-upgrade-v1) runs its own transaction; any older CLI — even one that
# supports `install` — is upgraded by the verified TARGET binary, so the
# superseded move-based path never runs. State is retained; archives get copies.
set -eu

REPO="BestNathan/nession"
ALL_BINS="nession nession-agent nession-server"

VERSION="${NESSION_VERSION:-latest}"
INSTALL_DIR="${NESSION_INSTALL_DIR:-}"
BINS="${NESSION_BINS:-}"
RELEASE_BASE_URL="${NESSION_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}"

# ── Output helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$(printf '\033[31m'); C_GRN=$(printf '\033[32m')
  C_YLW=$(printf '\033[33m'); C_DIM=$(printf '\033[2m'); C_RST=$(printf '\033[0m')
else
  C_RED=''; C_GRN=''; C_YLW=''; C_DIM=''; C_RST=''
fi
info()  { printf '%s==>%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn()  { printf '%swarning:%s %s\n' "$C_YLW" "$C_RST" "$*" >&2; }
die()   { printf '%serror:%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# ── Parse args ──────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    -v|--version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    -d|--dir)     INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    -b|--bins)    BINS="${2:?--bins needs a value}"; shift 2 ;;
    -h|--help)    usage 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done

# The script owns the selector from here on. A delegated/migrating CLI must not
# re-apply it: `install`/`update` refuse a non-Current selector, and the
# capability probe below would otherwise fail for any NESSION_VERSION.
unset NESSION_VERSION NESSION_VERSION_DISPATCHED

# ── Detect platform ─────────────────────────────────────────────────────────
detect_os() {
  os=$(uname -s)
  case "$os" in
    Linux)  echo linux ;;
    Darwin) echo darwin ;;
    *)      die "unsupported OS: $os (only Linux and macOS have prebuilt binaries)" ;;
  esac
}

detect_arch() {
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64)  echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *)             die "unsupported architecture: $arch (only amd64 and arm64 are built)" ;;
  esac
}

# ── HTTP helpers (curl or wget) ─────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

if have curl; then
  DL="curl"
elif have wget; then
  DL="wget"
else
  die "need curl or wget installed"
fi

# Bounded bootstrap transport (#4592 §8.5): every request has a connect bound,
# a whole-request budget and bounded retries; a stalled asset transfer aborts
# after 60s below 1 KiB/s instead of hanging forever. Metadata is small (30s
# budget); the asset may legitimately take minutes (30min budget, idle-bound).
# fetch <url> -> stdout
fetch() {
  if [ "$DL" = curl ]; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      curl -fsSL --connect-timeout 10 --max-time 30 \
        --retry 3 --retry-delay 2 --retry-max-time 120 \
        -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
    else
      curl -fsSL --connect-timeout 10 --max-time 30 \
        --retry 3 --retry-delay 2 --retry-max-time 120 "$1"
    fi
  else
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      wget -qO- --timeout=30 --tries=4 --waitretry=2 \
        --header="Authorization: Bearer $GITHUB_TOKEN" "$1"
    else
      wget -qO- --timeout=30 --tries=4 --waitretry=2 "$1"
    fi
  fi
}

# download <url> <dest-file>
download() {
  if [ "$DL" = curl ]; then
    curl -fsSL --connect-timeout 10 --max-time 1800 \
      --speed-limit 1024 --speed-time 60 \
      --retry 3 --retry-delay 2 --retry-max-time 1900 \
      -C - -o "$2" "$1"
  else
    wget -qO "$2" --timeout=60 --read-timeout=60 --tries=4 --waitretry=2 -c "$1"
  fi
}

# sha256_of <file> -> hex
sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "need sha256sum, shasum, or openssl to verify the downloaded release"
  fi
}

# ── Resolve version ─────────────────────────────────────────────────────────
resolve_version() {
  if [ "$VERSION" = latest ]; then
    if [ -n "${NESSION_RELEASE_BASE_URL:-}" ]; then
      die "NESSION_RELEASE_BASE_URL requires an explicit --version (latest cannot be resolved from a mirror)"
    fi
    info "Resolving latest release…" >&2
    # Follow the 302 redirect from /releases/latest to extract the tag.
    # No GitHub API call — avoids the 60 req/hr unauthenticated rate limit.
    tag=$(curl -sI -L --connect-timeout 10 --max-time 30 \
      --retry 3 --retry-delay 2 --retry-max-time 120 \
      "https://github.com/$REPO/releases/latest" \
      | grep -i '^location:' | tail -1 \
      | sed 's|.*/releases/tag/||' | tr -d '\r')
    if [ -z "$tag" ]; then
      die "could not determine latest release tag"
    fi
    echo "$tag"
  else
    # normalize to a v-prefixed tag
    case "$VERSION" in
      v*) echo "$VERSION" ;;
      *)  echo "v$VERSION" ;;
    esac
  fi
}

# ── Resolve the install directory and existing CLI ──────────────────────────
# default /usr/local/bin, fall back to ~/.local/bin if not writable
if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ]; then
    INSTALL_DIR=/usr/local/bin
  elif [ "$(id -u)" = 0 ]; then
    INSTALL_DIR=/usr/local/bin
  else
    INSTALL_DIR="$HOME/.local/bin"
  fi
fi

EXISTING_CLI=""
if [ -f "$INSTALL_DIR/nession" ] && [ -x "$INSTALL_DIR/nession" ]; then
  EXISTING_CLI="$INSTALL_DIR/nession"
elif command -v nession >/dev/null 2>&1; then
  # A CLI elsewhere on PATH is a different installation unless its directory
  # is exactly the destination. Delegating it here would migrate that other
  # installation into --dir.
  PATH_CLI="$(command -v nession)"
  if [ "$(dirname "$PATH_CLI")" = "$INSTALL_DIR" ]; then
    EXISTING_CLI="$PATH_CLI"
  fi
fi

# A mirror base only changes where the script downloads. The CLI's install
# transaction discovers and verifies the release through its own API base, so an
# upgrade of an existing installation needs that base too.
if [ -n "$EXISTING_CLI" ] && [ -n "${NESSION_RELEASE_BASE_URL:-}" ] \
   && [ -z "${NESSION_UPDATE_API_URL:-}" ]; then
  die "NESSION_RELEASE_BASE_URL requires NESSION_UPDATE_API_URL when upgrading an existing installation (the CLI verifies releases through its API base)"
fi

# ── Delegate versioned installs to an existing CLI ──────────────────────────
# Only a CLI that advertises the versioned upgrade contract may run its own
# transaction (#4592 §6). `install --help` is NOT proof: an old CLI can support
# `install` and still execute the superseded move-based transaction that strips
# Current of its configuration and identity. Any CLI without the token — including
# one that supports `install` — falls through to MIGRATE, where the verified
# TARGET binary performs the upgrade with the actual installed directory/version.
MIGRATE=0
if [ -n "$EXISTING_CLI" ]; then
  if [ -n "$BINS" ]; then
    die "--bins is only supported for a fresh installation; the versioned transaction always publishes all three binaries. Use \`nession install <version>\` to update an existing installation."
  fi
  UPGRADE_CONTRACT="$("$EXISTING_CLI" --upgrade-contract 2>/dev/null || true)"
  case "$UPGRADE_CONTRACT" in
    nession-upgrade-v1\ *)
      export NESSION_INSTALL_DIR="$INSTALL_DIR"
      if [ "$VERSION" = latest ]; then
        info "Delegating to the installed nession CLI (update)…"
        exec "$EXISTING_CLI" update --yes
      else
        info "Delegating to the installed nession CLI (install ${VERSION})…"
        exec "$EXISTING_CLI" install "$VERSION"
      fi
      ;;
  esac
  # The installed CLI does not advertise the upgrade contract: the extracted,
  # hash-verified TARGET CLI performs the first safe upgrade through the same
  # retention transaction. The old CLI's own install/update code never runs.
  MIGRATE=1
fi

# ── Main ────────────────────────────────────────────────────────────────────
OS=$(detect_os)
ARCH=$(detect_arch)

# binaries to install (validate before any network call)
if [ -n "$BINS" ]; then
  SELECTED=$(echo "$BINS" | tr ',' ' ')
  for b in $SELECTED; do
    case " $ALL_BINS " in
      *" $b "*) ;;
      *) die "unknown binary: $b (choices: $(echo "$ALL_BINS" | tr ' ' ','))" ;;
    esac
  done
else
  SELECTED="$ALL_BINS"
fi

TAG=$(resolve_version)
VER=${TAG#v}   # strip leading v for the asset filename

ASSET="nession-${VER}-${OS}-${ARCH}.tar.gz"
URL="${RELEASE_BASE_URL}/${TAG}/${ASSET}"
CHECKSUMS_URL="${RELEASE_BASE_URL}/${TAG}/checksums.txt"

info "Platform : ${OS}-${ARCH}"
info "Version  : ${TAG}"
info "Binaries : $(echo "$SELECTED" | tr ' ' ',')"
info "Install  : ${INSTALL_DIR}"

# ── Read-only live-process preflight (before the large transfer) ────────────
# A first safe upgrade refuses a live Agent/Server. Probe through the existing
# CLI's read-only status — never its mutating install/update — so a proven live
# writer is refused before spending the asset download (#4660 Fix Direction 5).
# An inconclusive probe (an older CLI without a recognizable status) defers to
# the target transaction's authoritative recheck under the lifecycle lock; this
# preflight never stops or restarts a service.
if [ "$MIGRATE" = 1 ]; then
  for component in agent server; do
    probe="$("$EXISTING_CLI" "$component" status 2>/dev/null || true)"
    if printf '%s\n' "$probe" | grep -Eq 'Status:[[:space:]]*running|is running \(PID'; then
      die "a live ${component} was detected before download; stop it first (nession ${component} stop), then re-run. Nession never stops a service implicitly."
    fi
  done
fi

# ── Download, verify and extract ────────────────────────────────────────────
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t nession)
STAGE=""
cleanup() {
  rm -rf "$TMP"
  if [ -n "$STAGE" ]; then
    ${SUDO:-} rm -rf "$STAGE"
  fi
}
trap cleanup EXIT INT TERM

info "Downloading ${ASSET}…"
download "$URL" "$TMP/$ASSET" || die "download failed: $URL"

info "Verifying checksum…"
download "$CHECKSUMS_URL" "$TMP/checksums.txt" \
  || die "could not download checksums.txt; refusing to install an unverified release"
EXPECTED=$(awk -v asset="$ASSET" '$2 == asset { print $1; exit }' "$TMP/checksums.txt")
[ -n "$EXPECTED" ] || die "checksums.txt does not list ${ASSET}; refusing to install an unverified release"
ACTUAL=$(sha256_of "$TMP/$ASSET")
[ "$ACTUAL" = "$EXPECTED" ] \
  || die "checksum mismatch for ${ASSET}: expected ${EXPECTED}, got ${ACTUAL}"

info "Extracting…"
tar -xzf "$TMP/$ASSET" -C "$TMP" || die "extraction failed (corrupt archive?)"
for b in $SELECTED; do
  [ -f "$TMP/$b" ] || die "binary '$b' missing from archive"
done
if [ "$MIGRATE" = 1 ]; then
  # The migration transaction publishes all three binaries; verify the archive
  # is complete before handing it the upgrade.
  for b in $ALL_BINS; do
    [ -f "$TMP/$b" ] || die "the release archive is missing '$b'; refusing a first safe upgrade"
  done
fi

# ── First safe upgrade through the verified TARGET transaction ──────────────
if [ "$MIGRATE" = 1 ]; then
  # The downloaded target must itself advertise the upgrade contract; an older
  # target cannot prove retention compatibility and is refused fail-closed.
  TARGET_CONTRACT="$("$TMP/nession" --upgrade-contract 2>/dev/null || true)"
  case "$TARGET_CONTRACT" in
    nession-upgrade-v1\ *) ;;
    *) die "the downloaded release ${VER} does not advertise the upgrade contract; refusing to upgrade with a release that cannot prove retention compatibility" ;;
  esac

  OLD_VERSION="$("$EXISTING_CLI" --version 2>/dev/null | awk '{print $NF}')" || OLD_VERSION=""
  # The transaction names the archive with the normalized SemVer; tolerate an
  # older CLI that prints a `v` prefix.
  OLD_VERSION="${OLD_VERSION#v}"

  info "Upgrading the installation at ${INSTALL_DIR} (release ${OLD_VERSION:-unknown}) through the verified target transaction…"
  # The shell is bootstrap only (#4660 Fix Direction 1). It hands the verified
  # staged artifact to the canonical target installer — downloaded once, never
  # re-downloaded — and consumes the target's authoritative versioned result.
  # It never infers completeness from directory existence and never asserts a
  # rollback merely because the subprocess exited nonzero. The target CLI owns
  # the transaction outcome (committed/unchanged/rolled-back/recovery-blocked),
  # refuses a live writer under the lifecycle lock, and never stops a daemon.
  INSTALL_OUTPUT="$(NESSION_INSTALL_DIR="$INSTALL_DIR" "$TMP/nession" install "$VER" --yes \
    --local-artifact "$TMP/$ASSET" --artifact-sha256 "$EXPECTED" 2>&1)" \
    && INSTALL_STATUS=0 || INSTALL_STATUS=$?
  printf '%s\n' "$INSTALL_OUTPUT"

  RESULT_LINE="$(printf '%s\n' "$INSTALL_OUTPUT" | grep '^nession-install-result-v1 ' | tail -1 || true)"
  if [ -n "$RESULT_LINE" ]; then
    OUTCOME="$(printf '%s\n' "$RESULT_LINE" | sed -n 's/.* outcome=\([a-z-]*\).*/\1/p')"
    RESULT="$(printf '%s\n' "$RESULT_LINE" | sed -n 's/.* result=\([a-z]*\).*/\1/p')"
    COVERAGE="$(printf '%s\n' "$RESULT_LINE" | sed -n 's/.* coverage=\([a-z]*\).*/\1/p')"
    if [ "$RESULT" = ok ]; then
      info "Upgrade ${OUTCOME}: Current is release ${VER}."
      if [ "$COVERAGE" = gaps ] && [ -n "$OLD_VERSION" ]; then
        warn "the archive has non-fatal coverage gaps; inspect with \`nession version inspect ${OLD_VERSION}\`. Current is committed and intact."
      fi
      info "Done. Run ${C_DIM}nession --help${C_RST} to get started."
      exit 0
    fi
    # A failed result reports the proven Current state truthfully; the shell
    # does not retry destructively or claim a rollback the target did not prove.
    die "the upgrade did not commit (Current: ${OUTCOME:-unknown}); see the transaction output above. Inspect with \`nession version list\` before retrying."
  fi

  # An older upgrade-v1 target predates the result line. Report its exit status
  # truthfully without inferring archive completeness from directories or
  # asserting a rollback from a nonzero exit (#4660). The target's own output
  # above is authoritative; the manifest owns coverage.
  if [ "$INSTALL_STATUS" = 0 ]; then
    info "The verified target release ${VER} reported success."
    info "Done. Run ${C_DIM}nession --help${C_RST} to get started."
    exit 0
  fi
  die "the target install exited ${INSTALL_STATUS}; its output above is authoritative. Current's state was not inferred — inspect with \`nession version list\` before retrying."
fi

# ── Fresh bootstrap ─────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" 2>/dev/null || true

# choose an escalation prefix if the dir isn't writable
SUDO=""
if [ ! -w "$INSTALL_DIR" ]; then
  if [ "$(id -u)" != 0 ] && have sudo; then
    warn "$INSTALL_DIR is not writable — using sudo"
    SUDO="sudo"
  else
    die "$INSTALL_DIR is not writable (re-run with sudo, or set --dir to a writable path)"
  fi
fi

# All selected binaries are verified above before anything is published. Stage
# them beside their destination and rename each into place, so an interrupted
# copy cannot leave a half-written binary at its final name.
STAGE="$INSTALL_DIR/.nession-install.$$"
$SUDO mkdir "$STAGE" || die "failed to create the staging directory ${STAGE}"
for b in $SELECTED; do
  $SUDO install -m 0755 "$TMP/$b" "$STAGE/$b" \
    || die "failed to stage $b in $INSTALL_DIR"
done
for b in $SELECTED; do
  $SUDO mv -f "$STAGE/$b" "$INSTALL_DIR/$b" \
    || die "failed to install $b to $INSTALL_DIR"
  info "Installed ${C_DIM}${INSTALL_DIR}/${C_RST}${b}"
done
$SUDO rmdir "$STAGE" 2>/dev/null || true
STAGE=""

# ── PATH hint ───────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
     # shellcheck disable=SC2016  # literal $PATH is intentional (for the user to paste)
     printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR" >&2 ;;
esac

info "Done. Run ${C_DIM}nession --help${C_RST} to get started."
