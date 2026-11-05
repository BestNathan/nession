'use strict';
// #2724 SC-06: the standalone interactive mock is deployed at its browser
// HTML link, the Pages manifest names the prototype source it was published
// from, and that source is byte-identical to the commit pinned in the Issue.
// The preview is also exercised in a real browser (a touch drag must produce
// the destination label), and the pinned source documents its limitations and
// the 36/36 mock interaction suite.
const { createHash } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const PREVIEW = 'https://bestnathan.github.io/nession/prototypes/mobile-swipe-2724/index.html';
const MANIFEST = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const RAW_ROOT = 'https://raw.githubusercontent.com/BestNathan/nession';
const PINNED_SHA = '3ba12b8de09e7d608501c14797e505082dcc8a13';
const SLUG = 'mobile-swipe-2724';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function bodyOrFail(response, label) {
  expect(response.ok(), label + ' must be reachable').toBeTruthy();
  return response.body();
}

test('SC-06: deployed interactive mock matches the pinned prototype source', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-06');

  // 1. The Pages manifest names the branch source the preview was published
  //    from, and the prototype is listed.
  const manifestBody = await bodyOrFail(await page.request.get(MANIFEST), 'prototypes/manifest.json');
  const manifest = JSON.parse(manifestBody.toString('utf8'));
  expect(manifest.source?.branch).toBe('prototype');
  expect(manifest.source?.sha).toMatch(/^[a-f0-9]{40}$/);
  const entry = (manifest.entries ?? []).find((item) => item.slug === SLUG);
  expect(entry, 'the manifest must list ' + SLUG).toBeTruthy();
  const sourceMatch = String(entry.source ?? '').match(/\/blob\/([a-f0-9]{40})\//);
  expect(sourceMatch, 'the entry must name an exact source SHA').not.toBeNull();
  const publishedSourceSha = sourceMatch[1];
  expect(entry.preview).toBe('prototypes/' + SLUG + '/index.html');

  // 2. The browser HTML link is the standalone mock and is interactive: a
  //    touch drag from the shell edge shows the frozen destination label.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PREVIEW, { waitUntil: 'load' });
  await expect(page.locator('#phone')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#terminal')).toBeVisible();
  const phone = await page.locator('#phone').boundingBox();
  if (!phone) throw new Error('the prototype phone shell must be laid out');
  const start = { x: Math.round(phone.x + 3), y: Math.round(phone.y + phone.height / 2) };
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error('no prototype element at the shell edge');
    const touch = new Touch({ identifier: 5, target, clientX: x, clientY: y });
    target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch], targetTouches: [touch], changedTouches: [touch],
      bubbles: true, cancelable: true,
    }));
    const moved = new Touch({ identifier: 5, target, clientX: x + 120, clientY: y });
    target.dispatchEvent(new TouchEvent('touchmove', {
      touches: [moved], targetTouches: [moved], changedTouches: [moved],
      bubbles: true, cancelable: true,
    }));
  }, start);
  const preview = page.locator('#previewTag');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Sessions');

  // 3. The deployed source and the Issue-pinned source are the same file, and
  //    the source is the corrected native-touch implementation.
  const pinnedIndex = await bodyOrFail(
    await page.request.get(`${RAW_ROOT}/${PINNED_SHA}/${SLUG}/index.html`),
    'pinned prototype index.html',
  );
  const publishedIndex = await bodyOrFail(
    await page.request.get(`${RAW_ROOT}/${publishedSourceSha}/${SLUG}/index.html`),
    'published prototype index.html',
  );
  const pinnedHash = sha256(pinnedIndex);
  expect(sha256(publishedIndex)).toBe(pinnedHash);
  const pinnedText = pinnedIndex.toString('utf8');
  expect(pinnedText).toContain('touchcancel');
  expect(pinnedText).toContain('pointercancel');

  // 4. The pinned source documents fidelity/limitations and its mock suite.
  const readme = (await bodyOrFail(
    await page.request.get(`${RAW_ROOT}/${PINNED_SHA}/${SLUG}/README.md`),
    'pinned prototype README.md',
  )).toString('utf8');
  expect(readme.toLowerCase()).toContain('fidelity and limitations');
  expect(readme).toContain('36/36');
  const smoke = await page.request.get(`${RAW_ROOT}/${PINNED_SHA}/${SLUG}/smoke-test.mjs`);
  expect(smoke.ok(), 'the pinned smoke suite must exist').toBeTruthy();

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact product SHA ' + sha + ': Pages preview HTTP 200 and interactive (a shell-edge touch ' +
      'produced the Sessions destination label); prototypes/manifest.json names prototype branch ' +
      manifest.source.sha + ' and source ' + publishedSourceSha + '; raw index.html at that source and at ' +
      'the Issue-pinned ' + PINNED_SHA + ' are byte-identical (sha256 ' + pinnedHash + ') and contain the ' +
      'native-touch touchcancel/pointercancel correction; the pinned README documents fidelity/limitations ' +
      'and the 36/36 mock suite, and smoke-test.mjs is present',
  });
});
