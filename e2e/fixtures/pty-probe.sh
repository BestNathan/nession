#!/bin/sh
#
# pty-probe — a deterministic terminal-mode probe (#1096).
#
# Puts the PTY into one terminal mode, announces itself, then echoes every byte
# it receives with `cat -v` so a browser test can read control characters back
# out of xterm's buffer. That is the whole job: the requirement asks for
# something that can "intentionally toggle terminal modes and report the exact
# bytes it receives", without a real Claude Code/Codex account and without
# depending on any application being installed.
#
# It is deliberately a POSIX shell script. The e2e environment already installs
# nothing but tmux, and a fixture that needs a toolchain is a fixture that rots.
#
# usage:  pty-probe.sh <mode>
#
#   normal            no mode — the control case
#   appcursor         DECSET 1   — application cursor keys
#   bracketed-paste   DECSET 2004
#   mouse-vt200       DECSET 1000
#   mouse-sgr         DECSET 1000 + 1006
#   altscreen         DECSET 1049
#
# Prints `PTY-PROBE READY <mode>` once the mode is set. Everything typed after
# that comes back through `cat -v`: `ESC O A` reads as `^[OA`, `ESC [ A` as
# `^[[A`, and Ctrl-C as `^C` — which is how a test tells the two cursor-key
# encodings apart, and is the distinction the whole requirement turns on.
#
# `cat -v` never exits on its own; the test ends the probe with Ctrl-C, which
# is why the mode is restored on the way *in* rather than by a trap — `exec`
# replaces this shell, so there is no later point at which to restore it. The
# test resets the mode itself before the next case.

set -eu

mode="${1:-normal}"

case "$mode" in
  normal)           ;;
  appcursor)        printf '\033[?1h' ;;
  bracketed-paste)  printf '\033[?2004h' ;;
  mouse-vt200)      printf '\033[?1000h' ;;
  mouse-sgr)        printf '\033[?1000h\033[?1006h' ;;
  altscreen)        printf '\033[?1049h' ;;
  *)
    printf 'pty-probe: unknown mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac

printf 'PTY-PROBE READY %s\n' "$mode"

exec cat -v
