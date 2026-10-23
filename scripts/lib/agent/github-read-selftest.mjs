#!/usr/bin/env node
// Trusted read-only GitHub helper: token/endpoint validation, one HTTPS read
// and fail-closed HTTP errors. No real network is used.
import assert from 'node:assert/strict';
import { githubFetcher } from './github-read.mjs';

assert.throws(()=>githubFetcher('short'),/trusted read-only token required/);
assert.throws(()=>githubFetcher('x'.repeat(8),{repository:'owner'}),/invalid GitHub repository/);
const fetcher=githubFetcher('t'.repeat(8),{repository:'BestNathan/nession'});
for(const endpoint of ['', '/pulls/1', '../pulls/1', 'x'.repeat(2049)])
  await assert.rejects(()=>fetcher(endpoint),/invalid GitHub read endpoint/);

const original=globalThis.fetch;
const calls=[];
try {
  globalThis.fetch=async (url,options)=>{
    calls.push([url,options]);
    return {ok:true,status:200,json:async()=>({number:2176})};
  };
  assert.deepEqual(await fetcher('pulls/2176'),{number:2176});
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'https://api.github.com/repos/BestNathan/nession/pulls/2176');
  assert.equal(calls[0][1].headers.Authorization,'Bearer '+'t'.repeat(8));
  globalThis.fetch=async ()=>({ok:false,status:403,json:async()=>({})});
  await assert.rejects(()=>fetcher('pulls/2176'),/GitHub read failed: pulls\/2176 \(403\)/);
} finally { globalThis.fetch=original; }
console.log('GitHub read helper: token/endpoint negatives, exact HTTPS request and HTTP failure passed');
