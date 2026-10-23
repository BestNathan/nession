#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveAgentDefault,roleVariable} from './default-routing.mjs';

const registry=JSON.parse(readFileSync('automation/agents/registry.json','utf8'));
assert.equal(roleVariable('developer'),'AGENT_DEFAULT_DEVELOPER');
assert.equal(roleVariable('reviewer'),'AGENT_DEFAULT_REVIEWER');
assert.equal(roleVariable('acceptor'),'AGENT_DEFAULT_ACCEPTOR');
assert.equal(roleVariable('auditor'),'AGENT_DEFAULT_AUDITOR');
assert.equal(resolveAgentDefault(registry,'reviewer',{legacy:'review-cursor-01'}).agent_id,
  'review-cursor-01');
assert.deepEqual(resolveAgentDefault(registry,'reviewer',{
  configured:'review-qwen-01',legacy:'review-cursor-01',
}),{agent_id:'review-qwen-01',role:'reviewer',provider:'claude-code',
  environment:'dev-claude-qwen'});
assert.equal(resolveAgentDefault(registry,'reviewer',{
  configured:'review-cursor-01',override:'review-qwen-01',
}).agent_id,'review-qwen-01');
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
console.log('GitHub variable Agent defaults: 11 contract cases passed');
