'use strict';
// #2969 SC-01: a valid URL bootstrap token authenticates the browser and the
// resulting URL no longer contains `token`; the route, hash and unrelated
// query parameters are unchanged.
//
// Chromium + the production Web build. The Server is a verifier-owned
// WebSocket route (`#2822`'s lane), so the disposable token and its accepted
// answer are deterministic and no real credential or network peer is used.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  createAuthServerState,
  installFakeAuthServer,
  readAuthStorage,
  fetchIndexHtml,
} = require('../../../shared/auth-persistence-browser.cjs');

const TOKEN = 'bootstrap-token-2969';
const SERVER = 'ws://bootstrap.test/ws';
const HASH = '#/fixture/workspace?capability=session&sessionMetadata=normal';

test('SC-01: a consumed URL token leaves the route and parameters intact', async ({
  page, context, request,
}) => {
  test.setTimeout(120_000);
  const { runtime, sha } = verifiedRuntime('SC-01');

  const html = await fetchIndexHtml(request, runtime);
  expect(html, 'the runtime serves the production bundle').toMatch(/src="\/assets\/[^"]+\.js"/);
  expect(html, 'the runtime is not the Vite dev entry').not.toContain('/src/main.tsx');

  const state = createAuthServerState();
  state.phase = 'accept';
  await installFakeAuthServer(context, state);

  await page.goto(
    '/?token=' + TOKEN + '&server_url=' + encodeURIComponent(SERVER) + '&keep=1' + HASH,
  );

  // The browser authenticated with the URL token.
  await expect.poll(() => state.authTokens.length).toBeGreaterThan(0);
  expect(state.authTokens[0]).toBe(TOKEN);

  // The deep-linked fixture route is still the rendered route.
  await expect(page.getByTestId('session-details')).toBeVisible();
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');

  // Only `token` was consumed; nothing else moved.
  await expect.poll(() => new URL(page.url()).searchParams.has('token')).toBe(false);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/');
  expect(url.searchParams.get('server_url')).toBe(SERVER);
  expect(url.searchParams.get('keep')).toBe('1');
  expect(url.hash).toBe(HASH);
  expect(page.url()).not.toContain(TOKEN);

  // The consumed token follows the existing session-only storage policy.
  const storage = await readAuthStorage(page);
  expect(storage.sessionToken).toBe(TOKEN);
  expect(storage.durableToken).toBeNull();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': URL token authenticated once through the Case-owned WebSocket ' +
      'route; afterwards the URL retained server_url and keep=1 and the exact ' + HASH + ' hash, ' +
      'with no token; storage held the token only in sessionStorage',
  });
});
