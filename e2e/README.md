# E2E Testing Guide

## Overview

Nession uses Playwright for end-to-end testing of the web UI and its integration with the server and agent components. E2E tests run in CI on every PR to staging and can be triggered manually.

## Test Structure

```
e2e/
├── fixtures/              # Configuration for server and agent
│   ├── server/
│   │   └── config.toml    # Server config with isolated paths
│   └── agent-config.e2e.toml  # Agent config with isolated working dir
├── helpers/               # Test utilities
│   ├── dashboard.ts       # waitForDashboard helper
│   └── reset.ts           # resetAuth helper
├── specs/                 # Test specifications
│   ├── login.spec.ts      # Authentication tests
│   ├── session-lifecycle.spec.ts  # Session create/kill tests
│   └── terminal-io.spec.ts       # Terminal I/O tests (relay + P2P)
├── globalSetup.ts         # Pre-test cleanup and isolation
└── playwright.config.ts   # Playwright configuration
```

## Running E2E Tests

### Locally

```bash
cd e2e
npm install
npx playwright test
```

**Note:** Local E2E tests require:
- Rust toolchain (for `cargo run`)
- tmux installed
- Node.js 20+

### In CI

E2E tests automatically run on:
- Push to `staging` branch
- Pull requests targeting `staging`
- Manual trigger via GitHub Actions UI

The workflow:
1. Builds Rust binaries (`cargo build`)
2. Builds web UI (`npm run build`)
3. Installs Playwright browsers
4. Runs E2E tests with isolated tmux socket

## Test Isolation

E2E tests use several isolation mechanisms to prevent interference with the host system:

### tmux Socket Isolation

Tests use a dedicated tmux socket directory to avoid conflicts with the user's tmux sessions:

```typescript
// playwright.config.ts
env: {
  TMUX_TMPDIR: '/tmp/nession-e2e/tmux',
  NESSION_HOME: '/tmp/nession-e2e',
}
```

### Database Isolation

Server uses an isolated database path:

```toml
# e2e/fixtures/server/config.toml
db_path = "/tmp/nession-e2e/nession.db"
```

### Working Directory Isolation

Agent uses an isolated working directory:

```toml
# e2e/fixtures/agent-config.e2e.toml
default_working_dir = "/tmp/nession-e2e"
```

## Test Suites

### Login Tests (`login.spec.ts`)

Tests authentication flows:
- Auto-connect via URL token parameter
- Form-based login (currently skipped due to timing issues)

**Direct WebSocket URL:** Tests use `?server_url=ws://localhost:19090/ws` to bypass vite preview's flaky WebSocket proxy.

### Session Lifecycle Tests (`session-lifecycle.spec.ts`)

Tests the complete session lifecycle:
1. Wait for agent to register (Create button enabled)
2. Create a new session via UI
3. Verify session appears in the list
4. Kill the session via UI
5. Verify session disappears from the list

**Timeout:** Agent registration wait time is 60 seconds to accommodate slow CI environments.

### Terminal I/O Tests (`terminal-io.spec.ts`)

Tests terminal input/output in both relay and P2P modes:
1. Create a session
2. Attach to the session in specified mode (Relay or P2P)
3. Type a command (`echo nession-e2e-ok`)
4. Verify the output appears in the terminal buffer

**Terminal Buffer Reading:** Tests access the xterm.js buffer via the `xtermInstance` property exposed on the container element, since canvas/webgl renderers don't put text in the DOM.

## Common Issues and Solutions

### Agent Disconnected Error

**Symptom:** Create Session dialog shows "Agent disconnected" error.

**Root Cause:** Agent's WebSocket connection to server drops during session creation.

**Solution (implemented):**
1. Increased session create/kill timeout from 10s to 30s
2. Elevated `unregister_agent` log level from debug to info
3. HeartbeatLoop now checks connection state before sending
4. Reduced first heartbeat delay from 10s to 1s

**See:** PR #317 for implementation details.

### Flaky Dashboard Load

**Symptom:** `waitForDashboard` times out waiting for filter-row.

**Root Cause:** Slow CI environment causes agent registration to take longer than expected.

**Solution:** Increased timeout to 90 seconds in `helpers/dashboard.ts`.

### WebSocket Proxy Issues

**Symptom:** Tests fail with WebSocket connection errors.

**Root Cause:** vite preview's WebSocket proxy is unreliable in CI.

