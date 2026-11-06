'use strict';
// #2822 SC-02: from the same remembered prior state, connecting with Remember
// me ON must synchronize the selected token into both storage scopes; a manual
// Disconnect still retains the credentials and a reload still auto-connects
// with the remembered token (#354). Chromium + the production Web build; the
// Server is replaced by a verifier-owned WebSocket route so the fake tokens
// are deterministic and no real credential is involved.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  DURABLE_TOKEN_A,
  SESSION_TOKEN_B,
  createAuthServerState,
  installFakeAuthServer,
  connectRememberedThenDisconnect,
  readAuthStorage,
  fetchIndexHtml,
} = require('../../../shared/auth-persistence-browser.cjs');

test('SC-02: Remember me on synchronizes both scopes; Disconnect retains them and reload auto-connects', async ({
  page, context, request,
}) => {
  test.setTimeout(120_000);
  const { runtime, sha } = verifiedRuntime('SC-02');

  const html = await fetchIndexHtml(request, runtime);
  expect(html, 'the runtime serves the production bundle').toMatch(/src="\/assets\/[^"]+\.js"/);
  expect(html, 'the runtime is not the Vite dev entry').not.toContain('/src/main.tsx');

  const state = createAuthServerState();
  await installFakeAuthServer(context, state);

  // Start with no stored credentials: the Login surface at rest.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByText(/Enter your auth token and click Connect/)).toBeVisible();

  // Prior state through the production UI: a remembered login retained across
  // the mid-handshake Disconnect (#354), i.e. localStorage.token=A.
  state.phase = 'hold';
  const prior = await connectRememberedThenDisconnect(page, state, DURABLE_TOKEN_A);
  expect(prior.sessionToken).toBe(DURABLE_TOKEN_A);
  expect(prior.durableToken).toBe(DURABLE_TOKEN_A);

  // Remember me stays ON: the selected token must exist in both scopes.
  const remember = page.getByRole('checkbox', { name: /remember me/i });
  await expect(remember).toBeChecked();
  await page.getByLabel('Auth Token').fill(SESSION_TOKEN_B);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  // 'hold' keeps the handshake pending so the Login page (and its manual
  // Disconnect) stays reachable while connecting.
  state.phase = 'hold';
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect.poll(async () => (await readAuthStorage(page)).sessionToken).toBe(SESSION_TOKEN_B);
  await expect.poll(async () => (await readAuthStorage(page)).durableToken).toBe(SESSION_TOKEN_B);
  await expect.poll(() => state.authTokens.at(-1)).toBe(SESSION_TOKEN_B);
  expect((await readAuthStorage(page)).rememberPreference).toBe('true');

  // Manual Disconnect mid-connect retains both copies and the preference.
  const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
  await expect(disconnect).toBeEnabled({ timeout: 15_000 });
  await disconnect.click();
  let storage = await readAuthStorage(page);
  expect(storage.sessionToken).toBe(SESSION_TOKEN_B);
  expect(storage.durableToken).toBe(SESSION_TOKEN_B);
  expect(storage.rememberPreference).toBe('true');

  // Reload auto-connects with the remembered token (#354) and completes the
  // handshake that carries it.
  const attemptsBeforeReload = state.authTokens.length;
  state.phase = 'accept';
  await page.reload();
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => state.authTokens.length).toBeGreaterThan(attemptsBeforeReload);
  expect(state.authTokens.at(-1)).toBe(SESSION_TOKEN_B);

  storage = await readAuthStorage(page);
  expect(storage.durableToken).toBe(SESSION_TOKEN_B);
  expect(storage.rememberPreference).toBe('true');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': remembered Connect + manual Disconnect left localStorage=A sessionStorage=A; ' +
      'Remember me ON + token B synchronized sessionStorage and localStorage; a second manual Disconnect kept ' +
      'both copies; reload auto-connected and authenticated with the remembered token B',
  });
});
