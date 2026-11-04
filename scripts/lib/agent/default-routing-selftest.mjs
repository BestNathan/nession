#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveAgentDefault,roleVariable,qwenDefaultAgent} from './default-routing.mjs';

const registry=JSON.parse(readFileSync('automation/agents/registry.json','utf8'));
assert.equal(roleVariable('developer'),'AGENT_DEFAULT_DEVELOPER');
assert.equal(roleVariable('reviewer'),'AGENT_DEFAULT_REVIEWER');
assert.equal(roleVariable('acceptor'),'AGENT_DEFAULT_ACCEPTOR');
assert.equal(roleVariable('auditor'),'AGENT_DEFAULT_AUDITOR');
// Missing Repository Variables must never silently select Cursor again.
for(const [role,id] of Object.entries({
  developer:'dev-qwen-01',reviewer:'review-qwen-01',
  acceptor:'accept-qwen-01',auditor:'audit-qwen-01',
})){
  assert.equal(qwenDefaultAgent(role),id);
  const selected=resolveAgentDefault(registry,role,{legacy:qwenDefaultAgent(role)});
  assert.equal(selected.agent_id,id);
  assert.equal(selected.provider,'claude-code');
  assert.equal(selected.environment,'dev-claude-qwen');
}
assert.throws(()=>qwenDefaultAgent('invalid'),/unsupported role/);
for(const [path,role] of [
  ['.github/workflows/agent-issue-audit.yml','auditor'],
  ['.github/workflows/agent-review.yml','reviewer'],
  ['.github/workflows/agent-sc-acceptance.yml','acceptor'],
]){
  assert.ok(readFileSync(path,'utf8').includes('legacy:qwenDefaultAgent("'+role+'")'),
    path+' must route unconfigured automatic Agents to Qwen');
}
assert.ok(!readFileSync('.github/workflows/agent-sc-acceptance.yml','utf8')
  .includes('(!given && !process.env.ACCEPTOR_DEFAULT)'),
  'Acceptor must not silently route an empty configuration to Cursor');
assert.equal(resolveAgentDefault(registry,'reviewer',{legacy:'review-cursor-01'}).agent_id,
  'review-cursor-01');
assert.deepEqual(resolveAgentDefault(registry,'reviewer',{
  configured:'review-qwen-01',legacy:'review-cursor-01',
}),{agent_id:'review-qwen-01',role:'reviewer',provider:'claude-code',
  environment:'dev-claude-qwen'});
assert.equal(resolveAgentDefault(registry,'reviewer',{
  configured:'review-cursor-01',override:'review-qwen-01',
}).agent_id,'review-qwen-01');
assert.equal(resolveAgentDefault(registry,'acceptor',{
  configured:'accept-qwen-01',legacy:'accept-cursor-01',
}).environment,'dev-claude-qwen');
assert.equal(resolveAgentDefault(registry,'auditor',{
  configured:'audit-qwen-01',legacy:'audit-cursor-01',
}).provider,'claude-code');
assert.equal(resolveAgentDefault(registry,'auditor',{
  configured:'audit-deepseek-01',
}).environment,'deepseek');
assert.equal(resolveAgentDefault(registry,'developer',{legacy:'dev-cursor-01'}).agent_id,
  'dev-cursor-01');
assert.equal(resolveAgentDefault(registry,'developer',{
  configured:'dev-qwen-01',legacy:'dev-cursor-01',
}).environment,'dev-claude-qwen');
assert.equal(resolveAgentDefault(registry,'developer',{
  configured:'dev-cursor-01',override:'dev-qwen-01',
}).agent_id,'dev-qwen-01');
assert.throws(()=>resolveAgentDefault(registry,'developer',{
  configured:'review-qwen-01',
}),/wrong-role/);
assert.throws(()=>resolveAgentDefault(registry,'developer',{}),/missing/);
assert.throws(()=>resolveAgentDefault(registry,'acceptor',{
  configured:'audit-qwen-01',
}),/wrong-role/);
assert.throws(()=>resolveAgentDefault(registry,'reviewer',{
  configured:'review-does-not-exist',legacy:'review-cursor-01',
}),/unregistered/);
assert.throws(()=>resolveAgentDefault(registry,'reviewer',{
  configured:'dev-qwen-01',
}),/wrong-role/);
assert.throws(()=>resolveAgentDefault(registry,'reviewer',{
  configured:' review-qwen-01',
}),/invalid/);
assert.throws(()=>resolveAgentDefault(registry,'reviewer',{}),/missing/);
assert.throws(()=>resolveAgentDefault(registry,'admin',{legacy:'review-qwen-01'}),/unsupported/);
assert.throws(()=>resolveAgentDefault(registry,'reviewer',{
  configured:42,legacy:'review-cursor-01',
}),/invalid configured/);
console.log('GitHub variable Agent defaults: registered, invalid, missing, override and cross-role contract cases passed');
