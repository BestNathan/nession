import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoFixtureApp } from '../helpers/fixtureVisual';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const BOTTOM_EPSILON = 6;

async function bottomGap(viewport: Locator): Promise<number> {
  return viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

async function openAppConversation(page: Page, scenario: string): Promise<void> {
  await gotoFixtureApp(page, '?conversation=' + scenario);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-claude-code').click();
  await expect(page.getByTestId('conversation-open')).toBeVisible();
}

async function token(locator: Locator, name: string): Promise<string> {
  return locator.evaluate((el, key) => getComputedStyle(el).getPropertyValue(key).trim(), name);
}

test.describe('SC-14/17/18 · Web conversation contract', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('wide Web keeps hierarchy, nested disclosure, bounded tool scroll and focus copy', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://localhost:4173',
    });
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=tool-scroll');

    const root = page.locator('html');
    expect(await token(root, '--nession-conversation-row-gap')).toBe('8px');
    expect(await token(root, '--nession-conversation-row-gap-expanded')).toBe('16px');
    expect(await token(root, '--nession-conversation-response-gap')).toBe('16px');
    expect(await token(root, '--nession-conversation-reading-column-max')).toBe('720px');

    const user = page.getByTestId('conversation-user-body').last();
    const assistant = page.getByTestId('conversation-assistant-body').last();
    await expect(user).toBeVisible();
    await expect(assistant).toBeVisible();
    expect(await user.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('70%');
    expect(await assistant.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('720px');
    expect(await assistant.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );

    const process = page.getByTestId('conversation-turn-process');
    const group = page.getByTestId('conversation-tool-group');
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toBeHidden();
    await group.evaluate((el) => {
      el.dataset.acceptanceIdentity = 'tool-group';
    });

    await process.click();
    await expect(process).toHaveAttribute('aria-expanded', 'true');
    await expect(group).toBeVisible();
    expect(await group.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('tool-group');
    await expect(group).toHaveAttribute('data-count', '24');
    await expect(group.getByTestId('conversation-tool-group-summary')).toHaveText(
      '8 commands · 8 file reads · 8 searches',
    );

    await group.locator(':scope > summary').click();
    const body = group.getByTestId('conversation-tool-group-body');
    await expect(body).toBeVisible();
    const bodyMetrics = await body.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      maxHeight: getComputedStyle(el).maxHeight,
    }));
    expect(bodyMetrics.scrollHeight).toBeGreaterThan(bodyMetrics.clientHeight);
    expect(Number.parseFloat(bodyMetrics.maxHeight)).toBeLessThanOrEqual(400);

    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    const transcriptBefore = await viewport.evaluate((el) => el.scrollTop);
    await body.evaluate((el) => {
      el.scrollTop = Math.min(120, el.scrollHeight - el.clientHeight);
    });
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((await viewport.evaluate((el) => el.scrollTop)) - transcriptBefore)).toBeLessThan(2);

    const firstTool = group.getByTestId('conversation-tool').first();
    await firstTool.locator('summary').click();
    const copyOutput = firstTool.getByRole('button', { name: 'Copy output' });
    await expect(copyOutput).toBeVisible();

    const assistantSize = await assistant.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const processSize = await process.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(processSize).toBeLessThan(assistantSize);

    const actions = page.getByTestId('conversation-turn-actions').last();
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
    expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    const actionHeight = await actions.evaluate((el) => el.getBoundingClientRect().height);

    const copyAnswer = actions.getByRole('button', { name: 'Copy answer' });
    await copyAnswer.focus();
    await expect.poll(() => actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await copyAnswer.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('All 24 activities remain inspectable');
    expect(await actions.evaluate((el) => el.getBoundingClientRect().height)).toBe(actionHeight);
  });
});

test.describe('SC-14 · narrow Web parity', () => {
  test.use({ viewport: { width: 720, height: 800 } });

  test('narrow Web keeps the same disclosure and keyboard-reachable action model', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=settled');

    const process = page.getByTestId('conversation-turn-process');
    const group = page.getByTestId('conversation-tool-group');
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await process.click();
    await expect(group).toBeVisible();

    expect(await page.getByTestId('conversation-user-body').evaluate((el) => getComputedStyle(el).maxWidth))
      .toBe('70%');
    expect(
      await page.getByTestId('conversation-assistant-body').evaluate((el) => getComputedStyle(el).maxWidth),
    ).toBe('720px');

    const actions = page.getByTestId('conversation-turn-actions').last();
    const copy = actions.getByRole('button', { name: 'Copy answer' });
    await copy.focus();
    await expect.poll(() => actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(copy).toBeFocused();
  });
});

