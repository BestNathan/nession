// #2358: independently verify the *live* production Knowledge writer policy
// and authenticate the owner's Environment attestation. This is read-only:
// it never obtains App keys, dispatches workflows, or mutates Git refs.
// GitHub's server-side rule semantics are relied on; destructive denial probes
// remain optional and MUST NOT be claimed as executed by this collector.
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const TARGET = 'refs/heads/knowledge';
const SHA = /^[a-f0-9]{40}$/;
const WRITER_ID = 26835890;
const APPEND_ID = 26836090;
const APP_ID = 5677350;
const OWNER_COMMENT = 6787387357;
const OWNER_ATTESTATION = 'confirmed `knowledge-publish` Environment is configured correctly';
const specs = [
  {id:WRITER_ID,name:'Knowledge / Writer identity',
    types:['creation','update'],actor:'app'},
  {id:APPEND_ID,name:'Knowledge / Append-only',
    types:['deletion','non_fast_forward','required_linear_history'],actor:'none'},
];

function requireProof(ok,why){if(!ok)throw Error('knowledge-writer-2358: '+why);}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function validRule(rule,spec){
  requireProof(rule?.id===spec.id&&rule.name===spec.name&&
    rule.enforcement==='active'&&rule.target==='branch'&&
    rule.source_type==='Repository',spec.name+': identity/inactive/target mismatch');
  requireProof(same(rule.conditions?.ref_name?.include,[TARGET])&&
    same(rule.conditions?.ref_name?.exclude,[]),
  spec.name+': rules must apply to the single exact production branch');
  requireProof(same((rule.rules??[]).map(x=>x.type).sort(),[...spec.types].sort()),
    spec.name+': unexpected rule set');
  // Do not confuse GitHub API masking with zero bypass: this is a strict
  // administrator-visible evidence path, never a permission elevation request.
  requireProof(Array.isArray(rule.bypass_actors),spec.name+': bypass metadata masked');
  if(spec.actor==='none')requireProof(rule.bypass_actors.length===0,
    spec.name+': unexpected bypass');
  else requireProof(rule.bypass_actors.length===1&&
    rule.bypass_actors[0].actor_id===APP_ID&&
    rule.bypass_actors[0].actor_type==='Integration'&&
    rule.bypass_actors[0].bypass_mode==='always',
    spec.name+': unexpected writer bypass');
}
export function shouldCollectKnowledgeWriter2358(stage,issue){
  return stage==='post-merge'&&String(issue)==='2358';
}
export function attestKnowledgeWriter2358({targetSha,branch,writer,append,comment}){
  requireProof(SHA.test(targetSha),'unbound target SHA');
  requireProof(branch?.name==='knowledge'&&branch.protected===true&&
    SHA.test(branch.commit?.sha||''),'production knowledge must be protected');
  validRule(writer,specs[0]);
  validRule(append,specs[1]);
  requireProof(comment?.id===OWNER_COMMENT&&
    comment.user?.login==='BestNathan'&&comment.user?.type==='User'&&
    comment.author_association==='OWNER'&&
    comment.issue_url==='https://api.github.com/repos/'+REPO+'/issues/2358'&&
    typeof comment.created_at==='string'&&
    comment.created_at===comment.updated_at&&
    typeof comment.body==='string'&&comment.body.includes(OWNER_ATTESTATION),
    'missing authenticated, unedited owner Environment attestation');
  // A manual owner statement cannot independently prove hidden Environment
  // reviewer/secret settings. Keep the attestation type transparent.
  return Object.freeze({
    schema_version:1,kind:'verified_knowledge_writer_policy_2358',
    acceptance_target_sha:targetSha,
    live_knowledge_ref:TARGET,live_knowledge_sha:branch.commit.sha,
    effective_branch_protected:true,
    writer_ruleset_id:WRITER_ID,append_only_ruleset_id:APPEND_ID,
    dedicated_app_id:APP_ID,
    writer_ruleset_rules:specs[0].types,
    append_only_ruleset_rules:specs[1].types,
    writer_only_bypass:'Integration/always App '+APP_ID,
    append_only_bypass_actors:0,
    owner_environment_comment_id:OWNER_COMMENT,
    owner_environment_attestation:'GitHub-authenticated owner assertion; private Environment settings not independently API-readable',
    independent_environment_api_readback:false,
    actual_unauthorized_force_delete_denial_tested:false,
    verified_by:'GitHub live branch and both Ruleset detail APIs plus immutable owner comment identity',
    establishes_sc_verdict:false,
  });
}
export async function collectKnowledgeWriter2358({repo,targetSha,stage,issue,get}){
  if(!shouldCollectKnowledgeWriter2358(stage,issue))return [];
  requireProof(repo===REPO&&SHA.test(targetSha)&&typeof get==='function',
    'wrong repository, target or reader');
  const base='/repos/'+REPO;
  const [branch,writer,append,comment]=await Promise.all([
    get(base+'/branches/knowledge'),
    get(base+'/rulesets/'+WRITER_ID),
    get(base+'/rulesets/'+APPEND_ID),
    get(base+'/issues/comments/'+OWNER_COMMENT),
  ]);
  return [attestKnowledgeWriter2358({targetSha,branch,writer,append,comment})];
}
export function selfTestKnowledgeWriter2358(){
  const targetSha='a'.repeat(40);
  const branch={name:'knowledge',protected:true,commit:{sha:'b'.repeat(40)}};
  const mk=(spec)=>({id:spec.id,name:spec.name,enforcement:'active',
    target:'branch',source_type:'Repository',
    conditions:{ref_name:{include:[TARGET],exclude:[]}},
    rules:spec.types.map(type=>({type})),
    bypass_actors:spec.actor==='app'
      ?[{actor_id:APP_ID,actor_type:'Integration',bypass_mode:'always'}]:[]});
  const writer=mk(specs[0]),append=mk(specs[1]);
  const comment={id:OWNER_COMMENT,user:{login:'BestNathan',type:'User'},
    author_association:'OWNER',
    issue_url:'https://api.github.com/repos/'+REPO+'/issues/2358',
    created_at:'2026-11-11T04:53:37Z',updated_at:'2026-11-11T04:53:37Z',
    body:'Owner '+OWNER_ATTESTATION+'.'};
  const good={targetSha,branch,writer,append,comment};
  assert.equal(attestKnowledgeWriter2358(good).append_only_bypass_actors,0);
  assert.equal(shouldCollectKnowledgeWriter2358('post-merge',2358),true);
  assert.equal(shouldCollectKnowledgeWriter2358('pre-merge',2358),false);
  assert.equal(shouldCollectKnowledgeWriter2358('post-merge',3156),false);
  for(const patch of [
    {branch:{...branch,protected:false}},
    {writer:{...writer,enforcement:'disabled'}},
    {writer:{...writer,conditions:{ref_name:{include:['~ALL'],exclude:[]}}}},
    {writer:{...writer,rules:[{type:'update'}]}},
    {writer:{...writer,bypass_actors:undefined}},
    {writer:{...writer,bypass_actors:[{actor_id:5326063,actor_type:'Integration',bypass_mode:'always'}]}},
    {writer:{...writer,bypass_actors:[...writer.bypass_actors,{actor_id:1}]}},
    {append:{...append,bypass_actors:[{actor_id:APP_ID}]}},
    {append:{...append,rules:[{type:'deletion'}]}},
    {comment:{...comment,author_association:'CONTRIBUTOR'}},
    {comment:{...comment,user:{login:'BestNathan',type:'Bot'}}},
    {comment:{...comment,updated_at:'2026-11-11T04:54:00Z'}},
    {comment:{...comment,body:'Environment not verified'}},
    {targetSha:'bad'},
  ])assert.throws(()=>attestKnowledgeWriter2358({...good,...patch}));
  console.log('knowledge-writer-2358: strict live policy and owner attestation fixtures passed');
  return true;
}
if(process.argv[2]==='self-test')selfTestKnowledgeWriter2358();
