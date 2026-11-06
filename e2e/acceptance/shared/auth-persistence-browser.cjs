'use strict';
// Shared browser driver for #2822's auth-persistence transition Cases.
//
// The Case must observe the real production Web build and the real Login UI,
// but a real Server would reject the deliberately fake tokens. The WebSocket
// is therefore replaced by an in-browser route the verifier owns: no
// production credential, no network peer, and every `server.auth` attempt is
// captured for assertion.
//
// The reproduction's prior state (`localStorage.token=A` from a remembered
// login) is created through the production UI rather than seeded with
// addInitScript: a stored token is exactly what arms auto-restore on load, so
// a pre-seeded token lands on the restore surface where the Login page's
// Disconnect control does not exist. A remembered Connect followed by a
// mid-handshake Disconnect leaves the same durable state (#354) on a reachable
// Login surface.

const DURABLE_TOKEN_A = 'durable-token-a-2822';
const SESSION_TOKEN_B = 'session-token-b-2822';

const { expect } = require('@playwright/test');

const AUTH_WIRE = 'server.auth';

/** The fake transport's state: who may authenticate and what was attempted. */
function createAuthServerState() {
  return {
    // 'hold' keeps a handshake pending so the Login page (and its manual
    // Disconnect) stays reachable while connecting; 'accept' completes it.
    phase: 'hold',
    connections: 0,
    authTokens: [],
  };
}

/**
 * Route every browser WebSocket to a verifier-owned endpoint. Only the
 * `server.auth` handshake is answered; every other request is deliberately
 * left unanswered, because these Cases assert the login/storage transition,
 * not the post-login workspace traffic.
 */
async function installFakeAuthServer(context, state) {
  await context.routeWebSocket(/\/ws(?:[?#].*)?$/, (route) => {
    state.connections += 1;
    route.onMessage((raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || message.msg_type !== AUTH_WIRE) return;
      const token = typeof message.payload?.auth_token === 'string'
        ? message.payload.auth_token
        : null;
      state.authTokens.push(token);
      if (state.phase !== 'accept' && state.phase !== 'reject') return;
      route.send(JSON.stringify({
        msg_type: AUTH_WIRE,
        id: message.id,
        timestamp: Date.now(),
        payload: state.phase === 'accept'
          ? { status: 'success', message: '' }
          : { status: 'failed', message: 'rejected by the Case transport' },
      }));
    });
  });
}

/**
 * Create the remembered prior state through the production UI: connect once
 * with Remember me ON, then Disconnect while the handshake is still pending.
 * `#354` says Disconnect is not a logout, so both copies (including the
 * durable `localStorage.token`) survive on the Login surface.
 */
async function connectRememberedThenDisconnect(page, state, token) {
  const remember = page.getByRole('checkbox', { name: /remember me/i });
  if (!(await remember.isChecked())) await remember.click();
  await page.getByLabel('Auth Token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => state.authTokens).toContain(token);

  // A manual connect starts from `wasEverAuthed=false`, so the Login surface
  // (with its Disconnect control) stays mounted while the handshake is held.
  const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
  await expect(disconnect).toBeEnabled();
  await disconnect.click();
  return readAuthStorage(page);
}

/** Both storage scopes plus the persistence preference, read from the page. */
async function readAuthStorage(page) {
  return page.evaluate(() => ({
    sessionToken: sessionStorage.getItem('token'),
    durableToken: localStorage.getItem('token'),
    rememberPreference: localStorage.getItem('remember'),
  }));
}

/** The runtime serves the built production bundle, not the Vite dev entry. */
async function fetchIndexHtml(request, runtime) {
  const response = await request.get(runtime.base_url + '/');
  if (!response.ok()) throw new Error('production Web build is not being served');
  return response.text();
}

module.exports = {
  DURABLE_TOKEN_A,
  SESSION_TOKEN_B,
  createAuthServerState,
  installFakeAuthServer,
  connectRememberedThenDisconnect,
  readAuthStorage,
  fetchIndexHtml,
};
