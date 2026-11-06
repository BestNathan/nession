'use strict';
// #2822 SC-01: starting from a remembered durable token, connecting with
// Remember me OFF must revoke the durable copy while keeping the new session
// token, and a fresh storage session must not auto-connect with the old one.
// Chromium + the production Web build; the Server is replaced by a
// verifier-owned WebSocket route so the fake tokens are deterministic and no
// real credential is involved.
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

test('SC-01: Remember me off revokes the durable token and a fresh session does not auto-connect', async ({
  page, context, request,
}) => {
  test.setTimeout(120_000);
  const { runtime, sha } = verifiedRuntime('SC-01');

  const html = await fetchIndexHtml(request, runtime);
  expect(html, 'the runtime serves the production bundle').toMatch(/src="\/assets\/[^"]+\.js"/);
  expect(html, 'the runtime is not the Vite dev entry').not.toContain('/src/main.tsx');

  const state = createAuthServerState();
  await installFakeAuthServer(context, state);

  // Start with no stored credentials: the Login surface at rest.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByText(/Enter your auth token and click Connect/)).toBeVisible();

  // Prior state, created through the production UI: a remembered login whose
  // mid-handshake Disconnect retains both copies (#354). This is the state the
  // Issue starts from: localStorage.token=A with a reachable Login surface.
  state.phase = 'hold';
  const prior = await connectRememberedThenDisconnect(page, state, DURABLE_TOKEN_A);
  expect(prior.sessionToken).toBe(DURABLE_TOKEN_A);
  expect(prior.durableToken).toBe(DURABLE_TOKEN_A);
  expect(prior.rememberPreference).toBe('true');

  // Opt out of persistence and connect with token B.
  const remember = page.getByRole('checkbox', { name: /remember me/i });
  await expect(remember).toBeChecked();
  await remember.click();
  await expect(remember).not.toBeChecked();
  expect((await readAuthStorage(page)).rememberPreference).toBe('false');

  await page.getByLabel('Auth Token').fill(SESSION_TOKEN_B);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  state.phase = 'accept';
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  // The selected policy is a transition: session-only must revoke the durable
  // copy left behind by the earlier remembered login.
  await expect.poll(async () => (await readAuthStorage(page)).sessionToken).toBe(SESSION_TOKEN_B);
  await expect.poll(async () => (await readAuthStorage(page)).durableToken).toBeNull();
  await expect.poll(() => state.authTokens.at(-1)).toBe(SESSION_TOKEN_B);
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 25_000 });

  // A fresh storage session: a new tab shares localStorage but has its own
  // empty sessionStorage, exactly like a new browser session for this origin.
  const connectionsBeforeFresh = state.connections;
  const authAttemptsBeforeFresh = state.authTokens.length;
  const fresh = await context.newPage();
  try {
    await fresh.goto('/');
    // At rest on the disconnected Login surface: no stored token armed
    // auto-connect. A lingering durable token would instead show the
    // connecting helper and start a handshake with it.
    await expect(fresh.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await expect(fresh.getByText(/Enter your auth token and click Connect/)).toBeVisible();
    await expect(fresh.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();

    const freshStorage = await readAuthStorage(fresh);
    expect(freshStorage.sessionToken, 'a fresh tab has no session token').toBeNull();
    expect(freshStorage.durableToken, 'the durable token was revoked').toBeNull();
    expect(state.connections, 'a fresh session must not open a transport').toBe(connectionsBeforeFresh);
    expect(state.authTokens.length, 'a fresh session must not attempt auth').toBe(authAttemptsBeforeFresh);
  } finally {
    await fresh.close();
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': remembered Connect + manual Disconnect left localStorage=A sessionStorage=A; ' +
      'Remember me OFF + token B left sessionStorage=B with no localStorage token; a fresh tab on the same ' +
      'origin showed the disconnected Login surface with no new WebSocket connection and no server.auth attempt',
  });
});