**Solution:** Use direct WebSocket URL via `?server_url=` parameter instead of relying on the proxy.

## Debugging Failed Tests

### View Playwright Report

After a CI run, download the `playwright-report` artifact:

```bash
gh run download <run-id> --name playwright-report
npx playwright show-report playwright-report
```

### Check Server/Agent Logs

In CI, server and agent logs are captured in the workflow output. Look for:
- `[WebServer]` prefix for server logs
- Agent registration messages
- Heartbeat logs
- Session creation/kill events

### Local Debugging

Run tests with headed browser:

```bash
npx playwright test --headed
```

Run specific test:

```bash
npx playwright test -g "session lifecycle"
```

## Adding New Tests

1. Create a new file in `e2e/specs/`
2. Import helpers from `e2e/helpers/`
3. Use `waitForDashboard()` before interacting with the dashboard
4. Use direct WebSocket URL: `ws://localhost:19090/ws`
5. Add unique session names to avoid conflicts
6. Use Playwright's auto-retrying assertions (`expect().toBeVisible()`, etc.)

Example:

```typescript
import { test, expect } from '@playwright/test';
import { waitForDashboard } from '../helpers/dashboard';

test.describe('My Feature', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?token=e2e-test-token&server_url=' + 
      encodeURIComponent('ws://localhost:19090/ws'));
    await waitForDashboard(page);
  });

  test('does something', async ({ page }) => {
    // Test implementation
  });
});
```

## CI Configuration

The E2E workflow (`.github/workflows/e2e.yml`):

- **Triggers:** `workflow_dispatch`, `push` to staging, `pull_request` to staging
- **Runs on:** `ubuntu-latest`
- **Steps:**
  1. Checkout code
  2. Install tmux
  3. Setup Rust toolchain
  4. Build Rust binaries
  5. Setup Node.js
  6. Install web dependencies
  7. Build web UI
  8. Install Playwright browsers
  9. Run E2E tests
  10. Upload Playwright report artifact

**Timeout:** 30 minutes per job.

**Retry Policy:** Tests retry 2 times in CI (configured in `playwright.config.ts`).

## Canonical visual regression (#561 / #548)

Deterministic fixture routes (`/#/fixture`, `/#/fixture/workspace`, `/#/fixture/app`) have a focused screenshot gate in `specs/fixture-visual.spec.ts`. Functional checks in `fixture-*.spec.ts` run separately; visual tests compare full-page screenshots after assertions pass.

| Baseline | Viewport | Snapshot name |
|----------|----------|---------------|
| Web Active Terminal | 1440×900 | `web-active-terminal.png` |
| Web Workspace | 1440×900 | `web-workspace.png` |
| Web compact Terminal | 1024×768 | `web-compact-terminal.png` |
| Web compact Workspace | 1024×768 | `web-compact-workspace.png` |
| App Terminal | 390×844 | `app-terminal.png` |
| App Sessions | 390×844 | `app-sessions.png` |
| App Workspace | 390×844 | `app-workspace.png` |

Snapshots live in `e2e/specs/__snapshots__/fixture-visual.spec.ts/` (committed to git).

### Updating baselines

After an **intentional** visual change to a canonical screen:

```bash
./scripts/update-canonical-snapshots.sh
# or manually:
cd e2e && CI=true npx playwright test fixture-visual --update-snapshots
```

Review the diff, commit updated PNGs, and note the visual change in the PR. CI uploads `visual-snapshot-diffs` artifacts on failure.

Relative-time labels use a frozen clock (`e2e/helpers/fixtureVisual.ts`) during visual tests only.

## Maintenance

### Updating Dependencies

```bash
cd e2e
npm update @playwright/test
npx playwright install
```

### Adding shadcn Components

If tests need to interact with new shadcn components, ensure they have proper ARIA attributes for Playwright locators.

### Performance Tuning

If tests are flaky due to timing:
1. Increase timeouts in `playwright.config.ts`
2. Use `expect().toPass()` for async conditions
3. Add explicit waits for critical UI elements
4. Consider using `page.waitForLoadState('networkidle')` for complex interactions

## References

- [Playwright Documentation](https://playwright.dev/)
- [Playwright Test API](https://playwright.dev/docs/api/class-test)
- [Nession Architecture](../../CLAUDE.md#architecture)
- [CI/CD Workflow](../../CLAUDE.md#cicd-github-actions)
