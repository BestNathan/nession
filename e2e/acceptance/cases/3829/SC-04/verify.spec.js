'use strict';
// #3829 SC-04: unbound, empty, unavailable, thread-unavailable and offline
// states are stated honestly; a foreground `claude` process is never turned
// into a working claim. The Session-change invalidation and the loading state
// are proven by the exact-SHA runtime verifier.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openClaudeApp } = require('../../../shared/claude-app-browser.cjs');

test('SC-04: Claude App states are honest and never infer work from the foreground CLI', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });

  // Unbound, with strict-cwd candidates: never promoted to "current".
  await openClaudeApp(page, '?conversation=unbound');
  await expect(page.getByTestId('claude-app-unbound')).toBeVisible();
  await expect(page.getByText('No conversation linked to this Session')).toBeVisible();
  await expect(page.getByTestId('conversation-open')).toHaveCount(0);
  await expect(
    page.getByTestId('claude-app-root').getByTestId('conversation-candidate-title').first(),
  ).toBeVisible();
  await expect(page.getByText('Opening a conversation does not make it the current Session conversation.')).toBeVisible();

  // Read, and empty: a different answer from unavailable.
  await openClaudeApp(page, '?conversation=none');
  await expect(page.getByTestId('claude-app-unbound')).toBeVisible();
  await expect(page.getByTestId('conversation-not-found')).toHaveText('No conversations here yet.');
  await expect(page.getByTestId('conversation-open')).toHaveCount(0);

  // The directory cannot be read at all: the list guard speaks, not the
  // no-binding explanation.
  await openClaudeApp(page, '?conversation=unavailable');
  await expect(page.getByTestId('conversation-unavailable')).toHaveText(
    'This host has no conversations here.',
  );
  await expect(page.getByTestId('claude-app-unbound')).toHaveCount(0);

  // The list reads, but the thread cannot: the bound title stays, the reader
  // says it cannot read the conversation rather than pretending it is empty.
  await openClaudeApp(page, '?conversation=thread-unavailable');
  await expect(page.getByTestId('conversation-open')).toBeVisible();
  await expect(page.getByTestId('conversation-unavailable')).toContainText(
    'This conversation cannot be read right now.',
  );
  await expect(page.getByTestId('conversation-empty')).toHaveCount(0);

  // Agent offline: said plainly, with no stale transcript underneath.
  await openClaudeApp(page, '?agents=offline');
  await expect(page.getByTestId('claude-app-offline')).toBeVisible();
  await expect(page.getByTestId('claude-app-offline')).toContainText('Agent is offline');
  await expect(page.getByTestId('conversation-open')).toHaveCount(0);

  // A foreground `claude` process while the provider says the bound
  // conversation is inactive must not become "Running now" or "Working".
  await openClaudeApp(page, '?conversation=inactive&pane=claude.exe');
  await expect(page.getByTestId('conversation-state')).toHaveText('Finished');
  await expect(page.getByText('Working')).toHaveCount(0);
  await expect(page.getByText('Running now')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': unbound showed strict-cwd candidates without a current ' +
      'claim; empty, list-unavailable, thread-unavailable and agent-offline each ' +
      'rendered their own sentence; with ?pane=claude.exe and the provider saying ' +
      'inactive the header read "Finished" and never "Working"/"Running now".',
  });
});
