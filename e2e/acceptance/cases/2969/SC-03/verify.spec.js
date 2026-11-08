'use strict';
// #2969 SC-03: the URL bootstrap cleanup does not change the accepted manual
// Connect / Remember me / Disconnect storage behavior (#354 / #2822), and a
// Session deep link survives the cleanup.
//
// Chromium + the production Web build; the Server is a verifier-owned
// WebSocket route, so the disposable tokens are deterministic.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  createAuthServerState,
  installFakeAuthServer,
  readAuthStorage,
  fetchIndexHtml,
} = require('../../../shared/auth-persistence-browser.cjs');

const SESSION_TOKEN = 'manual-session-token-2969';
const DURABLE_TOKEN = 'manual-durable-token-2969';
const DEEP_TOKEN = 'bootstrap-deep-link-2969';
const SERVER = 'ws://bootstrap.test/ws';
const HASH = '#/fixture/workspace?capability=session&sessionMetadata=normal';

test('SC-03: manual storage policy and deep links survive the URL cleanup', async ({
  page, context, request,
}) => {
  test.setTimeout(180_000);
  const { runtime, sha } = verifiedRuntime('SC-03');

  const html = await fetchIndexHtml(request, runtime);
  expect(html, 'the runtime serves the production bundle').toMatch(/src="\/assets\/[^"]+\.js"/);
  expect(html, 'the runtime is not the Vite dev entry').not.toContain('/src/main.tsx');

  const state = createAuthServerState();
  await installFakeAuthServer(context, state);

  // ---- Manual Connect, Remember me OFF: session-only, Disconnect retains ----
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  const remember = page.getByRole('checkbox', { name: /remember me/i });
  await expect(remember).not.toBeChecked();

  // Make the off choice explicit: the stored preference is written on toggle,
  // not implied by the clean context's default.
  await remember.click();
  await expect(remember).toBeChecked();
  await remember.click();
  await expect(remember).not.toBeChecked();
  expect((await readAuthStorage(page)).rememberPreference).toBe('false');

  await page.getByLabel('Auth Token').fill(SESSION_TOKEN);
  state.phase = 'hold';
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => state.authTokens.at(-1)).toBe(SESSION_TOKEN);

  const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
  await expect(disconnect).toBeEnabled({ timeout: 15_000 });
  await disconnect.click();

  let storage = await readAuthStorage(page);
  expect(storage.sessionToken, 'Disconnect is not a logout').toBe(SESSION_TOKEN);
  expect(storage.durableToken, 'Remember me off keeps no durable copy').toBeNull();
  expect(storage.rememberPreference).toBe('false');
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);

  // The session-only credential still restores in this tab on reload.
  state.phase = 'accept';
  const attemptsBeforeReload = state.authTokens.length;
  await page.reload();
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => state.authTokens.length).toBeGreaterThan(attemptsBeforeReload);
  expect(state.authTokens.at(-1)).toBe(SESSION_TOKEN);
  storage = await readAuthStorage(page);
  expect(storage.durableToken).toBeNull();

  // ---- Manual Connect, Remember me ON: both scopes, Disconnect retains ----
  // A new tab shares localStorage but starts with an empty sessionStorage,
  // which is how a fresh browser session for this origin behaves.
  const remembered = await context.newPage();
  try {
    await remembered.goto('/');
    await expect(remembered.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    const rememberOn = remembered.getByRole('checkbox', { name: /remember me/i });
    await expect(rememberOn).not.toBeChecked();
    await rememberOn.click();
    await expect(rememberOn).toBeChecked();

    await remembered.getByLabel('Auth Token').fill(DURABLE_TOKEN);
    state.phase = 'hold';
    await remembered.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(() => state.authTokens.at(-1)).toBe(DURABLE_TOKEN);

    const rememberedDisconnect = remembered.getByRole('button', {
      name: 'Disconnect',
      exact: true,
    });
    await expect(rememberedDisconnect).toBeEnabled({ timeout: 15_000 });
    await rememberedDisconnect.click();

    storage = await readAuthStorage(remembered);
    expect(storage.sessionToken).toBe(DURABLE_TOKEN);
    expect(storage.durableToken, 'Remember me on synchronizes the durable copy').toBe(DURABLE_TOKEN);
    expect(storage.rememberPreference).toBe('true');

    // Reload auto-connects with the remembered token (#354).
    state.phase = 'accept';
    const rememberedAttempts = state.authTokens.length;
    await remembered.reload();
    await expect(remembered.getByTestId('shell')).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => state.authTokens.length).toBeGreaterThan(rememberedAttempts);
    expect(state.authTokens.at(-1)).toBe(DURABLE_TOKEN);
    expect((await readAuthStorage(remembered)).durableToken).toBe(DURABLE_TOKEN);
  } finally {
    await remembered.close();
  }

  // ---- A bootstrap deep link keeps its route while consuming the token ----
  state.phase = 'accept';
  // The remembered page above left both a durable token and the on preference
  // in this shared context. Make the documented remember-off policy explicit
  // for this tab, so the bootstrap token's storage scope is observable.
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.setItem('remember', 'false');
  });
  await page.goto(
    '/?token=' + DEEP_TOKEN + '&server_url=' + encodeURIComponent(SERVER) + '&keep=1' + HASH,
  );
  await expect(page.getByTestId('session-details')).toBeVisible();
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');
  await expect.poll(() => state.authTokens).toContain(DEEP_TOKEN);

  await expect.poll(() => new URL(page.url()).searchParams.has('token')).toBe(false);
  const url = new URL(page.url());
  expect(url.searchParams.get('server_url')).toBe(SERVER);
  expect(url.searchParams.get('keep')).toBe('1');
  expect(url.hash).toBe(HASH);

  // The URL token is imported through the same Remember me policy as a manual
  // session-only login: it is visible in this tab and revokes the durable copy.
  storage = await readAuthStorage(page);
  expect(storage.sessionToken).toBe(DEEP_TOKEN);
  expect(storage.durableToken).toBeNull();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Remember me OFF manual Connect left sessionStorage only and ' +
      'Disconnect kept it, with a same-tab reload auto-connecting; Remember me ON synchronized ' +
      'both scopes, Disconnect kept both, and a reload auto-connected with it; a URL bootstrap ' +
      'deep link kept ' + HASH + ' and keep=1/server_url while consuming the token into ' +
      'sessionStorage only',
  });
});
