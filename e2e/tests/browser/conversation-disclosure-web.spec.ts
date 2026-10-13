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
