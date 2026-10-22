#!/usr/bin/env node
// #1850: execute the REAL jq policy embedded in the privileged workflow,
// not a separate permissive JS predicate that might drift from production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const yaml=fs.readFileSync('.github/workflows/acceptance-postrun-waker.yml','utf8');
const match=yaml.match(/--argjson attempt "\$SOURCE_ATTEMPT" '\r?\n([\s\S]*?)' "\$RUNNER_TEMP\/source\.json"/);
assert.ok(match,'could not extract exact trusted source jq policy');
const policy=match[1];
const repo='BestNathan/nession',sha='a'.repeat(40);
const eventJob=yaml.match(/jobs:\r?\n  select:\r?\n    if: >-\r?\n([\s\S]*?)\r?\n    runs-on: /);
assert.ok(eventJob,'select-job trigger must be explicit');
const selectGuard=eventJob[1];
for(const guard of [
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  "github.event.workflow_run.conclusion == 'success'",
])assert.ok(selectGuard.includes(guard),'missing early skip guard: '+guard);
assert.match(yaml,/git cat-file -e "\$SOURCE_SHA\^\{commit\}"/);
assert.match(yaml,/git merge-base --is-ancestor "\$SOURCE_SHA" HEAD/);
assert.match(yaml,/node scripts\/select-merged-agents\.mjs select/);
assert.match(yaml,/uses: BestNathan\/nession\/\.github\/workflows\/agent-sc-acceptance\.yml@main/);
assert.match(yaml,/issue_number: \$\{\{ matrix\.issue_number \}\}/);
assert.match(yaml,/target_ref: \$\{\{ needs\.select\.outputs\.target_sha \}\}/);
assert.match(yaml,/types: \[completed\]/);
assert.match(yaml,/workflow_run:\s*\n(?:[^\n]*\n)*?\s+branches: \[main\]/,
  'subscribe only to main upstream runs, not PR completion events');
assert.match(yaml,/workflows: \["Acceptance \/ Orchestrator", "CI \/ Run Store Fixture Evidence", "E2E \/ Tests", "Deploy \/ Public Pages"\]/);
assert.match(yaml,/ref: main/);
assert.match(yaml,/persist-credentials: false/);

const sources=[
  ['Acceptance / Orchestrator','.github/workflows/acceptance-orchestrator.yml'],
  ['CI / Run Store Fixture Evidence','.github/workflows/ci-run-store-fixture-evidence.yml'],
  ['E2E / Tests','.github/workflows/e2e-tests.yml'],
  ['Deploy / Public Pages','.github/workflows/deploy-pages.yml'],
];
function source(name,route) {
  return {id:123456,run_attempt:2,name,path:route,
    event:'push',head_branch:'main',head_sha:sha,
    status:'completed',conclusion:'success',
    repository:{full_name:repo},head_repository:{full_name:repo}};
}
function evaluate(run,{id=123456,attempt=2,expectedSha=sha}={}) {
  const r=spawnSync('jq',['-e','--arg','repo',repo,'--arg','sha',expectedSha,
    '--argjson','id',String(id),'--argjson','attempt',String(attempt),policy],
    {input:JSON.stringify(run),encoding:'utf8'});
  assert.equal(r.error,undefined,'jq runner unavailable');
  return r.status===0&&r.stdout.trim()==='true';
}
let passes=0,rejections=0;
for(const [name,route] of sources) {
  const good=source(name,route);
  assert.equal(evaluate(good),true,'canonical source should authorize: '+name);
  passes++;
  const rejects=[
    [{...good,id:234},{}],
    [{...good,run_attempt:3},{}],
    [good,{id:234}],
    [good,{attempt:3}],
    [{...good,repository:{full_name:'attacker/repo'}},{}],
    [{...good,head_repository:{full_name:'attacker/repo'}},{}],
    [{...good,name:'Other Workflow'},{}],
    [{...good,path:'.github/workflows/other.yml'},{}],
    [{...good,event:'pull_request'},{}],
    [{...good,event:'workflow_dispatch'},{}],
    [{...good,head_branch:'staging'},{}],
    [{...good,head_sha:'b'.repeat(40)},{}],
    [good,{expectedSha:'b'.repeat(40)}],
    [{...good,status:'queued'},{}],
    [{...good,status:'in_progress'},{}],
    [{...good,status:'completed',conclusion:'failure'},{}],
    [{...good,status:'completed',conclusion:'cancelled'},{}],
    [{...good,status:'completed',conclusion:'skipped'},{}],
    [{...good,status:'completed',conclusion:null},{}],
    [{...good,repository:null},{}],
  ];
  for(const [bad,settings] of rejects){
    assert.equal(evaluate(bad,settings),false,
      'must reject untrusted source '+name+': '+JSON.stringify(bad));
    rejections++;
  }
}
// Verify the Git ancestry gate is actually effective rather than only present
// as a string. This uses a disposable repository with no external connectivity.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-postrun-wake-'));
try {
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
  git('init','-q');
  git('config','user.name','Acceptance Selftest');
  git('config','user.email','acceptance@example.invalid');
  fs.writeFileSync(path.join(dir,'a.txt'),'a');
  git('add','a.txt');git('commit','-qm','anchor');
  const first=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(dir,'a.txt'),'b');
  git('add','a.txt');git('commit','-qm','descendant');
  const second=git('rev-parse','HEAD');
  assert.equal(spawnSync('git',['-C',dir,'merge-base','--is-ancestor',first,second]).status,0);
  assert.notEqual(spawnSync('git',['-C',dir,'merge-base','--is-ancestor',second,first]).status,0);
  assert.notEqual(spawnSync('git',['-C',dir,'merge-base','--is-ancestor','f'.repeat(40),second]).status,0);
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('post-run E2E/Pages wake policy: '+passes+' authorized workflow fixtures, '+rejections+
  ' rejected identities, exact SHA ancestry tests and trusted evaluator path passed');
