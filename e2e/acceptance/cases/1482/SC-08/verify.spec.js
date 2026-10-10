const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { verifyTerminalClearance } = require('../../../../../acceptance/shared/terminal-clearance-browser.js');

test.use({ viewport: { width: 1440, height: 900 } });

test('SC-08: exact-SHA Terminal/Capsule occlusion contract (#1347 SC-12)', async ({ page }, testInfo) => {
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const evidence = await verifyTerminalClearance(page, expect, runtime, sha);
  // SC-08 is an evidence contract, not another independent statement that
  // the CSS spelling is correct. All geometry must be observable on this SHA.
  expect(evidence.target_sha).toBe(sha);
  expect(evidence.revalidates).toBe('#1347 SC-12');
  expect(evidence.evidence_kind).toBe('computed-css-and-rendered-xterm-cell-geometry');
  for (const stage of ['web', 'restored', 'app', 'compactApp', 'webRestored']) {
    const frame = evidence[stage];
    expect(frame.rows, stage + ' rows').toBeGreaterThan(0);
    expect(frame.cursorLineNonEmpty, stage + ' last cursor line').toBe(true);
    expect(frame.gridBottom, stage + ' grid/capsule gap').toBeLessThanOrEqual(frame.shellTop + 1);
    expect(frame.cursorBottom, stage + ' cursor/capsule gap').toBeLessThanOrEqual(frame.shellTop + 1);
    expect(frame.inset, stage + ' clearance').toBeGreaterThan(0);
  }
  expect(evidence.history.inset).toBe(0);
  expect(evidence.history.viewportY).toBeLessThan(evidence.history.baseY);
  await testInfo.attach('terminal-clearance-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
