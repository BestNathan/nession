#!/usr/bin/env bash
# An inline-drawing application's shape, for #1490's regression.
#
# It prints a numbered block and then **repaints the block on every resize**,
# which is what an inline TUI does when its window changes size — and, in an
# inline application, a repaint scrolls the previous block into the pane's
# history. So a resize that moves nothing still grows the history the user
# reads, which is the reported symptom.
#
# It logs each redraw with the size it saw (`stty size`), so a test can
# attribute growth to a resize rather than to the application, and it prints
# nothing else — no prompt, no idle output — so between resizes the pane is
# byte-for-byte stable and a changed capture means a resize happened.
#
# Deterministic by construction: no account, no network, no clock in the
# output. `REPAINT_LOG` chooses where the redraw log goes (default below);
# `REPAINT_BLOCK_LINES` changes the block size.
set -u

BLOCK_LINES=${REPAINT_BLOCK_LINES:-20}
LOG=${REPAINT_LOG:-/tmp/nession-e2e-inline-repaint.log}
: > "$LOG"

paint() {
  local tag=$1 i
  for ((i = 1; i <= BLOCK_LINES; i++)); do
    printf 'REPAINT-%s-%04d\n' "$tag" "$i"
  done
}

redraws=0
trap 'redraws=$((redraws + 1)); printf "redraw %s %s\n" "$(date +%s.%N)" "$(stty size)" >> "$LOG"; paint "redraw${redraws}"' WINCH

paint initial
printf 'start %s %s\n' "$(date +%s.%N)" "$(stty size)" >> "$LOG"

while :; do
  sleep 0.2
done
