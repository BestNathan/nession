'use strict';
// #2514 SC-09 (browser half): the resource scope control switches between the
// selected PID and its PPID descendants, keeps the selected command, and labels
// the metric units honestly at the one-CPU scale.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const {
  inspectRoot,
  openAgentProcesses,
  subtreeScope,
  terminalContinuity,
} = require('../../../shared/process-discovery-browser.js');

test.use({ viewport: { width: 1440, height: 900 } });

test('SC-09: per-PID and PPID-descendant resource scope stay truthful', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const opened = await openAgentProcesses(page, expect, runtime, sha);
  const selected = await inspectRoot(page, expect, opened.pane);

  // The selected command belongs to the selected PID and does not change when
  // only the metric scope changes.
  const subtree = await subtreeScope(page, expect);
  expect(subtree.command).toBe(selected.command);
  expect(subtree.processes).toBeGreaterThanOrEqual(2);
  expect(subtree.selectedPid).toBeGreaterThan(0);
  expect(subtree.elapsed).toContain('Elapsed (selected process)');
  expect(subtree.cpu).toContain('CPU (% of one CPU)');
  expect(subtree.cpu).toMatch(/Unavailable|[\d.]+%/);
  expect(subtree.rss).toContain('RSS (MiB)');
  expect(subtree.rss).toMatch(/Unavailable|[\d.]+ MiB/);
  expect(subtree.read).toContain('Read I/O (KiB/s)');

  // Discovery is read-only: the terminal still carries input afterwards.
  await terminalContinuity(page, expect);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': selecting the Pane root and switching to "With descendants" kept its command unchanged, ' +
      'reported ' + subtree.processes + ' deduplicated PPID descendants including PID ' + subtree.selectedPid +
      ', labeled CPU as % of one CPU / RSS as MiB / I-O as KiB/s, and left Terminal input working',
  });
});
