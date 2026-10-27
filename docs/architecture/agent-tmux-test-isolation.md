# Agent tmux test isolation and Session width (#2520)

> Requirement: [GitHub #2520](https://github.com/BestNathan/nession/issues/2520).
> Related owners: #575/#582 (socket ownership and lifetime), #2487 (fixed-column
> product contract), #2469 (tmux SDK and Session runtime).

The Rust integration suite runs every real-tmux test against **one tmux server
per run** (`scripts/tmux-run-socket.sh`), not one per test. That is deliberate:
it exercises the production topology — one Agent may host many Sessions on one
server — and it is the topology in which a width defect would actually matter.
This document records what that sharing does and does not imply for a Session's
width, and the evidence #2520 gathered when a standalone 96-column Session was
observed at 80×24 in a parallel coverage run.

## The width invariant under a shared server

- `new_session` is `tmux new-session -d -s <name> -x <cols> -y <rows> -c <cwd>`
  (`crates/nession-tmux/src/ops.rs`). The flags set that Session's initial
  Window size; they are not a server-wide default.
- tmux's `window-size` option is per Session (default `latest`). An attached
  client resizes **its own Session** to the client's size; a control client
  (`-C`/`-CC`) likewise sizes only its Session.
- `default-size` (server-wide, typically 80×24) is used only when a Session is
  created without an explicit `-x`/`-y`.
- Every Session name in the suite is unique per test
  (`unique_session_name`), and every tmux target in the product and tests names
  its Session explicitly (`-t <name>`); there is no window linking.

Measured on tmux 3.6b (macOS) while building #2520's evidence:

| Schedule | Result |
|---|---|
| cold server, `new-session -x 96` | 96 |
| warm server with 16 × 80×24 Sessions | 96 |
| warm server with a real 80×24 PTY client attached elsewhere | 96 |
| warm server with an 80×24 control client attached elsewhere | 96 |
| 64 concurrent `set-environment` writers while creating | 96 |
| 16 concurrent `new-session` clients starting the server | 96 |

On **tmux 3.4** (Ubuntu 24.04, the CI runner) the client-attachment rows do
not hold: a client attached to one Session at 80×24 sized a **newly created**
Session to 80×24 and discarded `-x 96 -y 24`. The #2522 create-time probe
shows the target Session with `attached=0`, never at 96, while an 80×24 client
is attached to an anchor Session; `default-size=80x24`, `window-size` is unset
(global `latest`). That is the #2520 event.

## The #2520 event and the fix

PR #2518's Quality/coverage run `40485541897` at `4101234b`:

```
server::integration_standalone_agent_uses_its_configured_columns ... FAILED
pane=(80, 24) configured=96 session=nession-test-standalone-cols-2585134778
sessions=[16 × nession-test-flood-*=80x24, 3 × nession-test-showenv-*=80x24,
          nession-test-standalone-cols-2585134778=80x24]
```

The standalone Case (`e2e/acceptance/cases/2487/SC-09`) runs the same test in
isolation on its own socket and passes; that proves the isolated path, not
parallel-suite stability.

The fix is in the **product create path**, not test isolation: after
`new-session`, `create_session_impl` applies the requested geometry with
`resize-window` and restores tmux's dynamic `window-size latest` (the resize
command itself pins `manual`). A newly created Session therefore ends at the
agent-stated size even when another Session's client is the server's "latest",
while the active controller's authorized resize path still drives rows. The
regression witness is
`a_client_attached_elsewhere_cannot_size_a_new_session`: a real 80×24 client
held on an anchor Session while a 96-column Session is created. The
corresponding integration test runs the same schedule under the suite's flood.

### What is instrumented now

`integration_standalone_agent_uses_its_configured_columns` records, at each of
four time points — before create, immediately after the create response, at
every poll, and on failure:

