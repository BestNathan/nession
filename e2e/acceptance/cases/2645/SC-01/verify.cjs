'use strict';
// #2645 SC-01: after a P2P credential's lease is spent and the physical socket
// is lost, the runtime reissues through the authenticated Server before the
// next Agent upgrade; an unspent credential and a healthy socket are left
// alone. The runtime tests drive the exact expiry/reconnect boundary.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { readSource, runWebTests } = require('../../../shared/p2p-credential-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const total = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'P2P credential',
  );

  const runtime = readSource('web/src/platform/session-runtime/SessionRuntime.ts');
  const protocol = readSource('crates/nession-protocol/src/contracts/session/v1.rs');
  const server = readSource(
    'crates/nession-server/src/server/handler/server_session_attach_v1.rs',
  );
  const required = [
    [runtime, 'requestFreshAttach', 'Server-backed renewal resolver injection'],
    [runtime, 'resolveP2PUrl', 'pre-dial credential renewal owner'],
    [runtime, 'P2P_CREDENTIAL_RENEW_MARGIN_MS', 'stated-deadline margin'],
    [runtime, 'p2pCredentialNeedsRenewal', 'synchronous renewal decision'],
    [protocol, 'connection_token_expires_at', 'attach-reply deadline field'],
    [server, 'connection_token_expires_at', 'issuer states the deadline'],
  ];
  for (const [source, text, label] of required) {
    if (!source.includes(text)) {
      throw new Error('missing ' + label + ' (' + text + ')');
    }
  }

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + total +
        ' SessionRuntime renewal tests passed (expired lease renews before rebuild; unspent lease is reused)',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': attach reply states connection_token_expires_at; the runtime renews through requestFreshAttach before a spent-lease dial and leaves a healthy transport untouched',
    },
  );
  return 'A spent P2P credential is reissued before the lost socket is rebuilt, while an unspent credential and a healthy socket are untouched';
});
