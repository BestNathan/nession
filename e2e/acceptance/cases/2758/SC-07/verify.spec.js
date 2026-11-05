'use strict';
// Issue #2758 SC-07 — Chrome/Playwright proof, not mock-source inspection.
// Real product Fixture and independently published, revision-pinned prototype.
// Runs in the unprivileged full-stack-local source-aligned Case runner after merge.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const PROTOTYPE_SHA = 'f5926ba14fb698bd9a9e7c5ab1ff3a585262a7d8';
const SITE = 'https://bestnathan.github.io/nession/prototypes/';
const URL = SITE + 'terminal-keys-commands-2710/index.html';
const SOURCE = 'https://github.com/BestNathan/nession/blob/' + PROTOTYPE_SHA +
  '/terminal-keys-commands-2710/index.html';
const SIZES = [375, 390, 430];

async function realFixture(page, width) {
  await page.setViewportSize({width, height:844});
  await page.goto('about:blank');
  await page.goto('/#/fixture/clipboard?capability=terminal-keys');
  await expect(page.getByTestId('fixture-clipboard')).toBeVisible();
  await expect(page.getByTestId('terminal-keys-body')).toBeVisible();
  await expect(page.getByTestId('phys-key-Tab')).toBeVisible();
  await expect(page.getByTestId('phys-key-↑')).toBeVisible();
  await expect(page.locator('[data-terminal-viewport] .xterm')).toBeVisible();
  return page.evaluate(() => {
    const keys = document.querySelector('[data-testid="terminal-keys-body"]');
    const projection = document.querySelector('[data-testid="capsule-capability-projection"]');
    const well = document.querySelector('[data-terminal-viewport]');
    const engine = document.querySelector('.xterm')?.parentElement?.xtermInstance;
    const box = node => node?.getBoundingClientRect();
    if (!keys || !projection || !well || !engine) throw Error('production Fixture incomplete');
    const shell = box(projection), viewport = box(well);
    return {
      columns: engine.cols,
      rows: engine.rows,
      appWidth: window.innerWidth,
      projection: {width:shell.width, height:shell.height, bottom:shell.bottom},
      well: {width:viewport.width, height:viewport.height},
      commonKeys: [...keys.querySelectorAll('[data-testid^="phys-key-"]')]
        .map(node => node.getAttribute('data-testid')).filter(Boolean),
    };
  });
}

async function readMockGeometry(page) {
  return page.evaluate(() => {
    const device = document.querySelector('[data-np-device]');
    const term = document.querySelector('#terminal');
    const dock = document.querySelector('#dock');
    if (!(device instanceof HTMLElement) || !(term instanceof HTMLElement) ||
        !(dock instanceof HTMLElement)) throw Error('prototype device/Terminal/Dock missing');
    const box = device.getBoundingClientRect();
    const t = term.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    return {
      width:box.width, height:box.height, terminalWidth:t.width,
      terminalHeight:t.height, dockTop:d.top,
      terminalFont:Number.parseFloat(getComputedStyle(term).fontSize),
      columns:Number(term.dataset.mockTerminalCols),
      fits:term.dataset.mockCellFit,
      bufferLines:term.querySelectorAll('.entry').length,
      scrollHeight:term.scrollHeight, clientHeight:term.clientHeight,
      clearance:Number(term.dataset.clearancePx || 0),
      source:document.querySelector('[data-nession-source-link]')?.getAttribute('href'),
      hasInjectedLegacyNav:!!document.querySelector('.nession-preview-nav'),
      reviewOutsideDevice:!device.querySelector('#mock-event-log,[data-np-size],[data-nession-source-link]'),
    };
  });
}

