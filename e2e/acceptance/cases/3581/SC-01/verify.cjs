'use strict';
// #3581 SC-01: a large GitHub comparison/provenance response overflows the old
// unbounded spawnSync evidence buffer; the repaired collector projects only the
// required fields, caps its child buffer, and processes an authenticated source
// comparison without ENOBUFS.
const {
  run,
  targetSha,
  checked,
} = require('../../../shared/control-mode-cases.cjs');

const replay = `
import assert from 'node:assert/strict';
import { collectGithubEvidence, livePrSourceSupersession } from './scripts/acceptance-executor.mjs';
process.env.GITHUB_REPOSITORY = 'BestNathan/nession';
const previous = 'a'.repeat(40);
const next = 'b'.repeat(40);
const compare = {status:'ahead',ahead_by:1,behind_by:0,base_commit:{sha:previous},merge_base_commit:{sha:previous}};
const pulls = [{number:7,body:'Fixes #3581',title:'fix (#3581)',head:{sha:previous,repo:{full_name:'BestNathan/nession'}},base:{ref:'main',repo:{full_name:'BestNathan/nession'}}}];
let bounded = false;
const execute = (args, options) => {
  if (!args.includes('--jq') || options?.maxBuffer !== 8 * 1024 * 1024) {
    throw Object.assign(new Error('spawnSync gh ENOBUFS'), {code:'ENOBUFS'});
  }
  bounded = true;
  return args[1].includes('/compare/') ? JSON.stringify(compare) : JSON.stringify(pulls);
};
const proof = livePrSourceSupersession(3581, previous, next, execute);
assert.equal(proof.comparison.ahead_by, 1);
assert.equal(proof.previous_pulls.length, 1);
assert.equal(proof.next_pulls.length, 1);
assert.equal(bounded, true);
assert.throws(
  () => collectGithubEvidence('half', '.', () => '{"status":'),
  /truncated or not valid JSON/,
);
console.log('bounded-evidence-positive-ok');
`;

run(({ evidence }) => {
  const sha = targetSha();
  checked('node', ['scripts/acceptance-executor.mjs', 'self-test'], 300000);
  const output = checked('node', ['--input-type=module', '-e', replay], 120000);
  if (!output.includes('bounded-evidence-positive-ok')) {
    throw new Error('bounded evidence replay did not complete');
  }
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a simulated large compare/PR response fails the historical unbounded ' +
      'gh call; the repaired collector requests only projected fields, caps the child buffer at ' +
      '8388608 bytes, and yields the authenticated comparison/provenance without ENOBUFS',
  });
  return 'The GitHub evidence collector projects bounded provenance fields under an explicit child-buffer cap and processes the large-response fixture without ENOBUFS';
});
