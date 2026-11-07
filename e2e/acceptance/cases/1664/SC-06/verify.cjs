'use strict';
// #1664 SC-06: the agent-store orphan branch keeps independently addressable
// immutable role/id/issue checkpoints with a versioned head. Replay, parallel
// IDs and stale-writer/CAS tests preserve history, and public Git objects
// contain no plaintext sensitive session content.
const {
  targetSha, runNode, requireSummary, requireSource, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const outbox = runNode('scripts/lib/agent/orchestration/outbox-selftest.mjs');
  requireSummary(outbox,
    'agent Issue outbox: durable CAS, trusted result transitions and replay fixtures passed',
    'durable Outbox CAS');
  const store = runNode('scripts/lib/agent/providers/claude-store-remote-selftest.mjs');
  requireSummary(store,
    'Claude native Store: real remote CAS, ciphertext-only blobs, bounded resume and stale denial passed',
    'native Store ciphertext/CAS');
  const dispatch = runNode('scripts/lib/agent/orchestration/continuation-dispatch-selftest.mjs');
  requireSummary(dispatch,
    'Durable Dispatch: v1 compatible, signed v2 checkpoint, real Git ancestry, rival writer and stale/fork denial passed',
    'continuation dispatch CAS');
  requireSource('scripts/lib/agent/store/checkpoint.mjs', [
    [/export function checkpointPath\(identity, version\)/, 'checkpoint paths are owner-derived'],
    [/export function advanceCheckpointHead\(current, expected, next\)/, 'versioned head advance is Store-owned'],
    [/export function sealCheckpoint/, 'checkpoint payload is sealed before publication'],
  ]);
  requireSource('scripts/lib/agent/store/remote.mjs', [
    [/readCheckpointHeadVersion/, 'versioned head is read from the Store'],
    [/ciphertext/, 'remote restore is ciphertext-based'],
  ]);
  pass(
    'agent-store checkpoints are owner-addressed and versioned; real remote CAS, stale/fork/rival-writer denial and ciphertext-only restore preserve history without plaintext session bytes.',
    [
      { type: 'runtime', value: 'outbox-selftest: durable CAS, trusted transitions and replay fixtures' },
      { type: 'runtime', value: 'claude-store-remote-selftest: real remote CAS, ciphertext-only blobs, bounded resume and stale denial' },
      { type: 'runtime', value: 'continuation-dispatch-selftest: signed v2 checkpoint, real Git ancestry, rival writer and stale/fork denial' },
      { type: 'source', value: 'store/checkpoint.mjs owns checkpointPath, sealCheckpoint and advanceCheckpointHead; remote.mjs reads the versioned head from ciphertext; exact SHA ' + target },
    ],
  );
}

main().catch(fail);
