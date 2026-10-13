import { expect, test } from '@playwright/test';
import {
  BOTTOM_EPSILON,
  bottomGap,
  openAppConversation,
  token,
  assertLiveTranscriptMatrix,
  assertLoadOlderAnchor,
} from '../../helpers/conversationAcceptance';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

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

  test('narrow Web preserves nested scroll isolation and copy behavior', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://localhost:4173',
    });
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=tool-scroll');

    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    const process = page.getByTestId('conversation-turn-process');
    const group = page.getByTestId('conversation-tool-group');
    await process.click();
    await group.locator(':scope > summary').click();

    const body = group.getByTestId('conversation-tool-group-body');
    const metrics = await body.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      maxHeight: Number.parseFloat(getComputedStyle(el).maxHeight),
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.maxHeight).toBeLessThanOrEqual(400);

    const transcriptBefore = await viewport.evaluate((el) => el.scrollTop);
    await body.evaluate((el) => {
      el.scrollTop = Math.min(120, el.scrollHeight - el.clientHeight);
    });
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((await viewport.evaluate((el) => el.scrollTop)) - transcriptBefore)).toBeLessThan(2);

    const actions = page.getByTestId('conversation-turn-actions').last();
    const copy = actions.getByRole('button', { name: 'Copy answer' });
    await copy.focus();
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('All 24 activities remain inspectable');
  });

  test('narrow Web covers tail follow, reader override, jump, live identity and focus pinning', async ({
    page,
  }) => {
    await assertLiveTranscriptMatrix(page, async () => {
      await page.goto('/#/fixture/workspace?capability=claude-code&conversation=streaming');
    });
  });

  test('narrow Web load-older preserves the reading anchor', async ({ page }) => {
    await assertLoadOlderAnchor(page, async () => {
      await page.goto('/#/fixture/workspace?capability=claude-code&conversation=paged');
    });
  });
});