test.describe('SC-19/20 · live transcript identity and scroll ownership', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('working → streaming → settled preserves rows, reader override and focused disclosure', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date('2026-09-01T12:40:00.000Z') });
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=streaming');

    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    const group = page.getByTestId('conversation-tool-group');
    const process = page.getByTestId('conversation-turn-process');

    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('data-count', '2');
    await expect(process).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(BOTTOM_EPSILON);

    await group.evaluate((el) => {
      el.dataset.acceptanceIdentity = 'live-group';
    });

    // Release tail-follow through a real reader gesture. Directly assigning
    // scrollTop only moves the viewport; it deliberately does not tell the
    // MessageScroller that the reader has taken ownership, so the next streamed
    // chunk is allowed to re-engage the live edge.
    await viewport.hover();
    await page.mouse.wheel(0, -420);
    await expect.poll(() => bottomGap(viewport)).toBeGreaterThan(150);
    const readerTop = await viewport.evaluate((el) => el.scrollTop);

    await page.clock.fastForward(3100);

    const liveAnswer = page.getByTestId('conversation-assistant-body').last();
    await expect(liveAnswer).toHaveAttribute('data-streaming', 'true');
    await expect(liveAnswer).toContainText('ownership handoff stays stable while');
    expect(await group.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('live-group');
    await expect(group.getByTestId('conversation-tool')).toHaveCount(2);
    await expect(group.getByTestId('conversation-tool').nth(0)).toHaveAttribute('data-status', 'success');
    await expect(group.getByTestId('conversation-tool').nth(1)).toHaveAttribute('data-status', 'running');
    expect(Math.abs((await viewport.evaluate((el) => el.scrollTop)) - readerTop)).toBeLessThan(6);
    expect(await bottomGap(viewport)).toBeGreaterThan(150);

    const jump = page.getByRole('button', { name: 'Scroll to end' });
    await expect(jump).toHaveAttribute('data-active', 'true');
    // Dispatch the real control event directly: Playwright's pointer actionability
    // waits on animation frames, which are intentionally frozen by the fake clock.
    await jump.dispatchEvent('click');
    await page.clock.fastForward(500);
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(BOTTOM_EPSILON);

    await liveAnswer.evaluate((el) => {
      el.dataset.acceptanceIdentity = 'live-answer';
    });
    const actions = page.getByTestId('conversation-turn-actions').last();
    await actions.evaluate((el) => {
      el.dataset.acceptanceIdentity = 'live-actions';
    });
    const actionHeight = await actions.evaluate((el) => el.getBoundingClientRect().height);
    await expect(actions.getByRole('button', { name: 'Copy answer' })).toHaveCount(0);

    await group.locator(':scope > summary').click();
    const firstTool = group.getByTestId('conversation-tool').first();
    await firstTool.locator('summary').click();
    const copyOutput = firstTool.getByRole('button', { name: 'Copy output' });
    await copyOutput.focus();
    await expect(copyOutput).toBeFocused();

    const rowsBeforeSettle = await page.locator('[data-slot="message-scroller-item"]').count();
    await page.clock.fastForward(3100);

    await expect(liveAnswer).not.toHaveAttribute('data-streaming', 'true');
    await expect(liveAnswer).toContainText('final tool result settles');
    await expect(group.getByTestId('conversation-tool').nth(1)).toHaveAttribute('data-status', 'success');
    await expect(actions.getByRole('button', { name: 'Copy answer' })).toBeVisible();

    expect(await liveAnswer.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('live-answer');
    expect(await group.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('live-group');
    expect(await actions.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('live-actions');
    expect(await page.locator('[data-slot="message-scroller-item"]').count()).toBe(rowsBeforeSettle);
    expect(await actions.evaluate((el) => el.getBoundingClientRect().height)).toBe(actionHeight);
    await expect(process).toHaveAttribute('aria-expanded', 'true');
    expect(await group.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    expect(await firstTool.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(copyOutput).toBeFocused();
  });

  test('loading older history leaves the reader away from zero instead of losing the anchor', async ({
    page,
  }) => {
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=paged');
    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    const rows = page.locator('[data-slot="message-scroller-item"]');
    const before = await rows.count();

    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByText('Earlier page — the pull-to-load boundary marker.')).toBeAttached();
  });
});

test.describe('SC-14/18/20 · App touch parity', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('touch keeps actions reachable and uses the App density while sharing disclosure', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://localhost:4173',
    });
    await openAppConversation(page, 'tool-scroll');

    const app = page.locator('[data-experience="app"]').first();
    expect(await token(app, '--nession-conversation-bubble-max-width')).toBe('82%');

    const process = page.getByTestId('conversation-turn-process');
    const group = page.getByTestId('conversation-tool-group');
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await process.click();
    await group.locator(':scope > summary').click();

    const body = group.getByTestId('conversation-tool-group-body');
    const metrics = await body.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      maxHeight: Number.parseFloat(getComputedStyle(el).maxHeight),
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.maxHeight).toBeLessThanOrEqual(320);

    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(false);
    const actions = page.getByTestId('conversation-turn-actions').last();
    expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const copy = actions.getByRole('button', { name: 'Copy answer' });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('All 24 activities remain inspectable');

    const firstTool = group.getByTestId('conversation-tool').first();
    await firstTool.locator('summary').click();
    await expect(firstTool.getByRole('button', { name: 'Copy output' })).toBeVisible();
  });

  test('touch load-older keeps an anchored transcript rather than snapping to the top', async ({
    page,
  }) => {
    await openAppConversation(page, 'paged');
    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    const rows = page.locator('[data-slot="message-scroller-item"]');
    const before = await rows.count();

    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByText('Earlier page — the pull-to-load boundary marker.')).toBeAttached();
  });
});
