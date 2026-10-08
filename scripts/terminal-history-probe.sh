#!/usr/bin/env bash
# Terminal history reproduction probe for #1490 / #1491.
# Run on the SAME machine / tmux server as nession-agent.
# No Claude credentials and no Nession-specific application branches.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/terminal-history-probe.sh create [session] [output-dir]
  bash scripts/terminal-history-probe.sh sample <session> <output-dir> <label>
  bash scripts/terminal-history-probe.sh compare <output-dir>

Example:
  bash scripts/terminal-history-probe.sh create repro-terminal-1490 /tmp/terminal-repro
  # attach that session in Nession Web and wait for its 1000 lines
  bash scripts/terminal-history-probe.sh sample repro-terminal-1490 /tmp/terminal-repro before
  # browser reload, wait for attach; do not execute any commands
  bash scripts/terminal-history-probe.sh sample repro-terminal-1490 /tmp/terminal-repro reload-1
  # repeat for reload-2 .. reload-5
  bash scripts/terminal-history-probe.sh compare /tmp/terminal-repro

If the history hash/size increases between samples on an idle producer,
the source tmux pane has changed. If hashes stay stable but xterm line count
grows, investigate browser write/apply/duplicate paths instead.
USAGE
}

mode="${1:-}"
case "$mode" in
  create)
    name="${2:-repro-terminal-1490}"
    dir="${3:-/tmp/terminal-repro}"
    mkdir -p "$dir"
    if tmux has-session -t "=${name}" 2>/dev/null; then
      echo "ERROR: session already exists: $name" >&2
      exit 1
    fi
    tmux new-session -d -s "$name" -x 120 -y 40
    tmux set-option -t "=${name}" history-limit 5000
    # Explicitly build fixed, numbered ANSI-light history, then an idle shell.
    tmux send-keys -t "=${name}" "for i in \$(seq 1 1000); do printf 'REPRO-1490-%04d\\n' \"\$i\"; done" Enter
    # Wait for last marker; this is a prerequisite rather than an estimate.
    found=0
    for i in $(seq 1 100); do
      if tmux capture-pane -p -t "=${name}" -S -1000 | grep -q 'REPRO-1490-1000'; then
        found=1
        break
      fi
      sleep 0.1
    done
    if [[ "$found" != 1 ]]; then
      echo "ERROR: marker 1000 not observed" >&2
      exit 1
    fi
    echo "$name" > "$dir/session"
    echo "Created $name; run sample before and after each Nession refresh."
    ;;
  sample)
    [[ $# -eq 4 ]] || { usage; exit 2; }
    name="$2"; dir="$3"; label="$4"
    [[ "$label" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "Invalid label" >&2; exit 2; }
    mkdir -p "$dir"
    file="$dir/$label.capture.ansi"
    # Snapshot includes the whole saved history and the visible pane.
    tmux capture-pane -p -t "=${name}" -S - -E - -e -J > "$file"
    {
      echo "label=$label"
      echo "session=$name"
      echo "timestamp=$(date -u +%FT%TZ)"
      echo "history_size=$(tmux display-message -p -t "=${name}" '#{history_size}')"
      echo "pane_width=$(tmux display-message -p -t "=${name}" '#{pane_width}')"
      echo "pane_height=$(tmux display-message -p -t "=${name}" '#{pane_height}')"
      echo "line_count=$(wc -l < "$file" | tr -d ' ')"
      echo "byte_count=$(wc -c < "$file" | tr -d ' ')"
      echo "sha256=$(sha256sum "$file" | awk '{print $1}')"
      echo "numbered_markers=$(grep -c 'REPRO-1490-' "$file" || true)"
    } | tee "$dir/$label.meta"
    ;;
  compare)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    dir="$2"
    for f in "$dir"/*.meta; do
      [[ -f "$f" ]] || continue
      echo "----- $(basename "$f") -----"
      grep -E '^(label|history_size|pane_width|pane_height|line_count|sha256|numbered_markers)=' "$f"
    done
    echo "Source history must remain invariant when no application output or geometry change occurs."
    ;;
  *)
    usage
    exit 2
    ;;
esac
