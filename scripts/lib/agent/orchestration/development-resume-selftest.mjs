import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {hkdfSync} from 'node:crypto';
import {assertUnprivilegedDeveloperEnvironment,originalCursorWorkspace} from './development-worker.mjs';
import {deriveStoreAesKey} from './development-checkpoint-key.mjs';
import {assertControlledContinuation,assertCurrentDevelopmentCapabilities,CONTROLLED_CONTINUATION,writeNativeBundle,
  developmentHarnessDigest} from './development-resume.mjs';

// The native Agent index is workspace scoped; moved SDK JSONL alone is not
// sufficient. Do not edit the saved store or fabricate a fresh Agent session.
const id='agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6';
const cwd='/tmp/nession-dev-slice-Ab12cD/source';
const row=(value)=>JSON.stringify({op:'put',agent:{agentId:id,workspace:{cwd:value}}})+'\\n';
assert.equal(originalCursorWorkspace(row(cwd),id),cwd);
assert.equal(originalCursorWorkspace(row(cwd)+row(cwd),id),cwd);
for(const bad of [
  JSON.stringify({agentId:'agent-other-1234',workspace:{cwd}})+'\\n',
  row('/tmp/nession-dev-slice-Ab12cD/../source'),
  row('/workspace'),
  row('/tmp/nession-dev-slice-Ab12cD/source/extra'),
  row(cwd)+row('/tmp/nession-dev-slice-Hg34Jk/source'),
  JSON.stringify({agentId:id,workspace:{cwd,workingDirectory:'/tmp/nession-dev-slice-Hg34Jk/source'}})+'\\n',
  'not-json\\n',
])assert.throws(()=>originalCursorWorkspace(bad,id),/bounded Developer:/);
assert.doesNotThrow(()=>assertUnprivilegedDeveloperEnvironment({CURSOR_API_KEY:'provider-key'}));
for(const key of ['STORE_APP_TOKEN','STORE_WRITER_PRIVATE_KEY','ACTIONS_DISPATCH_TOKEN',
  'GITHUB_TOKEN','GH_TOKEN','AGENT_STORE_CONTROLLER_REMOTE','CURSOR_RESUME_PRIVATE_KEY_B64'])
  assert.throws(()=>assertUnprivilegedDeveloperEnvironment({[key]:'must-not-reach-model'}),/privileged credential leaked/);
const source='220266b9233ec97b1beacbc54e5cc7f82d3cece2';
const admission={authorized:true,issue:1997,role:'developer',task:'implement',provider:'cursor',
  environment:'agent-dev-cursor-01',agent_id:'dev-cursor-01',action_id:CONTROLLED_CONTINUATION,input_sha:source,
  resume_from:{checkpoint_version:1,ordinal:1,
    parent_action_id:'85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656',
    checkpoint_commit_sha:'d812e3655c0ad6337b1003aa0c1794c12335adb0',
    ciphertext_sha256:'a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107'}};
assert.equal(assertControlledContinuation(admission).checkpoint_version,1);
for(const bad of [
  {authorized:false},{issue:1998},{role:'reviewer'},{task:'repair'},
  {action_id:'0'.repeat(64)},{input_sha:'a'.repeat(40)},
  {resume_from:{...admission.resume_from,checkpoint_version:2}},
  {resume_from:{...admission.resume_from,ordinal:2}},
  {resume_from:{...admission.resume_from,checkpoint_commit_sha:'a'.repeat(40)}},
  {resume_from:{...admission.resume_from,ciphertext_sha256:'a'.repeat(64)}},
  {resume_from:{...admission.resume_from,parent_action_id:'a'.repeat(64)}},
  {resume_from:{...admission.resume_from,writer_token:'forbidden'}},
])assert.throws(()=>assertControlledContinuation({...admission,...bad}),/committed controlled/);
assert.equal(developmentHarnessDigest(source,'1.0.37',{id:'composer-2.5',fast:true}),
  'ba54d9fb8b8ab9ec6ca2ac17727b02db21176437a2258123b753977fd32bbf68');
