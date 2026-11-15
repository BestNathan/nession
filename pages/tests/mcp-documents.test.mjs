import test from 'node:test';
import assert from 'node:assert/strict';
import {validMcpSnapshot} from '../mcp-documents.js';
const SHA='a'.repeat(40);
const tool={name:'nession_agent_list_sessions',description:'List sessions',
  inputSchema:{type:'object',properties:{agent_id:{type:'string'}},required:['agent_id']}};
const valid={schema_version:1,status:'available',semantic_sha256:'f'.repeat(64),protocol_versions:['2025-03-26','2026-07-28'],
  source:{repository:'BestNathan/nession',branch:'main',sha:SHA},upstream:{stable:{version:'2026-07-28',sha:'c'.repeat(40),changelog_blob_sha:'d'.repeat(40),changelog_sha256:'e'.repeat(64),
    release_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28',
    source_url:'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/'+'c'.repeat(40)+'/docs/specification/2026-07-28/changelog.mdx',
    previous_version:'2025-11-25',highlights:['Stateless core']}},tools:[tool]};
test('MCP source-generated catalog accepts pinned registered Tool schema',()=>{
  assert.equal(validMcpSnapshot(valid),true);
});
test('MCP catalog fails closed for missing, malformed and unpinned sources',()=>{
  assert.equal(validMcpSnapshot(null),false);
  assert.equal(validMcpSnapshot({...valid,source:{sha:'main'}}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[]}),false);
  assert.equal(validMcpSnapshot({...valid,tools:[{...tool,inputSchema:{}}]}),false);
});
