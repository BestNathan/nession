'use strict';
// #3581 SC-02: oversized, truncated, stale-SHA, mismatched-repository and
// incomplete-pagination evidence fails closed; no Issue projection or Pass is
// fabricated from partial provenance.
const {
  run,
  targetSha,
  checked,
} = require('../../../shared/control-mode-cases.cjs');

const replay = `
import assert from 'node:assert/strict';
import { livePrSourceSupersession, verifiedPrSourceSupersession } from './scripts/acceptance-executor.mjs';
process.env.GITHUB_REPOSITORY = 'BestNathan/nession';
const previous = 'a'.repeat(40);
const next = 'b'.repeat(40);
const compare = {status:'ahead',ahead_by:1,behind_by:0,base_commit:{sha:previous},merge_base_commit:{sha:previous}};
const enobufs = () => { throw Object.assign(new Error('spawnSync gh ENOBUFS'), {code:'ENOBUFS'}); };
assert.throws(() => livePrSourceSupersession(3581, previous, next, enobufs),
  /exceeded the 8388608-byte bound/);
assert.throws(() => livePrSourceSupersession(3581, previous, next, () => '{"status":'),
  /truncated or not valid JSON/);
const noCompare = (args) => args[1].includes('/compare/')
  ? JSON.stringify({status:'ahead'}) : '[]';
assert.throws(() => livePrSourceSupersession(3581, previous, next, noCompare),
  /incomplete: comparison metadata/);
const pulls = Array.from({length:100}, (_, index) => ({
  number:index + 1, body:'Fixes #3581', title:'fix',
  head:{sha:previous, repo:{full_name:'BestNathan/nession'}},
  base:{ref:'main', repo:{full_name:'BestNathan/nession'}},
}));
const fullPage = (args) => args[1].includes('/compare/')
  ? JSON.stringify(compare) : JSON.stringify(pulls);
assert.throws(() => livePrSourceSupersession(3581, previous, next, fullPage),
  /pagination is incomplete/);
const proof = {issue:3581, previous, next, repo:'BestNathan/nession',
  comparison:compare, previous_pulls:[], next_pulls:[]};
assert.equal(verifiedPrSourceSupersession(3581, previous, next,
  {...proof, previous:'c'.repeat(40)}), false);
assert.equal(verifiedPrSourceSupersession(3581, previous, next,
  {...proof, next_pulls:[{...pulls[0], head:{sha:next, repo:{full_name:'Other/project'}}}]}), false);
console.log('bounded-evidence-negative-ok');
`;

run(({ evidence }) => {
  const sha = targetSha();
  checked('node', ['scripts/acceptance-executor.mjs', 'self-test'], 300000);
  const output = checked('node', ['--input-type=module', '-e', replay], 120000);
  if (!output.includes('bounded-evidence-negative-ok')) {
    throw new Error('fail-closed replay did not complete');
  }
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': ENOBUFS beyond the 8388608-byte cap, invalid/truncated JSON, a ' +
      'missing comparison projection, a 100-entry PR page, a stale previous head and a ' +
      'mismatched repository are each refused as incomplete provenance; no projection or Pass is produced',
  });
  return 'Oversized, truncated, stale, mismatched and incomplete GitHub evidence fails closed without fabricating acceptance evidence';
});
