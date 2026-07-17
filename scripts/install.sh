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
#   -b, --bins <list>     Comma-separated binaries to install
#                         (default: nession,nession-agent,nession-server)
#   -h, --help            Show this help
#
# Environment overrides: NESSION_VERSION, NESSION_INSTALL_DIR, NESSION_BINS, GITHUB_TOKEN
set -eu

REPO="BestNathan/nession"
ALL_BINS="nession nession-agent nession-server"

VERSION="${NESSION_VERSION:-latest}"
INSTALL_DIR="${NESSION_INSTALL_DIR:-}"
BINS="${NESSION_BINS:-}"

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
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
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

# fetch <url> -> stdout
fetch() {
  if [ "$DL" = curl ]; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
    else
      curl -fsSL "$1"
    fi
  else
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      wget -qO- --header="Authorization: Bearer $GITHUB_TOKEN" "$1"
    else
      wget -qO- "$1"
    fi
  fi
}

# download <url> <dest-file>
download() {
  if [ "$DL" = curl ]; then
    curl -fsSL -o "$2" "$1"
  else
    wget -qO "$2" "$1"
  fi
}

# ── Resolve version ─────────────────────────────────────────────────────────
resolve_version() {
  if [ "$VERSION" = latest ]; then
    info "Resolving latest release…" >&2
    # Follow the 302 redirect from /releases/latest to extract the tag.
    # No GitHub API call — avoids the 60 req/hr unauthenticated rate limit.
    tag=$(curl -sI -L "https://github.com/$REPO/releases/latest" \
      | grep -i '^location:' | tail -1 \
      | sed 's|.*/releases/tag/||' | tr -d '')
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

# install dir: default /usr/local/bin, fall back to ~/.local/bin if not writable
if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ]; then
    INSTALL_DIR=/usr/local/bin
  elif [ "$(id -u)" = 0 ]; then
    INSTALL_DIR=/usr/local/bin
  else
    INSTALL_DIR="$HOME/.local/bin"
  fi
fi

ASSET="nession-${VER}-${OS}-${ARCH}.tar.gz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"

info "Platform : ${OS}-${ARCH}"
info "Version  : ${TAG}"
info "Binaries : $(echo "$SELECTED" | tr ' ' ',')"
info "Install  : ${INSTALL_DIR}"

# ── Download & extract ──────────────────────────────────────────────────────
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t nession)
trap 'rm -rf "$TMP"' EXIT INT TERM

info "Downloading ${ASSET}…"
download "$URL" "$TMP/$ASSET" || die "download failed: $URL"

info "Extracting…"
tar -xzf "$TMP/$ASSET" -C "$TMP" || die "extraction failed (corrupt archive?)"

# ── Install ─────────────────────────────────────────────────────────────────
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

for b in $SELECTED; do
  [ -f "$TMP/$b" ] || die "binary '$b' missing from archive"
  $SUDO install -m 0755 "$TMP/$b" "$INSTALL_DIR/$b" \
    || die "failed to install $b to $INSTALL_DIR"
  info "Installed ${C_DIM}${INSTALL_DIR}/${C_RST}${b}"
done

# ── PATH hint ───────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
     # shellcheck disable=SC2016  # literal $PATH is intentional (for the user to paste)
     printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR" >&2 ;;
esac

info "Done. Run ${C_DIM}nession --help${C_RST} to get started."
