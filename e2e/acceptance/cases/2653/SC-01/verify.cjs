'use strict';
// #2653 SC-01: unauthenticated/incomplete P2P TCP connections are admitted only
// up to a finite Agent-owned application bound; excess silent peers are closed
// without accumulating handshake tasks, and the bound is returned on shutdown.
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

  // One admission slot and eight silent peers with a deadline too long to fire:
  // exactly one peer may stay open, the other seven are closed by the listener,
  // and shutdown aborts the survivor and returns the slot.
  const output = cargoTests(['--lib', 'incomplete_handshakes_are_capped'], 900000);
  assertRan(output, [
    'incomplete_handshakes_are_capped_and_returned_on_shutdown',
  ]);

  // Source checks read only the production half of the file; the test module
  // shares these identifiers and would otherwise satisfy them.
  const source = fs.readFileSync(SOURCE, 'utf8');
  const production = source.slice(0, source.indexOf('#[cfg(test)]'));
  if (production.length === source.length) {
    throw new Error('could not separate production code from the test module');
  }
  const admittedAt = production.indexOf('try_acquire_owned()');
  const spawnedAt = production.indexOf('handshakes.spawn(');
  if (admittedAt < 0) throw new Error('the accept loop must take an admission slot');
  if (spawnedAt < 0 || admittedAt > spawnedAt) {
    throw new Error('admission must be decided before any handshake task is spawned');
  }
  if (!production.includes('handshake_policy') || !production.includes('Semaphore::MAX_PERMITS')) {
    throw new Error(
      'the admission budget must come from the policy and be clamped to a valid semaphore bound',
    );
  }
  const releasedAt = production.indexOf('drop(slot);');
  const servedAt = production.indexOf('tokio::spawn(Self::serve_connection(');
  if (releasedAt < 0 || servedAt < 0 || releasedAt > servedAt) {
    throw new Error(
      'the pre-authentication slot must be returned before the authenticated message loop starts',
    );
  }
  if (!production.includes('handshakes.abort_all()')) {
    throw new Error('shutdown must abort in-flight handshakes so their slots return');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': one-slot policy with eight silent TCP peers leaves exactly one ' +
      'open; the listener closes the rest without spawning a handshake task, and shutdown ' +
      'aborts the pending handshake, returns its slot, and closes the admission budget',
  });
  return (
    'Incomplete unauthenticated P2P connections are capped by an Agent-owned admission ' +
    'bound, and the bound is released on shutdown'
  );
});