- the resolved `session_id` / `window_id` / `pane_id` and window/pane sizes,
- the target Session's `window-size` option and the server's `default-size`,
- every attached client and the Session each belongs to,
- the tmux server pid and socket path.

A failure therefore distinguishes **"the Pane was never 96" (the create ran at
80)** from **"the Pane was 96 and an event moved it"**, and names the server and
clients involved. The next occurrence of this failure carries that evidence;
this document does not yet claim which of the two happened in the cited run —
that distinction is the open part of SC-01.

## Controlled concurrency proof (SC-02) and production-equivalent proof (SC-03)

Two integration tests make the relevant schedules explicit rather than relying
on suite timing:

- `configured_width_survives_shared_server_flood_and_attach` — a configured-96
  Agent creates its Sessions while another Agent on the same socket floods 48
  creates with 400 environment variables each, and a real 80×24 client stays
  attached to an anchor Session. Each measured Session must read 96.
- `shared_agent_keeps_independent_session_widths` — one Agent, one tmux server,
  an 80-column and a 96-column Session; both attach replies state their own
  width, an authorized resize applies rows only, and the other Session is
  unchanged. This is the production topology, not a test-only isolation patch.

`e2e/acceptance/cases/2520/` runs both repeatedly on a private socket.

## Coverage-gate reporting (SC-05)

`scripts/check-coverage.sh` previously reported **"cargo llvm-cov not installed
or failed to run"** whenever it produced no JSON — including when the Rust tests
failed under `cargo llvm-cov` (exit 101). It now classifies the stderr:

- a libtest failure signature is reported as **"cargo llvm-cov ran, but the Rust
  tests failed"**, with the failing test names and no install suggestion;
- a genuinely absent/broken tool keeps the install guidance.

`scripts/check-coverage-selftest.sh` injects both signatures (and the negative
case) so the classification cannot silently regress.

## Blast-radius audit (SC-04)

| Area | Status | Finding / owner |
|---|---|---|
| Run socket and teardown | verified | One socket per run (`scripts/tmux-run-socket.sh`), owner lock, canonical reclamation in `scripts/sweep-test-sessions.sh`. Orphans on a developer machine explain local PTY pressure, not CI width changes. |
| Linked Sessions / window association | verified | No `link-window`/`link-session` in the product or suite; `new-session` always creates a fresh Window. |
| tmux options and `window-size` | **found and fixed** | On tmux 3.4, `window-size latest` sizes a **new** Session to the server's latest client, overriding `-x/-y`. The create path now applies the created size explicitly and restores `latest`; only the authorized resize path changes rows. The server config still sets only `history-limit` (setting `window-size manual` at startup aborts tmux 3.6b). |
| Other real-tmux suites | audited | `control_mode`, `tmux`, `full_chain`, `sync` all address their own unique Session names; no global resize/option mutation. |
| Shared-UID multi-Agent | unproven risk | The default socket is per UID (`/tmp/nession-<uid>/tmux.sock`), so separate Agent processes under one user can share a server unless configured with distinct `NESSSION_TMUX_SOCKET` values. Production should give each Agent its own socket; #575 owns the topology rule. No width violation is demonstrated. |
| Web/App / Relay recovery | conditional | Only if a real Pane width is shown to change. #2487's SC-09 receipt stays valid; a product defect needs a new live witness, not a test-only isolation claim. |
| CI coverage reporting | fixed | See SC-05 above. |

## Limits

- The client-attachment behavior differs by tmux version: macOS tmux 3.6b did
  not reproduce it, Ubuntu 24.04's tmux 3.4 did. The regression witness runs on
  both; CI is the authority for the 3.4 behavior.
- The event is identified and fixed at the create owner. A failure that is
  **not** at create (for example an existing Session moved later) would be a
  new variant and needs a fresh witness; do not confuse it with this one.
- Do not "fix" a future variant by serializing all tests, forcing
  `window-size=manual` for every Session, deleting the standalone assertion, or
  adding retries: those remove the topology that makes the property meaningful.
