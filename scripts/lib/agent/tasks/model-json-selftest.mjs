#!/usr/bin/env node
import assert from 'node:assert/strict';
import {parseModelJson, parseModelJsonWithRepair} from './model-json.mjs';

assert.deepEqual(parseModelJson('{"criteria":[]}'), {criteria:[]});
assert.deepEqual(parseModelJson('```json\n{"criteria":[]}\n```'), {criteria:[]});
assert.deepEqual(parseModelJson('preamble {"criteria":[]} trailing'), {criteria:[]});
assert.throws(()=>parseModelJson(''), /empty output/);
assert.throws(()=>parseModelJson('{"criteria":'), /valid JSON/);
assert.deepEqual(await parseModelJsonWithRepair('not json', async prior => {
  assert.equal(prior, 'not json');
  return '{"criteria":[]}';
}), {criteria:[]});
let attempts=0;
await assert.rejects(parseModelJsonWithRepair('not json', async () => {
  attempts+=1;
  return 'still not json';
}), /after one format-repair attempt/);
assert.equal(attempts,1);
let seenLength=0;
await parseModelJsonWithRepair('x'.repeat(20000), async prior => {
  seenLength=prior.length;
  return '{"criteria":[]}';
});
assert.equal(seenLength,16*1024);
console.log('model-json self-test: 8 cases passed');
