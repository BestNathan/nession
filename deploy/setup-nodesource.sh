#!/bin/sh
# #3961: signed NodeSource Node 22 APT registration. No downloaded script executes.
# Key identity: NodeSource Debian repository public signing key; the key may
# rotate only through a reviewed fingerprint change, never silently at build.
set -eu

fail() { echo "NodeSource bootstrap rejected: $*" >&2; exit 1; }

expected="${AGENT_NODESOURCE_GPG_FINGERPRINT:-}"
case "$expected" in
  6F71F525282841EEDAF851B42F59B5F99B1BE0B4) ;;
  *) fail 'unapproved NodeSource key fingerprint' ;;
esac

arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64|arm64) ;;
  *) fail 'unsupported Debian architecture' ;;
esac

# Installing this transient verification tool is from the already-trusted
# Debian archive; no curl-to-shell or unverified fetched code is executed.
apt-get update
apt-get install -y --no-install-recommends gpg
key_file="$(mktemp)"
trap 'rm -f "$key_file"' EXIT HUP INT TERM
curl --fail --silent --show-error --location \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_file"

# Match exactly one primary public key, not a keyring with extra trusted keys.
# GPG's machine-readable fpr field is the primary identity; no quoted
# arbitrary output is accepted as a trust input to APT.
actual="$(gpg --batch --with-colons --show-keys "$key_file" |
  awk -F: '$1 == "pub" { primary = 1; next }
    $1 == "fpr" && primary { print $10; primary = 0 }')"
[ "$actual" = "$expected" ] || fail 'NodeSource signing-key fingerprint mismatch'

mkdir -p /usr/share/keyrings
gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg "$key_file"
chmod 0644 /usr/share/keyrings/nodesource.gpg
printf 'Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSuites: nodistro\nComponents: main\nArchitectures: %s\nSigned-By: /usr/share/keyrings/nodesource.gpg\n' "$arch" \
  > /etc/apt/sources.list.d/nodesource.sources
# Debian's APT validates the repository InRelease signature using only this
# scoped keyring before the explicitly version-pinned nodejs package installs.
apt-get update
