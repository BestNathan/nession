# E2E, Scenarios and Issue/SC Acceptance

Nession verifies real runtime behavior with a **shared full-stack Runtime
Harness**. It provisions the Server, Agent, isolated tmux and Web stack.
Playwright is one consumer of that runtime for browser regressions; it is
not the owner of Server/Agent lifecycle.

## Repository layout

```text
e2e/
├── run                          # canonical CLI (list, validate, runners)
├── runner/
│   ├── runtime/full-stack.js    # full-stack provision / cleanup
│   ├── drivers/                 # browser and verifier adapters
│   └── collectors/              # opt-in, bounded observations
├── acceptance/cases/<issue>/<SC>/ # Case manifests and source verifiers
├── scenarios/                   # scenario.yaml + reproduction scripts
├── tests/browser/               # Playwright regression / visual specs
├── tests/browser/__snapshots__/ # committed Linux fixture baselines
├── fixtures/                    # server/agent and terminal fixtures
├── helpers/                     # browser assertions and fixture helpers
├── runtime.ts                   # regression-only paths, ports and socket
├── globalSetup.ts               # calls the shared Runtime Harness
└── playwright.config.ts
```

Inspect the canonical catalog and validate manifests without running the stack:

```bash
./e2e/run --list
./e2e/run --validate
```

The `Acceptance Cases` workflow discovers Issue contracts and selects Cases
by stage, then invokes `e2e/run acceptance` against an exact checkout SHA.
A Case that **transitively** drives Playwright must declare a real
`type: browser` verifier in its manifest; do not invent schema flags or
install browser dependencies for protocol-only Cases. Source verifiers are
internal execution steps, not independent privileged workflow entrypoints.
Results require **trusted ingestion** before they can update an Issue's SC;
immutable evidence is stored on `acceptance-results`, not on the source branch.

## Execution policy

**Do not run the full E2E suite on a development machine.** It starts real
Rust processes and tmux servers, with possible orphan cleanup risks.
Do not run `npx playwright test`, `npm test`, headed tests, local snapshot
regeneration or `CI=true` to bypass the rule. Some specs have CI-specific
skip guards, but not every test does; the policy applies to the entire suite.

Local, non-executing discovery is allowed:

```bash
cd e2e
npm ci
npx playwright test --list
```

For interaction work use a controlled dev UI and browser tooling, then submit
a focused Regression, Scenario or Acceptance Case for CI verification.

The [E2E Tests workflow](../.github/workflows/e2e.yml) runs on pushes to
`staging`, PRs targeting **`staging` or `main`**, and manual dispatch.
It installs tmux and Chromium, uses Node.js **24**, builds Server, Agent and
Web, invokes the canonical browser design gate, then uses
`./gates/run e2e-playwright` to run the canonical E2E CLI and Playwright.
Manual snapshot regeneration invokes `./e2e/run test --suite fixture-visual
--update-snapshots=all` outside that Gate.
The job timeout is **20 minutes**; CI retries tests twice, as configured in
`e2e/playwright.config.ts`. The workflow checks out and passes the exact
target SHA to the Runtime Harness.

## Shared runtime and isolation

`e2e/globalSetup.ts` delegates to
`e2e/runner/runtime/full-stack.js` and returns its cleanup callback.
The regression profile in `e2e/runtime.ts` uses loopback ports
19090 (Server), 19091 (Agent), 19092 (stalled-probe fixture), 4173
(Web preview), and `NESSION_HOME=/tmp/nession-e2e`.
Other Case profiles can allocate their own home, ports and socket;
fixtures are rendered as runtime-specific config.

Each run carries its own `NESSION_TMUX_SOCKET` and executes tmux with
`-S <socket>`, never the user's default server. The regression socket is
`/tmp/nession-e2e-tmux-<hex>/tmux.sock`. **Do not use `TMUX_TMPDIR` as a
substitute**: tmux can ignore it inside an existing tmux session (#574).
`scripts/check-tmux-socket.sh` guards the invariant.

Hard-killed runs can leave isolated sockets or tmux servers. Inspect and
reclaim only verified, owned test directories:

```bash
./scripts/sweep-test-sessions.sh
./scripts/sweep-test-sessions.sh --kill
```

## Regression and visual checks

Regression specs under `e2e/tests/browser/` cover login, Session lifecycle,
terminal I/O/attach/replay and UI/capability contracts. The current
shell-ready helper is **`e2e/helpers/shell.ts` → `waitForShell`**;
the old `sessionFirst.ts` / `waitForSessionFirst` helper was removed.
Some browser regression flows use a direct `server_url` query parameter
(`ws://localhost:19090/ws`) rather than Vite's preview proxy.
Terminal output assertions inspect the xterm buffer through the mounted
`xtermInstance`, since Canvas/WebGL glyphs are not DOM text.

On failure use CI logs and published artifacts. Where `playwright-report`
is available:

```bash
gh run download <run-id> --name playwright-report
npx playwright show-report playwright-report
```

Canonical visual snapshots are defined by
`e2e/tests/browser/fixture-visual.spec.ts` and committed PNGs in
`e2e/tests/browser/__snapshots__/fixture-visual.spec.ts/`.
Their names include `-linux`; rely on the spec and files for the complete
current set rather than a duplicated filename table. The fixture clock is
frozen by `e2e/helpers/fixtureVisual.ts`.

For intentional visual changes, **manually dispatch** the E2E workflow with
`update_visual_snapshots` enabled, download/review its snapshot artifact
and commit approved differences. The workflow uses
`--update-snapshots=all`; an unqualified update may silently leave
small-but-real drift below the comparison tolerance.

## Observation is not acceptance

`e2e/runner/collectors/opt-in-observations.cjs` is **default-disabled**.
A trusted consumer may explicitly opt into allowlisted Protocol observations,
bounded Browser/Terminal counts, collector-worker Process metrics and opaque
artifact references. It does not authorize host-wide process inspection,
private-cluster telemetry or access to credentials. Observations carry
`evaluation: null`, **not** an Acceptance verdict; retention metadata is
finite (up to 90 days). Raw terminal text, WebSocket frames, URLs, cookies,
headers, environment variables and process arguments must not be collected.

See [root contributor rules](../CLAUDE.md) and
[Terminal requirements](../docs/design/terminal/README.md).
