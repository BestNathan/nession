// One model session traverses the Issue tree itself. These tools only enforce
// scope, resource ceilings and the original trusted Issue-edit invariants.
// No sub-agent, Actions recursion, shell access or issue dispatch is exposed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fetchGitHubIssue } from './tools/gh/issue/read.mjs';
import { createVerificationTierTool } from './tools/gh/issue/verification-tier.mjs';
import { createIssueUpdateTool } from './tools/gh/issue/update.mjs';
import { auditIssue } from '../../issue-contract.mjs';
import { readVerificationTier, VERIFICATION_TIERS } from '../../verification-tier-policy.mjs';

export const TREE_AUDIT_LIMIT=40;
const MAX_DEPTH=5;
export function explicitParentNumbers(body) {
  const found=new Set();
  for(const line of String(body??'').split(/\r?\n/).slice(0,100)){
    if(!/^\s*(?:[-*]\s*)?(?:\*\*)?(?:Parent(?:\s+tracking)?|父需求|父级|上级需求)(?=\s|:|：|\*|$)/i.test(line))continue;
    for(const ref of line.matchAll(/#(\d{1,9})\b/g)){
      const n=Number(ref[1]);if(n>0)found.add(n);
    }
  }
  return [...found];
}
export function isTreeDescendant(root,target,getIssue,maxDepth=MAX_DEPTH){
  if(root===target)return true;
  const seen=new Set([target]);
  let layer=[target];
  for(let depth=0;layer.length&&depth<maxDepth;depth++){
    const next=[];
    for(const n of layer){
      const issue=getIssue(n);
      for(const p of explicitParentNumbers(issue.body)){
        if(p===root)return true;
        if(!seen.has(p)){seen.add(p);next.push(p)}
      }
    }
    layer=next;
  }
  return false;
}
function ensureNumber(input){
  if(!Number.isSafeInteger(input)||input<=0)throw Error('invalid related Issue number');
  return input;
}
function sameArea(root,child){
  const names=x=>(x.labels??[]).map(l=>typeof l==='string'?l:l.name);
  // Domain label is a necessary, not sufficient, boundary: ancestry is checked separately.
  return names(root).some(l=>['terminal','web','agent','ci','protocol','backend','rust'].includes(l)&&names(child).includes(l));
}
function searchExplicitChildren(parent,repository){
  const q='repo:'+repository+' is:issue is:open in:body "#'+parent+'"';
  const raw=execFileSync('gh',['api','-X','GET','search/issues','-f','q='+q,
    '-f','per_page=100'],{encoding:'utf8',maxBuffer:8*1024*1024,env:process.env});
  const result=JSON.parse(raw);
  if(result.total_count>100||!Array.isArray(result.items))throw Error('related Issue search overflow');
  return result.items.filter(i=>explicitParentNumbers(i.body).includes(parent))
    .map(i=>({number:i.number,title:i.title,state:i.state,labels:i.labels,body:i.body}));
}
export function createTreeAuditTools(root,repository=process.env.GITHUB_REPOSITORY,
 {getIssue=fetchGitHubIssue,findChildren=searchExplicitChildren}={}){
  if(!repository||!Number.isSafeInteger(root?.number))throw Error('tree audit needs rooted Issue');
  const rootNumber=root.number, observed=new Set([rootNumber]),read=new Set([rootNumber]);
  const visited=new Map(),issues=new Map(),expanded=new Set();
  const readIssue=n=>{
    if(issues.size>TREE_AUDIT_LIMIT*MAX_DEPTH)throw Error('tree relation lookup ceiling reached');
    const result=getIssue(n,repository);
    issues.set(n,result);
    return result;
  };
  function ensureScoped(number,{writable=false}={}){
    ensureNumber(number);
    const issue=readIssue(number);
    if(number===rootNumber)return issue;
    if(!sameArea(root,issue))throw Error('unrelated Issue area');
    if(!isTreeDescendant(rootNumber,number,readIssue))throw Error('Issue has no explicit rooted parent chain');
    if(writable&&String(issue.state).toLowerCase()!=='open')throw Error('closed related Issue cannot be edited');
    if(!observed.has(number)&&observed.size>=TREE_AUDIT_LIMIT)throw Error('tree audit scope limit reached');
    observed.add(number);
    return issue;
  }
  function progress(){return {root:rootNumber,observed:observed.size,reviewed:visited.size,
    updated:[...visited].filter(([,v])=>v.updated).map(([n])=>n),
    unchanged:[...visited].filter(([,v])=>!v.updated).map(([n])=>n),
    remaining:[...observed].filter(n=>!visited.has(n)).sort((a,b)=>a-b),
    unexplored:[...observed].filter(n=>!expanded.has(n)).sort((a,b)=>a-b),
    limit:TREE_AUDIT_LIMIT};}
  const int={type:'integer',minimum:1};
  return {
    find_related_issues:{
      description:'Discover direct explicit children of a supplied already-in-scope parent. You decide which parent to explore next; results do not recursively dispatch or audit anything.',
      inputSchema:{type:'object',properties:{parent_number:int},required:['parent_number'],additionalProperties:false},
      async execute({parent_number}){
        ensureScoped(parent_number);
        const hits=findChildren(parent_number,repository);
        expanded.add(parent_number);
        const accepted=[];
        for(const h of hits){
          if(h.number===rootNumber||observed.has(h.number))continue;
          try {
            ensureScoped(h.number);
            accepted.push({number:h.number,title:h.title,labels:h.labels?.map(x=>typeof x==='string'?x:x.name)});
          } catch { /* misleading refs and unrelated/closed targets never enter scope */ }
        }
        return JSON.stringify({parent:parent_number,children:accepted,progress:progress()});
      }
    },
    read_related_issue:{
      description:'Read exactly one explicitly related Issue and its deterministic writing-contract findings; no mutations.',
      inputSchema:{type:'object',properties:{issue_number:int},required:['issue_number'],additionalProperties:false},
      async execute({issue_number}){
        const issue=ensureScoped(issue_number);read.add(issue_number);
        return JSON.stringify({issue,contract:auditIssue(issue),tier:readVerificationTier(issue)});
      }
    },
    review_related_issue:{
      description:'Record your one-by-one Issue risk review and optionally assign/upgrade verification tier. The original target-bound, upgrade-only trusted tier setter applies. A completed review requires previous read_related_issue.',
      inputSchema:{type:'object',properties:{
        issue_number:int,tier:{type:'string',enum:VERIFICATION_TIERS},
        reason:{type:'string',minLength:20,maxLength:2000}},
        required:['issue_number','tier','reason'],additionalProperties:false},
      async execute({issue_number,tier,reason}){
        const issue=ensureScoped(issue_number,{writable:true});
        if(!read.has(issue_number))throw Error('read related Issue before attempting review');
        if(visited.has(issue_number))throw Error('Issue already reviewed in this Agent session');
        const existing=readVerificationTier(issue);
        const before=VERIFICATION_TIERS.indexOf(existing.tier);
        const proposed=VERIFICATION_TIERS.indexOf(tier);
        if(existing.explicit&&proposed<before)throw Error('verification-tier downgrade requires human authorization');
        let updated=false;
        if(!existing.explicit||before<proposed){
          await createVerificationTierTool(issue,repository).execute({tier,reason});
          updated=true;
        }
        const after=readIssue(issue_number);
        const contract=auditIssue(after);
        if(!contract.ok)throw Error('Issue Contract remains invalid: '+contract.errors.join('; '));
        if(readVerificationTier(after).tier!==(updated?tier:existing.tier))throw Error('tier readback mismatch');
        visited.set(issue_number,{updated,reason});
        return JSON.stringify({issue_number,tier:readVerificationTier(after).tier,
          status:updated?'updated':'unchanged',reason,contract:'Pass',progress:progress()});
      }
    },
    repair_related_issue:{
      description:'Repair ONLY a previously read and explicitly related Issue writing Contract. Existing E2E/SC evidence is protected by the original target-bound edit tool.',
      inputSchema:{type:'object',properties:{issue_number:int,
        title:{type:'string'},body:{type:'string'},labels:{type:'array',items:{type:'string'}}},
        required:['issue_number','title','body','labels'],additionalProperties:false},
      async execute({issue_number,title,body,labels}){
        const issue=ensureScoped(issue_number,{writable:true});
        if(!read.has(issue_number))throw Error('read related Issue before repair');
        const result=await createIssueUpdateTool(issue,repository).execute({title,body,labels});
        readIssue(issue_number);
        return result;
      }
    },
    tree_audit_progress:{
      description:'Report tool-verified progress and remaining children. Never call the tree complete while remaining is nonempty.',
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      async execute(){return JSON.stringify(progress());}
    },
    __progress:progress
  };
}
export function testIssueTree(){
  const mk=(n,parents=[],domain='terminal')=>({number:n,state:'OPEN',
    body:parents.length?'Parent '+parents.map(p=>'#'+p).join(' / '):'Root',
    labels:[{name:domain}]});
  const map=new Map([mk(1645),mk(1924,[1645]),mk(1925,[1645]),mk(1931,[1924,1645]),
    mk(9999,[4321]),mk(4321,[9999]),mk(8888,[1645],'ci')].map(x=>[x.number,x]));
  assert.deepEqual(explicitParentNumbers('Related #99\nParent #1924 / #1645'),[1924,1645]);
  assert.deepEqual(explicitParentNumbers('just mentions #1645'),[]);
  assert.equal(isTreeDescendant(1645,1931,n=>map.get(n)),true);
  assert.equal(isTreeDescendant(1645,9999,n=>map.get(n)),false);
  assert.equal(isTreeDescendant(1645,8888,n=>map.get(n)),true);
  const scoped=createTreeAuditTools(map.get(1645),'example/repo',{getIssue:n=>map.get(n),
    findChildren:n=>[...map.values()].filter(x=>explicitParentNumbers(x.body).includes(n))});
  return (async()=>{
    assert.equal(JSON.parse(await scoped.read_related_issue.execute({issue_number:1931})).issue.number,1931);
    await assert.rejects(scoped.read_related_issue.execute({issue_number:9999}),/no explicit rooted parent chain/);
    await assert.rejects(scoped.read_related_issue.execute({issue_number:8888}),/unrelated Issue area/);
    const found=JSON.parse(await scoped.find_related_issues.execute({parent_number:1645}));
    assert.deepEqual(found.children.map(x=>x.number),[1924,1925]);
    await assert.rejects(scoped.review_related_issue.execute({issue_number:1925,tier:'verification:full',reason:'This is a cross-component requirement with verified security risk'}),/read related Issue/);
    console.log('Issue tree Agent scope: verified explicit ancestry, cycle, domain, read-before-write and single scope');
  })();
}
