'use strict';
// #3829 SC-02: one Browse entry reaches the five Claude resources, and the
// common push/back hierarchy carries nested scope, file and Raw detail. The
// MCP server → tool schema depth is proven by the exact-SHA runtime verifier;
// this fixture surface does not model the MCP wire.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openClaudeApp,
  openBrowse,
  chooseBrowse,
  back,
} = require('../../../shared/claude-app-browser.cjs');

async function header(page) {
  return page.getByTestId('app-page-header');
}

test('SC-02: Browse reaches every Claude resource through one push/back stack', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 390, height: 844 });
  await openClaudeApp(page);

  await expect(header(page)).toContainText('Claude Code');
  await openBrowse(page);
  for (const resource of [
    'conversations',
    'transcripts',
    'memory',
    'mcp',
    'configuration',
  ]) {
    await expect(page.getByTestId('claude-browse-' + resource)).toBeVisible();
  }
  await expect(page.getByTestId('claude-browse-sheet')).toContainText('Work');
  await expect(page.getByTestId('claude-browse-sheet')).toContainText('Resources & setup');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('claude-browse-sheet')).toHaveCount(0);

  // Conversations: collection → candidate → Back.
  await chooseBrowse(page, 'conversations');
  await expect(header(page)).toContainText('Conversations');
  const conversations = page.getByTestId('claude-app-layer-conversations');
  await expect(conversations).toBeVisible();
  await conversations.getByTestId('conversation-candidate-title').nth(1).click();
  await expect(header(page)).toContainText('Conversation');
  const candidate = page.getByTestId('claude-app-layer-conversation');
  await expect(candidate).toContainText('not bound to this Session');
  await back(page);
  await expect(header(page)).toContainText('Conversations');
  await back(page);
  await expect(header(page)).toContainText('Claude Code');

  // Transcripts: list → transcript → record → Raw, and Back through each depth.
  await chooseBrowse(page, 'transcripts');
  await expect(header(page)).toContainText('Transcripts');
  const transcripts = page.getByTestId('claude-app-layer-transcripts');
  await transcripts.getByTestId('transcript-open').first().click();
  await expect(header(page)).toContainText('Transcript');
  const transcript = page.getByTestId('claude-app-layer-transcript');
  await transcript.getByTestId('transcript-record-open').first().waitFor({ timeout: 30_000 });
  await transcript.getByTestId('transcript-record-open').first().click();
  await expect(header(page)).toContainText('Record');
  const record = page.getByTestId('claude-app-layer-record');
  await expect(record.getByTestId('transcript-record-detail')).toBeVisible();
  await record.getByTestId('claude-app-record-raw').click();
  await expect(header(page)).toContainText('Raw record');
  await expect(
    page.getByTestId('claude-app-layer-raw').getByTestId('transcript-raw-inspector'),
  ).toHaveAttribute('data-variant', 'pushed');
  await back(page);
  await expect(header(page)).toContainText('Record');
  await back(page);
  await expect(header(page)).toContainText('Transcript');
  await back(page);
  await expect(header(page)).toContainText('Transcripts');
  await back(page);
  await expect(header(page)).toContainText('Claude Code');

  // Memory: list → file content.
  await chooseBrowse(page, 'memory');
  await expect(header(page)).toContainText('Memory');
  const memory = page.getByTestId('claude-app-layer-memory');
  await memory.getByRole('button', { name: 'MEMORY.md' }).click();
  await expect(header(page)).toContainText('Memory file');
  await expect(
    page.getByTestId('claude-app-layer-memory-file').getByTestId('claude-code-memory-content'),
  ).toBeVisible();
  await back(page);
  await expect(header(page)).toContainText('Memory');
  await back(page);
  await expect(header(page)).toContainText('Claude Code');

  // Configuration: the scope switch lives inside Configuration; a file is a
  // pushed single-column depth.
  await chooseBrowse(page, 'configuration');
  await expect(header(page)).toContainText('Configuration');
  const configuration = page.getByTestId('claude-app-layer-configuration');
  await expect(configuration.getByTestId('claude-app-configuration-project')).toBeVisible();
  await configuration.getByTestId('claude-app-configuration-global').click();
  await expect(configuration.getByTestId('claude-code-scope-global')).toBeVisible();
  await configuration.getByTestId('claude-app-configuration-project').click();
  await configuration.getByTestId('claude-code-file-list').locator('button').first().click();
  await expect(header(page)).toContainText('File');
  await expect(
    page.getByTestId('claude-app-layer-config-file').getByTestId('claude-code-content'),
  ).toBeVisible();
  await back(page);
  await expect(header(page)).toContainText('Configuration');
  await back(page);
  await expect(header(page)).toContainText('Claude Code');

  // MCP: the resource root is reached from the same sheet. The server and tool
  // depths are proven by the runtime verifier because the fixture does not
  // model the MCP wire.
  await chooseBrowse(page, 'mcp');
  await expect(header(page)).toContainText('MCP');
  await expect(page.getByTestId('claude-app-layer-mcp').getByTestId('claude-code-mcp')).toBeVisible();
  await back(page);
  await expect(header(page)).toContainText('Claude Code');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': one Browse sheet listed Conversations, Transcripts, ' +
      'Memory, MCP and Configuration; every resource pushed under the single App ' +
      'header and Back returned through the same hierarchy, including conversation ' +
      'candidate, transcript record and Raw, memory file, Configuration Project/Global ' +
      'scope and file content.',
  });
});
