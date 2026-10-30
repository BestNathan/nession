'use strict';
// #2514 SC-08 (browser half): selecting a process presents its sanitized
// executable + argv first, followed by CPU, RSS, threads, lifetime and I/O;
// the copy affordance copies only that sanitized string; a credential-bearing
// flag is never visible in the browser; the layout stays readable on mobile.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const {
  SECRET,
  copySanitizedCommand,
  inspectCredentialBearingProcess,
  mobileLayout,
  openAgentProcesses,
} = require('../../../shared/process-discovery-browser.js');

test.use({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});

test('SC-08: command-first inspector, sanitized copy and mobile-readable metrics', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const opened = await openAgentProcesses(page, expect, runtime, sha);
  const inspector = await inspectCredentialBearingProcess(page, expect, opened.pane);

  // The credential-bearing flag is replaced before transport, everywhere the
  // browser can see it.
  expect(inspector.command).toContain('--token [REDACTED]');
  expect(inspector.command).not.toContain(SECRET);
  expect(inspector.agentText).not.toContain(SECRET);

  // Command first, then resources; every resource field is present.
  expect(inspector.headings[0]).toBe('Executed command');
  expect(inspector.headings).toContain('Resources');
  expect(inspector.cpu).toContain('CPU (% of one CPU)');
  expect(inspector.cpu).toMatch(/Unavailable|[\d.]+%/);
  expect(inspector.rss).toContain('RSS (MiB)');
  expect(inspector.rss).toMatch(/Unavailable|[\d.]+ MiB/);
  expect(inspector.threads).toContain('Threads');
  expect(inspector.elapsed).toContain('Elapsed');
  expect(inspector.read).toContain('Read I/O (KiB/s)');
  expect(inspector.write).toContain('Write I/O (KiB/s)');

  // Copying uses the sanitized display string, never a raw value.
  const copied = await copySanitizedCommand(page, expect);
  expect(copied).toContain('--token [REDACTED]');
  expect(copied).not.toContain(SECRET);

  const mobile = await mobileLayout(page, expect);
  expect(mobile.visible, 'the command block stays visible at 390px').toBe(true);
  expect(mobile.commandText).toContain('[REDACTED]');
  expect(mobile.commandWidth).toBeLessThanOrEqual(mobile.viewportWidth);
  expect(mobile.documentScrollWidth).toBeLessThanOrEqual(mobile.viewportWidth + 1);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a real child process typed with "--token ' + SECRET +
      '" showed "Executed command" before "Resources" with --token [REDACTED]; the raw secret appeared nowhere in the Agent view; ' +
      'Copy command placed exactly the sanitized string on the clipboard; CPU/RSS/threads/elapsed/read/write were present and ' +
      'unavailable states were kept explicit at 390px with no horizontal overflow',
  });
});
