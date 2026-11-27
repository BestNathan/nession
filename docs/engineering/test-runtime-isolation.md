# Test Runtime isolation and fail-closed ownership (#4597)

> Requirement: [GitHub #4597](https://github.com/BestNathan/nession/issues/4597).
> Related owners: #4596 (tmux test-binary guard), #2520 (per-run tmux server and
> Session width), #575/#582 (socket ownership and reclamation), #1866 (E2E
> runtime and teardown Cases).

Every supported test entrypoint gets **one** run-owned root and every mutable
resource a test can reach lives inside it. A test binary that was not given one
fails closed at the production path boundary instead of touching the
developer's live state. The contract has three executable owners:

| Boundary | Owner |
|---|---|
| Rust durable/runtime path resolution | `crates/nession-common/src/test_runtime.rs` |
| Shell entrypoints (cargo test/gates/coverage) | `scripts/test-runtime.sh` |
| E2E and Acceptance harnesses | `e2e/runner/runtime/test-runtime.js` |

`scripts/tmux-run-socket.sh` remains the tmux-facing entry and delegates to the
shell owner. `docs/architecture/agent-tmux-test-isolation.md` owns the
per-run-server Session-width contract; this document owns the cross-resource
run identity.

## The run root

The shell and JS owners create a short root under `/tmp`:

```text
/tmp/nession-test-runtime.<random>/          (Rust test/gate/coverage runs)
/tmp/nession-test-runtime.<random>-<label>/  (Acceptance Case runtimes, shared
                                              Case batches, scenario replays,
                                              harness self-tests)
/tmp/nession-e2e.<random>/                   (E2E regression)
```

The reaper discovers roots by the two prefixes only. A JS caller's `label` is
evidence, never the leading name: `createRunRoot` keeps the canonical prefix
and appends the label as a suffix, so a SIGKILLed run is still discoverable and
reclaimable. A root name outside these prefixes is neither removed by the JS
owner nor reclaimed by the sweep.

Short paths are deliberate: tests derive unix sockets inside `TMPDIR`, and
macOS per-user temporary paths plus a longer root exceed
`sockaddr_un.sun_path` (104 bytes). The directory is created `0700` by
`mktemp`/`mkdtemp`, owned by the current uid, and holds:

```text
manifest.json      schema_version, run_id, owner_pid, owner_started, uid, root,
                   tmux_socket, lifecycle ("active" | "finished")
owner.pid          the PID that created the run
tmux.sock          this run's private tmux server
home/              HOME
home/.nession/     NESION_HOME (standard HOME/.nession relationship)
runtime/           NESION_RUNTIME_DIR (PID files, readiness)
tmp/               TMPDIR (tempfile/tempdir, build scratch)
config/            XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME
cache/ data/ state/ XDG_CACHE_HOME, XDG_DATA_HOME, XDG_STATE_HOME
gitconfig          GIT_CONFIG_GLOBAL (empty)
gitconfig-system   GIT_CONFIG_SYSTEM (empty)
```

The shell owner exports `NSESSION_TEST_RUNTIME_DIR` and
`NSESSION_TEST_RUNTIME_MANIFEST` alongside those roots. A nested invocation may
reuse the capability only after verifying the manifest, root, current uid and a
live `owner.pid`; an inherited bare `NESION_HOME` / `NESION_RUNTIME_DIR` /
`NESION_TMUX_SOCKET` is refused. That is the accidental-leak shape #4596 and
#4597 exist to stop.

Ownership is never a name prefix, a PID alone, or a server's self-report:
verification requires a real (non-symlink) directory owned by this uid with no
group/other bits, a non-symlink manifest inside it whose `root`/`uid`/
`lifecycle` agree, and a path that canonicalizes inside the root. The Rust
boundary re-verifies all of it; the JS owner does the same; the shell refuses
before handing a child a production path.

## Fail-closed boundaries

- **Durable/runtime paths.** For a Cargo test/benchmark binary (executable under
  `<target>/<profile>/deps/`), `paths::nession_home()` and
  `paths::runtime_dir()` refuse anything outside the verified root, and refuse
  when no capability exists at all. The error names the harness and the
  environment contract. Product binaries and `cargo run` output are not under
  `deps/`, so shipped behavior is unchanged.
