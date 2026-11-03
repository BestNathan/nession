'use strict';
// #2653 SC-02: plain WebSocket and configured TLS handshakes enforce a finite
// deadline for idle/partial upgrades and release their admission capacity on
// all completion/failure/refusal/timeout/shutdown paths.
const fs = require('node:fs');
const path = require('node:path');
const {
  run,
  cargoTests,
  assertRan,
  targetSha,
} = require('../../../shared/control-mode-cases.cjs');

const SOURCE = path.resolve(
  __dirname,
  '../../../../../crates/nession-agent/src/server/websocket.rs',
);

run(({ evidence }) => {
  const sha = targetSha();

  // A partial HTTP request, a partial TLS record, a silent TLS peer, a refused
  // credential, and shutdown: each path must close or return its slot rather
  // than hold it until the process ends.
  const output = cargoTests(['--lib', 'handshake'], 900000);
  assertRan(output, [
    'plain_incomplete_handshakes_time_out_and_capacity_recovers',
    'tls_incomplete_handshakes_time_out_and_capacity_recovers',
    'a_refused_upgrade_releases_its_handshake_slot',
    'incomplete_handshakes_are_capped_and_returned_on_shutdown',
  ]);

  // Source checks read only the production half of the file; the test module
  // shares these identifiers and would otherwise satisfy them.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const production = source.slice(0, source.indexOf('#[cfg(test)]'));
  if (production.length === source.length) {
    throw new Error('could not separate production code from the test module');
  }
  if (!production.includes('tokio::time::timeout(deadline, upgrade)')) {
    throw new Error('one deadline must cover the TLS handshake and the WebSocket upgrade');
  }
  // `rustfmt` splits `acceptor.accept(stream)` across lines, so match the
  // method call itself rather than one formatting of it.
  const tlsAt = production.indexOf('.accept(stream)');
  const upgradeAt = production.indexOf('accept_hdr_async(');
  const deadlineAt = production.indexOf('tokio::time::timeout(deadline, upgrade)');
  if (tlsAt < 0 || upgradeAt < 0 || deadlineAt < 0 || tlsAt > deadlineAt || upgradeAt > deadlineAt) {
    throw new Error(
      'both the TLS handshake and the HTTP upgrade must run inside the handshake deadline',
    );
  }
  if (!production.includes('drop(slot);')) {
    throw new Error('a completed handshake must return its pre-authentication slot');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a 500 ms deadline closes a partial HTTP upgrade, a partial TLS ' +
      'record and a silent TLS peer; a credential refusal returns its slot without waiting ' +
      'for a 60 s deadline; a live authenticated plain/TLS connection leaves the slot free; ' +
      'shutdown aborts a pending handshake and closes the budget',
  });
  return (
    'Plain and TLS handshakes enforce one finite deadline for idle/partial upgrades and ' +
    'release admission capacity on success, refusal, timeout and shutdown'
  );
});
