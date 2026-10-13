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
