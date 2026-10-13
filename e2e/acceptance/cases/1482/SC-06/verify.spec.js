const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { verifyTerminalClearance } = require('../../../shared/terminal-clearance-browser.js');

test.use({ viewport: { width: 1440, height: 900 } });

test('SC-06: exact-SHA Terminal/Capsule occlusion contract (#1347 SC-12)', async ({ page }, testInfo) => {
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const evidence = await verifyTerminalClearance(page, expect, runtime, sha);
  await testInfo.attach('terminal-clearance-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