- **tmux.** The #4596 guard in `crates/nession-agent/src/tmux/cmd.rs` refuses
  the shared default socket for a test binary before any socket-directory or
  config filesystem work, and diagnoses the historical `NESSON_TMUX_SOCKET`
  misspelling.
- **E2E proof obligations.** `startFullStackRuntime` requires a manifest-backed
  `runRoot`; the home, tmux socket and socket directory must canonicalize
  inside it. A missing/tampered/foreign root fails before a process starts, and
  teardown removes only verified owned paths.

## Child environment

Rust entrypoints inherit the run-owned HOME/XDG/TMPDIR/tool-config/git-config
roots and no longer receive ambient provider credentials, GitHub tokens,
ssh-agent, askpass or proxy endpoints from the shell owner. The E2E/Acceptance
harness builds children with `sanitizedEnv(runRoot, tmuxSocket, overrides)`:
only `PATH`, locale/terminal/TZ, read-only build-cache variables and the
run-owned roots survive. The Acceptance evaluator passes that environment to
standard verifiers; the `live-cli` Case lane is the explicit authenticated
exception and is declared in the Case manifest.

## Lifecycle and reclamation

Normal completion and SIGTERM/INT run the caller's teardown: stop admission,
stop child processes, kill the owned tmux server after it reports the exact
socket path, then remove the verified root. A cleanup that cannot prove the
socket/root keeps the directory and records why instead of guessing.

SIGKILL cannot run a trap. `scripts/sweep-test-sessions.sh` is the reaper:

- a live `owner.pid` means the run is in progress and is only listed;
- a current-regime root (`nession-test-runtime.*`, `nession-e2e.*`) must also
  have a valid manifest naming its own canonical root and uid;
- an unverified look-alike is reported and **not** deleted;
- a dead verified root's tmux server is asked to confirm `#{socket_path}`
  before `kill-server`, then the directory is removed.

## Detector and inventory

`./gates/run test-isolation` owns the static rules (`scripts/check-test-isolation.sh`)
and their negative fixtures (`test-isolation-selftest`). Rules cover hardcoded
ports, fixed temp names, production path resolvers, the misspelled socket
override, process-global env mutation in integration tests, fixed E2E
endpoints/roots, production metadata stores, ambient-input recursive deletion,
and harness `...process.env` spreads. The same gate runs
`scripts/test-runtime-inventory.mjs --check`; the committed
[test-runtime-inventory.json](test-runtime-inventory.json) is generated, lists
every crate/test entry and every classified resource reference, and fails the
gate when stale or when any row is unresolved.

The staleness contract is branch-authored. On a single-parent (authored)
commit, the committed catalog must equal the generator output for that tree.
A convergence integration head is a pure two-parent merge with no authored
regeneration commit, so its committed catalog can never contain the union
tree's new rows. On such a merge commit the checker instead requires the
committed catalog to be **exactly current for one parent tree** (the branch
that owns it) while the composed tree still has **zero unresolved**
references. No parent match, a tampered merge head, or a shallow checkout
whose parent trees are unavailable fails closed. This keeps the authored-commit
invariant without asking a synthetic merge to regenerate a generated file;
`ci-quality.yml`'s tooling job checks out full history so the parent proof is
possible. `scripts/test-runtime-inventory.mjs --self-test` owns the positive
and negative fixtures for this contract.

## Verification

- PR stage: `rust-format`, `rust-clippy`, `rust-test-unit`,
  `rust-test-integration`, `tmux-socket-isolation`, `test-isolation`,
  `test-isolation-selftest`.
- Merged staging SHA: Acceptance Cases `e2e/acceptance/cases/4597/SC-02`
  (owned Agent/tmux roots and unchanged live Agent identity), `SC-04`
  (concurrent E2E runs and ownership rejection), `SC-06`
  (normal/partial/panic/timeout/SIGTERM/SIGKILL teardown and reaper ownership).
  The browser `session-lifecycle` regression remains the E2E Report lane.
- Explicit boundaries: Web Vitest tests are pure unit tests and do not resolve
  host state; Cases that spawn product binaries declare their own child
  environment; native Linux/macOS capability rows run only on a runner that
  provides the capability (otherwise Pending).
