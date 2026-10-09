'use strict';
// Observe a real isolated runtime and prove Regression and Acceptance import the
// same owner. Source-only strings cannot substitute for live Agent registration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runtimeFromEnv, verifyOnlineAgent } = require('../../../../../acceptance/shared/protocol-online-agent.js');
const repo = path.resolve(__dirname, '../../../../..');
async function main() {
  const runtime = runtimeFromEnv();
  const target = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target, /^[a-f0-9]{40}$/);
  assert.equal(runtime.target_sha, target, 'shared Runtime target mismatch');
  assert.equal(runtime.profile, 'full-stack-local');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repo,encoding:'utf8'}).trim(), target);
  const regression = fs.readFileSync(path.join(repo,'e2e/globalSetup.ts'),'utf8');
  const evaluator = fs.readFileSync(path.join(repo,'e2e/acceptance/evaluator/run-case.mjs'),'utf8');
  const scenario = fs.readFileSync(path.join(repo,'e2e/scenarios/terminal-attach-resume/reproduce.cjs'),'utf8');
  assert.match(regression, /require\(['"]\.\/runner\/runtime\/full-stack\.js['"]\)/);
  assert.match(evaluator, /require\(['"]\.\.\/\.\.\/runner\/runtime\/full-stack\.js['"]\)/);
  assert.match(scenario, /require\(['"]\.\.\/\.\.\/runner\/runtime\/full-stack\.js['"]\)/);
  assert.equal(fs.existsSync(path.join(repo,'acceptance/runtime/full-stack.js')),false);
  assert.equal(fs.existsSync(path.join(repo,'acceptance/run-case.mjs')),false);
  const protocol = await verifyOnlineAgent(runtime);
  assert.equal(protocol.status, 'pass');
  const response = await fetch(runtime.base_url + '/', {signal:AbortSignal.timeout(8000)});
  assert.equal(response.status, 200, 'real isolated Web readiness');
  console.log(JSON.stringify({status:'pass',summary:'Regression, Acceptance and Scenario share the same full-stack owner; real Server, Agent and Web responded at pinned SHA.',evidence:[
    {type:'runtime',value:'target_sha='+target+' profile='+runtime.profile+' Web HTTP='+response.status},
    {type:'protocol',value:'real server.auth and server.agent.list observed e2e-test-node'},
    {type:'ownership',value:'globalSetup, Case evaluator and Scenario import e2e/runner/runtime/full-stack.js; no legacy runner files'},
  ]}));
}
main().catch(e=>{const msg=e instanceof Error?e.message:String(e);console.error(msg);console.log(JSON.stringify({status:'fail',summary:msg,evidence:[{type:'runtime',value:'shared runtime ownership or live probe failed'}]}));process.exitCode=1;});
