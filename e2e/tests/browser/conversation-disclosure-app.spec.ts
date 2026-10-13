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

  test('touch covers tail follow, reader override, jump, live identity and focus pinning', async ({
    page,
  }) => {
    await assertLiveTranscriptMatrix(page, async () => {
      await openAppConversation(page, 'streaming');
    });
  });

  test('touch load-older keeps an anchored transcript rather than snapping to the top', async ({
    page,
  }) => {
    await assertLoadOlderAnchor(page, async () => {
      await openAppConversation(page, 'paged');
    });
  });
});
