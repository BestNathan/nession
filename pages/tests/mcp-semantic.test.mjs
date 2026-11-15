import test from 'node:test';
import assert from 'node:assert/strict';
import {mcpSemanticDigest,mcpChanged} from '../scripts/mcp-semantic.mjs';
const tool={name:'nession_server_list_agents',description:'List Agents',
  inputSchema:{type:'object',properties:{agent_id:{type:'string'}}}};
test('MCP semantic identity ignores source revisions, object key order and tool order',()=>{
  const one={tools:[tool,{...tool,name:'nession_agent_list_sessions'}],
    protocol_versions:['2026-07-28','2025-03-26'],source:{sha:'a'.repeat(40)}};
  const two={...one,source:{sha:'b'.repeat(40)},tools:[
    {name:'nession_agent_list_sessions',inputSchema:{
      properties:{agent_id:{type:'string'}},type:'object'},description:'List Agents'},
    tool],protocol_versions:['2025-03-26','2026-07-28']};
  assert.equal(mcpSemanticDigest(one),mcpSemanticDigest(two));
  assert.equal(mcpChanged(mcpSemanticDigest(one),mcpSemanticDigest(two)),false);
});
test('MCP Tool/schema/protocol changes produce a new semantic identity',()=>{
  const original={tools:[tool],protocol_versions:['2026-07-28']};
  for(const modified of [
    {tools:[{...tool,description:'Changed'}],protocol_versions:original.protocol_versions},
    {tools:[{...tool,inputSchema:{type:'object',properties:{}}}],protocol_versions:original.protocol_versions},
    {...original,protocol_versions:['2025-03-26','2026-07-28']}
  ])assert.equal(mcpChanged(mcpSemanticDigest(original),mcpSemanticDigest(modified)),true);
  assert.throws(()=>mcpSemanticDigest({tools:[tool,tool]}),/duplicate/);
});
