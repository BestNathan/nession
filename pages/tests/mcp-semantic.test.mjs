import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyMcpSemanticDigestV1,mcpSemanticDigest,mcpChanged}
  from '../scripts/mcp-semantic.mjs';
const outputSchema={type:'object',required:['agents'],properties:{
  agents:{type:'array',description:'Registered Agents'}}};
const tool={name:'nession_server_list_agents',description:'List Agents',
  inputSchema:{type:'object',properties:{agent_id:{type:'string'}}},outputSchema};
test('MCP semantic identity ignores source revisions, object key order and tool order',()=>{
  const one={tools:[tool,{...tool,name:'nession_agent_list_sessions'}],
    protocol_versions:['2026-07-28','2025-03-26'],source:{sha:'a'.repeat(40)}};
  const two={...one,source:{sha:'b'.repeat(40)},tools:[
    {name:'nession_agent_list_sessions',inputSchema:{
      properties:{agent_id:{type:'string'}},type:'object'},description:'List Agents',
      outputSchema:{properties:{agents:{description:'Registered Agents',type:'array'}},
        required:['agents'],type:'object'}},
    tool],protocol_versions:['2025-03-26','2026-07-28']};
  assert.equal(mcpSemanticDigest(one),mcpSemanticDigest(two));
  assert.equal(mcpChanged(mcpSemanticDigest(one),mcpSemanticDigest(two)),false);
});
test('MCP Tool/schema/protocol changes produce a new semantic identity',()=>{
  const original={tools:[tool],protocol_versions:['2026-07-28']};
  for(const modified of [
    {tools:[{...tool,description:'Changed'}],protocol_versions:original.protocol_versions},
    {tools:[{...tool,inputSchema:{type:'object',properties:{}}}],protocol_versions:original.protocol_versions},
    {tools:[{...tool,outputSchema:{...outputSchema,required:[]}}],protocol_versions:original.protocol_versions},
    {tools:[{...tool,outputSchema:{type:'object',properties:{
      agents:{type:'array',description:'Changed meaning'}}}}],protocol_versions:original.protocol_versions},
    {...original,protocol_versions:['2025-03-26','2026-07-28']}
  ])assert.equal(mcpChanged(mcpSemanticDigest(original),mcpSemanticDigest(modified)),true);
  assert.throws(()=>mcpSemanticDigest({tools:[tool,tool]}),/duplicate/);
});
test('a missing or placeholder outputSchema has no semantic identity',()=>{
  for(const broken of [
    {...tool,outputSchema:undefined},
    {...tool,outputSchema:null},
    {...tool,outputSchema:{type:'object'}},
    {...tool,outputSchema:{type:'object',properties:{}}}
  ])assert.throws(()=>mcpSemanticDigest({tools:[broken]}),/Invalid MCP Tool contract/);
});
test('the legacy v1 identity remains available only for migration validation',()=>{
  const legacy={tools:[{name:tool.name,description:tool.description,
    inputSchema:tool.inputSchema}],protocol_versions:['2026-07-28']};
  assert.match(legacyMcpSemanticDigestV1(legacy),/^[a-f0-9]{64}$/);
  assert.throws(()=>mcpSemanticDigest(legacy),/Invalid MCP Tool contract/);
});

test('pinned upstream stable release update changes MCP digest, draft metadata does not',()=>{
  const release={version:'2026-07-28',sha:'a'.repeat(40),changelog_sha256:'b'.repeat(64)};
  const source={tools:[tool],protocol_versions:['2026-07-28'],upstream:{stable:release}};
  const digest=mcpSemanticDigest(source);
  assert.notEqual(mcpSemanticDigest({...source,upstream:{stable:{...release,
    version:'2027-03-30',sha:'c'.repeat(40)}}}),digest);
  assert.notEqual(mcpSemanticDigest({...source,upstream:{stable:{...release,
    changelog_sha256:'d'.repeat(64)}}}),digest);
  assert.equal(mcpSemanticDigest({...source,upstream:{stable:release,
    draft:{title:'Unreleased SEP'}}}),digest);
});
