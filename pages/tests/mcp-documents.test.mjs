import test from 'node:test';
import assert from 'node:assert/strict';
import {validMcpSnapshot} from '../mcp-documents.js';
const SHA='a'.repeat(40);
const tool={name:'nession_agent_list_sessions',description:'List sessions',
  inputSchema:{type:'object',properties:{agent_id:{type:'string'}},required:['agent_id']}};
const valid={schema_version:1,status:'available',
  source:{repository:'BestNathan/nession',branch:'main',sha:SHA},tools:[tool]};
test('MCP source-generated catalog accepts pinned registered Tool schema',()=>{
  assert.equal(validMcpSnapshot(valid),true);
});
test('MCP catalog fails closed for missing, malformed and unpinned sources',()=>{
  assert.equal(validMcpSnapshot(null),false);
  assert.equal(validMcpSnapshot({...valid,source:{sha:'main'}}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,inputSchema:{}}]}),false);
});
