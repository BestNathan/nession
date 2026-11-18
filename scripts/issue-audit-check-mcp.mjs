#!/usr/bin/env node
// Dedicated stdio MCP validation server, selected only by the trusted
// Issue Audit runner. One fixed Issue, one read-only tool, at most 3 calls.
// No shell/Bash tool, repository mutation, dynamic targets or credentials API.
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { fetchGitHubIssue } from './lib/agent/tools/gh/issue/read.mjs';
import { validateIssueAuditCandidate } from './lib/agent/tools/gh/issue/validate.mjs';

export const NAME='validate_issue_proposal';
const MAX_BYTES=144*1024,MAX_CALLS=3;
const schema={
  type:'object',additionalProperties:false,required:['proposal'],
  properties:{
    proposal:{type:'object',additionalProperties:false,
      properties:{
        title:{type:'string'},body:{type:'string'},
        body_without_e2e:{type:'string'},
        labels:{type:'array',items:{type:'string'}},
        comment:{type:'string'},verification_tier:{type:'string'},
        tier_reason:{type:'string'},
      }},
  },
};
export function makeAuditMcpHandler({issueNumber,readIssue,maxCalls=MAX_CALLS}) {
  if(!Number.isSafeInteger(issueNumber)||issueNumber<1||typeof readIssue!=='function')
    throw Error('Audit MCP requires a fixed positive Issue and a read-only source');
  let calls=0;
  return async function handle(message) {
    if(!message||typeof message!=='object'||Array.isArray(message))return null;
    if(message.id==null)return null; // notifications are never requests
    const reply=(result)=>({jsonrpc:'2.0',id:message.id,result});
    const err=(code,message)=>({jsonrpc:'2.0',id:message.id,
      error:{code,message}});
    switch(message.method){
      case 'initialize': return reply({
        protocolVersion:'2025-06-18',
        capabilities:{tools:{listChanged:false}},
        serverInfo:{name:'nession-audit-check',version:'1.0.0'},
      });
      case 'ping':return reply({});
      case 'tools/list':return reply({tools:[{
        name:NAME,
        description:'Read-only canonical Issue Audit candidate validation for the fixed current Issue. No writes, no arbitrary commands. Call before returning final JSON; fix findings and retry up to three times. This does not attest E2E evidence or authorize an Issue update.',
        inputSchema:schema,
      }]});
      case 'tools/call': {
        if(message.params?.name!==NAME)
          return err(-32602,'Unknown or unauthorized Audit validation tool');
        if(++calls>maxCalls)
          return reply({isError:true,content:[{type:'text',
            text:JSON.stringify({ok:false,code:'ISSUE_AUDIT_PREFLIGHT_LIMIT',
              findings:['Three read-only validation attempts exhausted']})}]});
        const input=message.params?.arguments;
        if(!input||typeof input!=='object'||Array.isArray(input)||
            Object.keys(input).some(k=>k!=='proposal')||
            !input.proposal||typeof input.proposal!=='object'||
            Array.isArray(input.proposal)||
            Buffer.byteLength(JSON.stringify(input),'utf8')>MAX_BYTES)
          return reply({isError:true,content:[{type:'text',
            text:JSON.stringify({ok:false,code:'ISSUE_AUDIT_PREFLIGHT_INPUT',
              findings:['Provide only a bounded proposal object for the fixed Issue']})}]});
        try {
          const issue=await readIssue(issueNumber);
          if(issue?.number!==issueNumber)throw Error('Mismatch in trusted Issue readback');
          const verdict=validateIssueAuditCandidate(issue,input.proposal);
          return reply({isError:!verdict.ok,content:[{type:'text',text:JSON.stringify(verdict)}]});
        }catch(_error){
          // Distinguish a broken GitHub/tooling read from a model proposal.
          return reply({isError:true,content:[{type:'text',
            text:JSON.stringify({ok:false,code:'ISSUE_AUDIT_PREFLIGHT_SOURCE_UNAVAILABLE',
              findings:['Cannot authenticate fixed Issue readback; do not claim validation success']})}]});
        }
      }
      default:return err(-32601,'Unsupported MCP method');
    }
  };
}
function fixture(){
  return {number:3855,state:'OPEN',title:'Requirement: Runner',
    labels:[{name:'requirement'},{name:'agent'}],
    body:'## Requirements: Runner\n### Success Criteria\n- [ ] SC-01 works\n'+
      '## Acceptance Report\n| Criterion | Result | Evidence |\n'+
      '|---|---|---|\n| SC-01 | Pending | awaiting tests |\n'+
      '## Product alignment\n- [x] aligned\n'+
      '## E2E Verification\n### New\n- none: Node-only test\n'+
      '### Regression\n- none: same\n'+
      '## E2E Report\n| ID | Type | Result | Evidence |\n|---|---|---|---|'};
}
export async function selfTestAuditMcp(){
  const source=fixture();
  const h=makeAuditMcpHandler({issueNumber:3855,readIssue:async n=>{
    assert.equal(n,3855);return source;
  }});
  const ping=await h({jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  assert.equal(ping.result.serverInfo.name,'nession-audit-check');
  const list=await h({jsonrpc:'2.0',id:2,method:'tools/list'});
  assert.deepEqual(list.result.tools.map(t=>t.name),[NAME]);
  assert.equal(list.result.tools[0].inputSchema.additionalProperties,false);
  const req=(id,proposal)=>({jsonrpc:'2.0',id,method:'tools/call',
    params:{name:NAME,arguments:{proposal}}});
  const ok=await h(req(3,{}));
  assert.equal(JSON.parse(ok.result.content[0].text).ok,true);
  const bad=await h(req(4,{body:source.body.replace('- none: same',
    '- none: changed')})); 
  assert.equal(JSON.parse(bad.result.content[0].text).code,'ISSUE_AUDIT_E2E_PROTECTED');
  assert.equal(bad.result.isError,true);
  const foreign=await h({jsonrpc:'2.0',id:5,method:'tools/call',
    params:{name:NAME,arguments:{issue_number:999,proposal:{}}}});
  assert.equal(JSON.parse(foreign.result.content[0].text).code,'ISSUE_AUDIT_PREFLIGHT_INPUT');
  const over=await h(req(6,{}));
  assert.equal(JSON.parse(over.result.content[0].text).code,'ISSUE_AUDIT_PREFLIGHT_LIMIT');
  const forged=await h({jsonrpc:'2.0',id:7,method:'tools/call',
    params:{name:'run_shell',arguments:{command:'rm -rf /'}}});
  assert.equal(forged.error.code,-32602);
  const sourceFail=makeAuditMcpHandler({issueNumber:3855,
    readIssue:()=>{throw Error('private 403 token string');}});
  assert.equal(JSON.parse((await sourceFail(req(8,{})).result).content[0].text).code,
    'ISSUE_AUDIT_PREFLIGHT_SOURCE_UNAVAILABLE');
  assert.equal(await h({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  console.log('issue-audit-check-mcp: fixed target, bounded calls, no shell/mutation, readback and protection fixtures passed');
}
async function run(){
  if(process.argv[2]==='self-test')return selfTestAuditMcp();
  const number=Number(process.env.ISSUE_AUDIT_FIXED_ISSUE_ID);
  const handler=makeAuditMcpHandler({issueNumber:number,
    readIssue:(n)=>fetchGitHubIssue(n,process.env.GITHUB_REPOSITORY)});
  const reader=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of reader){
    if(!line.trim())continue;
    if(Buffer.byteLength(line,'utf8')>MAX_BYTES+8192)continue;
    try {
      const response=await handler(JSON.parse(line));
      if(response)process.stdout.write(JSON.stringify(response)+'\n');
    }catch(error){
      console.error('Issue Audit MCP request rejected:',error?.message||'bad request');
    }
  }
}
if(import.meta.url==='file://'+process.argv[1]){
  run().catch(error=>{console.error(error);process.exitCode=1;});
}
