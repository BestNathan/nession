'use strict';
// #2969 SC-02: a rejected URL bootstrap token is removed from the URL, and a
// reload neither reimports it nor automatically retries from the query string.
// The rejected token is also cleared from storage by the existing rejection
// path; a credential intentionally stored by the existing policy is exercised
// by SC-03, not this Case.
//
// Chromium + the production Web build; the Server is a verifier-owned
// WebSocket route that answers `server.auth` with a refusal.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  createAuthServerState,
  installFakeAuthServer,
  readAuthStorage,
  fetchIndexHtml,
} = require('../../../shared/auth-persistence-browser.cjs');

const TOKEN = 'rejected-token-2969';
const SERVER = 'ws://bootstrap.test/ws';

test('SC-02: a rejected URL token cannot be reimported by a reload', async ({
  page, context, request,
}) => {
  test.setTimeout(120_000);
  const { runtime, sha } = verifiedRuntime('SC-02');

  const html = await fetchIndexHtml(request, runtime);
  expect(html, 'the runtime serves the production bundle').toMatch(/src="\/assets\/[^"]+\.js"/);
  expect(html, 'the runtime is not the Vite dev entry').not.toContain('/src/main.tsx');

  const state = createAuthServerState();
  state.phase = 'reject';
  await installFakeAuthServer(context, state);

  await page.goto(
    '/?token=' + TOKEN + '&server_url=' + encodeURIComponent(SERVER) + '&keep=1#/',
  );

  // The auto-connect attempt carried the URL token and was refused.
  await expect.poll(() => state.authTokens.length).toBeGreaterThan(0);
  expect(state.authTokens[0]).toBe(TOKEN);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByText(/Enter your auth token and click Connect/)).toBeVisible();

  // The refusal removed the URL credential and the rejection cleared storage.
  await expect.poll(() => new URL(page.url()).searchParams.has('token')).toBe(false);
  const url = new URL(page.url());
  expect(url.searchParams.get('server_url')).toBe(SERVER);
  expect(url.searchParams.get('keep')).toBe('1');
  expect(url.hash).toBe('#/');
  expect(page.url()).not.toContain(TOKEN);

  const storage = await readAuthStorage(page);
  expect(storage.sessionToken, 'the rejected token is not left in sessionStorage').toBeNull();
  expect(storage.durableToken, 'the rejected token is not left in localStorage').toBeNull();

  // A reload must not reconnect from the query string or storage.
  const connectionsBeforeReload = state.connections;
  const attemptsBeforeReload = state.authTokens.length;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByText(/Enter your auth token and click Connect/)).toBeVisible();
  await expect(page.getByTestId('shell')).toHaveCount(0);
  expect(state.connections, 'a reload must not open a transport').toBe(connectionsBeforeReload);
  expect(state.authTokens.length, 'a reload must not retry the rejected token').toBe(
    attemptsBeforeReload,
  );
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);
  const reloaded = await readAuthStorage(page);
  expect(reloaded.sessionToken).toBeNull();
  expect(reloaded.durableToken).toBeNull();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the rejected URL token produced one refused server.auth attempt; ' +
      'the URL kept server_url and keep=1 with no token; both storage scopes were empty; a reload ' +
      'stayed on the disconnected Login surface with no new WebSocket connection or auth attempt',
  });
});