test('SC-07: public three-region 1:1 prototype is interactive and compared to real App Fixture at three sizes', async ({page, browser, request}, testInfo) => {
  test.setTimeout(240_000);
  const { sha: productSha } = verifiedRuntime('SC-07');

  // Verify that the EXACT published orphan bytes are being inspected, not the
  // currently mutable branch or a stale public HTML from a prior deployment.
  const manifestResponse = await request.get(SITE + 'manifest.json');
  expect(manifestResponse.ok(), 'published HTTPS prototype manifest accessible').toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.schema_version).toBe(1);
  expect(manifest.source.sha).toBe(PROTOTYPE_SHA);
  const entry = manifest.entries.find(item => item.slug === 'terminal-keys-commands-2710');
  expect(entry?.source).toBe(SOURCE);

  const real = {};
  for (const width of SIZES) {
    real[width] = await realFixture(page,width);
    expect(real[width].appWidth).toBe(width);
    expect(real[width].columns).toBeGreaterThan(0);
    expect(real[width].rows).toBeGreaterThan(1);
    expect(real[width].well.width, width+' actual xterm content well').toBeGreaterThan(0);
    expect(real[width].projection.height, width+' actual Capsule upper projection').toBeGreaterThan(0);
    for (const key of ['Tab', 'Enter', '↑', '↓']) {
      expect(real[width].commonKeys, width + ' product includes ' + key)
        .toContain('phys-key-' + key);
    }
    await testInfo.attach('production-keys-' + width + '.png', {
      body:await page.screenshot(),contentType:'image/png',
    });
  }

  // Do not use "same screenshot" as a false equivalence: real xterm and this
  // DOM-text mock are intentionally distinct. Capture both and compare true
  // dimensional, control inventory and source requirements.
  await page.setViewportSize({width:1440,height:1050});
  await page.goto(URL);
  await expect(page.getByRole('heading',{name:'Terminal Keys & Quick Commands'})).toBeVisible();
  await expect(page.locator('.np-overview')).toBeVisible();
  await expect(page.locator('.np-details')).toBeVisible();
  await expect(page.locator('[data-np-device]')).toBeVisible();
  await expect(page.locator('[data-nession-source-link]')).toHaveAttribute('href',SOURCE);
  await expect(page.locator('[data-nession-gallery-link]'))
    .toHaveAttribute('href','../../#/prototypes');

  const measured = {};
  for (const width of SIZES) {
    await page.locator('[data-np-size="' + width + '"]').click();
    await expect.poll(async () => (await readMockGeometry(page)).width).toBe(width);
    await expect.poll(async () => (await readMockGeometry(page)).columns).toBe(96);
    const start = await readMockGeometry(page);
    expect(start.height, width + ' device height').toBe(844);
    expect(start.fits, width + ' fixed grid must fit in viewport').toBe('true');
    expect(start.terminalFont).toBeGreaterThan(0);
    expect(start.terminalFont).toBeLessThanOrEqual(14.01);
    expect(start.bufferLines).toBeGreaterThanOrEqual(160);
    expect(start.scrollHeight).toBeGreaterThan(start.clientHeight);
    expect(start.source).toBe(SOURCE);
    expect(start.reviewOutsideDevice).toBe(true);
    expect(start.hasInjectedLegacyNav).toBe(false);
    measured[width] = {real:real[width],mock:start};

    await page.locator('#plus').click();
    await page.locator('#upper [data-act="keys"]').click();
    await expect(page.locator('#upper .keys-body')).toBeVisible();
    await page.locator('#upper [data-chord="Ctrl+C"]').click();
    await expect(page.locator('#mock-event-log')).toContainText('Ctrl+C · 0x03');
    expect(await page.locator('#upper .key').count()).toBe(5);
    expect(await page.locator('#upper .arrow').count()).toBe(4);
    await page.locator('#upper [data-mod="Ctrl"]').click();
    await page.locator('#upper [data-letter="X"]').click();
    await expect(page.locator('#mock-event-log')).toContainText('Ctrl+X · 0x18');
    await page.locator('#upper [data-act="commands"]').click();
    await expect(page.locator('#upper .commands-body')).toBeVisible();

    const atOpen = await readMockGeometry(page);
    expect(atOpen.clearance,width+' opened panel clearance').toBeGreaterThan(0);
    const top = await page.locator('#terminal').evaluate(node => {
      node.scrollTop=0;return node.scrollTop;
    });
    expect(top).toBe(0);
    await page.locator('#terminal').hover();
    await page.mouse.wheel(0,20000);
    await expect.poll(async () => page.locator('#terminal')
      .evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    // At the newest output the full panel clears it rather than obscuring it.
    const live = await page.evaluate(() => ({
      last:document.querySelector('#terminal .entry:last-child')?.getBoundingClientRect().bottom,
      top:document.querySelector('#dock')?.getBoundingClientRect().top,
    }));
    expect(live.last, width+' latest Terminal output must clear the Capsule')
      .toBeLessThanOrEqual(live.top+2);
    await page.mouse.wheel(0,-20000);
    await expect.poll(async () => page.locator('#terminal')
      .evaluate(node => node.scrollTop)).toBe(0);

    await testInfo.attach('prototype-keys-' + width + '.png',{
      body:await page.locator('[data-np-device]').screenshot(),contentType:'image/png',
    });
    await page.locator('#upper button.insert[data-insert="0"]').click();
    await expect(page.locator('#intent')).toHaveValue('git status');
    await page.locator('#plus').click();
    await page.locator('#upper [data-act="commands"]').click();
    await page.locator('#upper button.run[data-run="0"]').click();
    await expect(page.locator('#mock-event-log')).toContainText('Run: git status + Return');
    await page.locator('#workspace').click();
    await expect(page.locator('#workspace-view')).toBeVisible();
    await page.locator('#workspace-return').click();
    await expect(page.locator('#workspace-view')).toBeHidden();

    await page.locator('[data-np-reset]').click();
    await expect(page.locator('#mock-event-log')).toHaveText('No events yet');
  }

  // Real CSS pixels: on a narrow *browser*, the 430px App is scrollable rather
  // than downscaled. No CSS transform can silently change its cell coordinates.
  await page.setViewportSize({width:350,height:800});
  await page.locator('[data-np-size="430"]').click();
  const narrow = await page.evaluate(() => ({
    device:document.querySelector('[data-np-device]')?.getBoundingClientRect().width,
    stageClient:document.querySelector('.np-stage')?.clientWidth,
    stageScroll:document.querySelector('.np-stage')?.scrollWidth,
    transform:getComputedStyle(document.querySelector('[data-np-device]')).transform,
  }));
  expect(narrow.device).toBe(430);
  expect(narrow.stageScroll).toBeGreaterThan(narrow.stageClient);
  expect(narrow.transform).toBe('none');

  // Real Chromium touch input, not a synthetic DOM click, still activates the
  // capsule on the mobile-sized browser even when horizontal stage pan exists.
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  try {
    const phone=await context.newPage();
    await phone.goto(URL);
    // The three-region review header precedes the 844px device; on a real
    // 390x844 browser its capsule starts below the initial fold. Scroll it into
    // the visible touch viewport before using physical touchscreen coordinates.
    await phone.locator('#plus').scrollIntoViewIfNeeded();
    const plus=await phone.locator('#plus').boundingBox();
    expect(plus).toBeTruthy();
    await phone.touchscreen.tap(plus.x+plus.width/2,plus.y+plus.height/2);
    await expect(phone.locator('#upper [data-act="keys"]')).toBeVisible();
    await phone.locator('#upper [data-act="keys"]').scrollIntoViewIfNeeded();
    const keys=await phone.locator('#upper [data-act="keys"]').boundingBox();
    expect(keys).toBeTruthy();
    await phone.touchscreen.tap(keys.x+keys.width/2,keys.y+keys.height/2);
    await expect(phone.locator('#upper .keys-body')).toBeVisible();
    await testInfo.attach('prototype-touch-390.png',{
      body:await phone.screenshot(),contentType:'image/png',
    });
  } finally { await context.close(); }

  const brief=JSON.stringify({productSha,prototypeSha:PROTOTYPE_SHA,sizes:measured,narrow});
  testInfo.annotations.push({
    type:'evidence',
    description:'Browser measured: '+brief,
  });
  console.log('SC-07 source-pinned visual + behavior measurements: '+brief);
});
