import { expect, type Locator, type Page } from '@playwright/test';
import { gotoFixtureApp } from './fixtureVisual';


export const BOTTOM_EPSILON = 6;

export async function bottomGap(viewport: Locator): Promise<number> {
  return viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

export async function openAppConversation(page: Page, scenario: string): Promise<void> {
  await gotoFixtureApp(page, '?conversation=' + scenario);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-claude-code').click();
  await expect(page.getByTestId('conversation-open')).toBeVisible();
}

export async function token(locator: Locator, name: string): Promise<string> {
  return locator.evaluate((el, key) => getComputedStyle(el).getPropertyValue(key).trim(), name);
}

export async function assertLiveTranscriptMatrix(
  page: Page,
  openConversation: () => Promise<void>,
): Promise<void> {
  await page.clock.install({ time: new Date('2026-09-01T12:40:00.000Z') });
  await openConversation();

  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  const group = page.getByTestId('conversation-tool-group');
  const process = page.getByTestId('conversation-turn-process');

  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-count', '2');
  await expect(process).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(BOTTOM_EPSILON);

  await group.evaluate((el) => {
    el.dataset.acceptanceIdentity = 'matrix-live-group';
  });

  // Reader ownership must be released by a real input gesture, not merely by
  // assigning scrollTop. The same shared scroller contract is exercised at all
  // three product densities below.
  await viewport.hover();
  await page.mouse.wheel(0, -420);
  await expect.poll(() => bottomGap(viewport)).toBeGreaterThan(150);
  const readerTop = await viewport.evaluate((el) => el.scrollTop);

  await page.clock.fastForward(3100);

  const liveAnswer = page.getByTestId('conversation-assistant-body').last();
  await expect(liveAnswer).toHaveAttribute('data-streaming', 'true');
  await expect(liveAnswer).toContainText('ownership handoff stays stable while');
  expect(await group.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('matrix-live-group');
  await expect(group.getByTestId('conversation-tool')).toHaveCount(2);
  await expect(group.getByTestId('conversation-tool').nth(0)).toHaveAttribute('data-status', 'success');
  await expect(group.getByTestId('conversation-tool').nth(1)).toHaveAttribute('data-status', 'running');
  expect(Math.abs((await viewport.evaluate((el) => el.scrollTop)) - readerTop)).toBeLessThan(6);
  expect(await bottomGap(viewport)).toBeGreaterThan(150);

  const jump = page.getByRole('button', { name: 'Scroll to end' });
  await expect(jump).toHaveAttribute('data-active', 'true');
  await jump.dispatchEvent('click');
  await page.clock.fastForward(500);
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(BOTTOM_EPSILON);

  await liveAnswer.evaluate((el) => {
    el.dataset.acceptanceIdentity = 'matrix-live-answer';
  });
  const actions = page.getByTestId('conversation-turn-actions').last();
  await actions.evaluate((el) => {
    el.dataset.acceptanceIdentity = 'matrix-live-actions';
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

  expect(await liveAnswer.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('matrix-live-answer');
  expect(await group.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('matrix-live-group');
  expect(await actions.evaluate((el) => el.dataset.acceptanceIdentity)).toBe('matrix-live-actions');
  expect(await page.locator('[data-slot="message-scroller-item"]').count()).toBe(rowsBeforeSettle);
  expect(await actions.evaluate((el) => el.getBoundingClientRect().height)).toBe(actionHeight);
  await expect(process).toHaveAttribute('aria-expanded', 'true');
  expect(await group.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  expect(await firstTool.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  await expect(copyOutput).toBeFocused();
}

export async function assertLoadOlderAnchor(page: Page, openConversation: () => Promise<void>): Promise<void> {
  await openConversation();
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  const rows = page.locator('[data-slot="message-scroller-item"]');
  const before = await rows.count();

  await viewport.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => rows.count()).toBeGreaterThan(before);
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByText('Earlier page — the pull-to-load boundary marker.')).toBeAttached();
}