assert.notEqual(developmentHarnessDigest(source,'1.0.38',{id:'composer-2.5',fast:true}),
  developmentHarnessDigest(source,'1.0.37',{id:'composer-2.5',fast:true}));
const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
assert.doesNotThrow(()=>assertCurrentDevelopmentCapabilities(admission,registry));
for(const permission of ['repo.read','repo.search','repo.edit','github.issue.read']){
  const revoked=structuredClone(registry);
  revoked.roles.developer.capabilities.tools=revoked.roles.developer.capabilities.tools.filter(t=>t!==permission);
  assert.throws(()=>assertCurrentDevelopmentCapabilities(admission,revoked),/revoked/);
}
assert.throws(()=>assertCurrentDevelopmentCapabilities({...admission,environment:'cursor'},registry),/environment/);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'developer-native-bundle-'));
try{
  const files=Object.fromEntries(['agents.ndjson','checkpoints.ndjson','runs.ndjson','run_events.ndjson']
    .map(name=>[name,Buffer.from('{"native":"'+name+'"}\n').toString('base64')]));
  const bundle={schema_version:1,kind:'cursor-native-files',files};
  const bytes=Buffer.from(JSON.stringify(bundle)),dir=path.join(root,'native');
  writeNativeBundle(bytes,dir);
  for(const [name,body] of Object.entries(files))assert.equal(fs.readFileSync(path.join(dir,name)).toString('base64'),body);
  assert.throws(()=>writeNativeBundle(bytes,dir),/must be new/);
  for(const bad of [
    {...bundle,files:{...files,'../escape':'eA=='}},
    {...bundle,files:{...files,'checkpoints.ndjson':''}},
    {...bundle,files:{...files,'runs.ndjson':'eA=='}},
    {...bundle,prompt:'plaintext transcript replacement'},
    {...bundle,kind:'custom-transcript'},
  ])assert.throws(()=>writeNativeBundle(Buffer.from(JSON.stringify(bad)),path.join(root,'bad')));
  const keySeed='-----BEGIN PRIVATE KEY-----\n'+'z'.repeat(256)+'\n-----END PRIVATE KEY-----';
  const key=deriveStoreAesKey(keySeed);
  assert.deepEqual(key,Buffer.from(hkdfSync('sha256',Buffer.from(keySeed),
    Buffer.from('BestNathan/nession'),Buffer.from('nession-agent-native-checkpoint-store-v1'),32)),
    'key extraction must preserve already committed ciphertext compatibility');
  key.fill(0);
}finally{fs.rmSync(root,{recursive:true,force:true});}
const workflow=fs.readFileSync('.github/workflows/agent-develop.yml','utf8');
const [beforeDeveloper,developer]=workflow.split('\n  developer:\n');
assert.ok(beforeDeveloper.includes('STORE_WRITER_PRIVATE_KEY:'));
assert.ok(!developer.includes('STORE_WRITER_PRIVATE_KEY:'));
assert.ok(beforeDeveloper.includes('development-worker-claim-'));
assert.ok(beforeDeveloper.indexOf('development-worker-claim-')<beforeDeveloper.indexOf('  restore:'));
assert.ok(developer.includes('needs: [claim, restore]'));
assert.ok(developer.includes('!cancelled() &&'));
assert.ok(!developer.includes('      always() &&'));
assert.ok(developer.includes("needs.restore.result == 'success'"));
assert.ok(developer.includes('-v "$RUNNER_TEMP/development-native:/resume:ro"'));
const denied=spawnSync(process.execPath,['scripts/lib/agent/orchestration/development-resume.mjs','prepare','/dev/null','/tmp/no-output'],
  {env:{GITHUB_ACTIONS:'false'},encoding:'utf8',timeout:5000});
assert.notEqual(denied.status,0);
assert.match(denied.stderr,/trusted main Developer authority/);
console.log('Developer continuation: exact committed identity, key continuity, native-file preservation and separate-job secret isolation negatives passed');
