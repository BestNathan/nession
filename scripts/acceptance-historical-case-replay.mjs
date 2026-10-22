import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const requireProof=(yes,why)=>{if(!yes)throw Error('historical Case replay: '+why);};
const ahead=(a,b,c)=>a===b||(c?.status==='ahead'&&c.base_commit?.sha===a&&
  c.merge_base_commit?.sha===a&&c.behind_by===0&&c.ahead_by>0);
export function pinnedCaseReplays(body){
 const b=String(body||'').split('## Success Criteria')[1]?.split('## Acceptance Plan')[0]||'';
 const pins=[];
 for(const s of b.split('\n')){
  if(!/^- \[[ x]\] SC-\d+/.test(s)||!s.includes('Historical Case Replay Run'))continue;
  const m=s.match(/Historical Case Replay Run \x60?(\d+)\x60? attempt \x60?(\d+)\x60? of Case Run \x60?(\d+)\x60? attempt \x60?(\d+)\x60? proving Issue #(\d+) (SC-\d+) at \x60?([a-f0-9]{40})/);
  requireProof(m,'invalid SC pin');
  const n=m.slice(1,6).map(Number);
  requireProof(n.every(x=>Number.isSafeInteger(x)&&x>0)&&n[0]!==n[2],'bad Run IDs');
  pins.push({ingest:n[0],attempt:n[1],source:n[2],sourceAttempt:n[3],
   issue:n[4],criterion:m[6],sha:m[7]});
 }
 requireProof(pins.length<=2,'unbounded pin list');
 return pins;
}
const sourcePath=p=>'runs/2026-10-15/'+p.source+'-'+p.sourceAttempt+
 '/'+p.issue+'/'+p.criterion+'.json';
function readBlob(f,path){
 requireProof(f?.path===path&&f.type==='file'&&f.encoding==='base64'&&sha(f.sha),
  'not a Git blob');
 const s=Buffer.from(f.content,'base64').toString('utf8');
 const hash=createHash('sha1').update('blob '+Buffer.byteLength(s)+'\0'+s).digest('hex');
 requireProof(s.length<131072&&hash===f.sha,'invalid immutable Git bytes');
 return JSON.parse(s);
}
export function verifyHistoricalReplay(x){
 const {p,target,source,ingest,merge,c1,c2,pulls,jobs,log,record,index,issue}=x;
 requireProof(sha(target)&&sha(ingest?.head_sha),'bad SHA');
 const run=(r,name,path,event,id,attempt,head)=>r?.id===id&&
  r.run_attempt===attempt&&r.name===name&&
  r.path?.replace(/@refs\/heads\/main$/,'')===path&&r.event===event&&
  r.head_branch==='main'&&r.head_sha===head&&r.status==='completed'&&
  r.conclusion==='success'&&r.repository?.full_name==='BestNathan/nession'&&
  r.head_repository?.full_name==='BestNathan/nession';
 requireProof(run(source,'Acceptance / Cases','.github/workflows/acceptance-cases.yml',
  'push',p.source,p.sourceAttempt,p.sha),'wrong source run');
 requireProof(run(ingest,'Acceptance / Case Ingest',
  '.github/workflows/acceptance-case-ingest.yml','workflow_run',
  p.ingest,p.attempt,ingest.head_sha),'wrong ingestion attempt');
 requireProof(merge?.sha===p.sha&&merge.parents?.length===2&&
  ahead(p.sha,ingest.head_sha,c1)&&ahead(ingest.head_sha,target,c2),
  'not verified merged ancestry');
 requireProof(pulls?.some(q=>q.merged_at&&q.base?.ref==='main'&&
  q.body?.includes('Refs #'+p.issue)),'missing associated merged Issue PR');
 const job=jobs?.jobs?.filter(j=>j.name==='ingest');
 requireProof(job?.length===1&&job[0].run_id===p.ingest&&
  job[0].run_attempt===p.attempt&&job[0].head_sha===ingest.head_sha&&
  job[0].conclusion==='success','wrong ingestion job');
 for(const step of ['Self-test trusted ingestion','Download source Case results',
  'Validate and prepare immutable records',
  'Append compact immutable records and SHA indexes',
  'Project only currently eligible results'])
  requireProof(job[0].steps?.some(y=>y.name===step&&
    y.status==='completed'&&y.conclusion==='success'),'bad step '+step);
 const path=sourcePath(p);
 requireProof(record?.kind==='acceptance_case_result'&&record.result==='Pass'&&
  record.run_id===p.source&&record.run_attempt===p.sourceAttempt&&
  record.target_sha===p.sha&&record.issue===p.issue&&record.criterion===p.criterion&&
  record.provenance?.record_path===path,'wrong Case record');
 requireProof(index?.record===path&&index.target_sha===p.sha&&
  index.source?.run_id===p.source&&index.source?.repository==='BestNathan/nession'&&
  index.execution_id===record.execution_id&&
  index.contract_sha256===record.contract_sha256,'wrong Case SHA index');
 requireProof(issue?.number===p.issue&&issue.state==='closed'&&
  issue.body?.includes('| '+p.criterion+' | Pass |')&&
  issue.body?.includes('run '+p.source+'; ref '+p.sha),'Case SC not source-bound Pass');
 requireProof(typeof log==='string'&&log.length<1048576,'missing job logs');
 const rows=log.split('\n');
 requireProof(rows.some((s,i)=>s.includes('Projecting '+path)&&
  rows.slice(i+1,i+5).some(x=>x.includes('{"projected":true,"changed":true}'))),
  'no record-specific positive historical projection');
 return {schema_version:1,kind:'authenticated_historical_case_replay',
  target_sha:target,source_sha:p.sha,source_run_id:p.source,
  source_attempt:p.sourceAttempt,ingest_run_id:p.ingest,
  ingest_attempt:p.attempt,ingest_sha:ingest.head_sha,
  source_record:path,projection_changed:true,latest_head_acceptance:false};
}
export async function historicalCaseEvidence({repo,target,body,get,getText}){
 const pins=pinnedCaseReplays(body);
 if(!pins.length)return [];
 requireProof(repo==='BestNathan/nession'&&sha(target),'untrusted target');
 const root='/repos/'+repo,result=[];
 for(const p of pins){
  const [source,ingest,merge,pulls,jobs,issue]=await Promise.all([
   get(root+'/actions/runs/'+p.source),get(root+'/actions/runs/'+p.ingest),
   get(root+'/git/commits/'+p.sha),get(root+'/commits/'+p.sha+'/pulls?per_page=50'),
   get(root+'/actions/runs/'+p.ingest+'/attempts/'+p.attempt+'/jobs?per_page=100'),
   get(root+'/issues/'+p.issue)]);
  const [c1,c2]=await Promise.all([
   get(root+'/compare/'+p.sha+'...'+ingest.head_sha),
   get(root+'/compare/'+ingest.head_sha+'...'+target)]);
  const path=sourcePath(p),indexPath='indexes/by-sha/'+p.sha+'/acceptance/'+
   p.source+'-'+p.sourceAttempt+'-'+p.issue+'-'+p.criterion+'.json';
  const job=jobs.jobs?.filter(x=>x.name==='ingest');
  requireProof(job?.length===1,'no unique ingester job');
  const [record,index,log]=await Promise.all([
   get(root+'/contents/'+path+'?ref=acceptance-results'),
   get(root+'/contents/'+indexPath+'?ref=acceptance-results'),
   getText(root+'/actions/jobs/'+job[0].id+'/logs')]);
  result.push(verifyHistoricalReplay({p,target,source,ingest,merge,c1,c2,pulls,
   jobs,issue,log,record:readBlob(record,path),index:readBlob(index,indexPath)}));
 }
 return result;
}
export function selfTestHistoricalCase(){
 const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
 const [p]=pinnedCaseReplays('## Success Criteria\n- [ ] SC-03 Historical Case Replay Run 200 attempt 2 of Case Run 100 attempt 1 proving Issue #1792 SC-07 at '+a+'\n## Acceptance Plan');
 assert.equal(p.source,100);
 assert.throws(()=>pinnedCaseReplays('## Success Criteria\n- [ ] SC-03 Historical Case Replay Run bogus'));
 const run=(id,attempt,name,path,event,head_sha)=>({id,run_attempt:attempt,
  name,path,event,head_sha,head_branch:'main',status:'completed',conclusion:'success',
  repository:{full_name:'BestNathan/nession'},head_repository:{full_name:'BestNathan/nession'}});
 const source=run(100,1,'Acceptance / Cases','.github/workflows/acceptance-cases.yml','push',a);
 const ingest=run(200,2,'Acceptance / Case Ingest','.github/workflows/acceptance-case-ingest.yml','workflow_run',b);
 const path=sourcePath(p),record={kind:'acceptance_case_result',result:'Pass',run_id:100,
  run_attempt:1,issue:1792,criterion:'SC-07',target_sha:a,execution_id:'x',
  contract_sha256:'y',provenance:{record_path:path}};
 const steps=['Self-test trusted ingestion','Download source Case results',
  'Validate and prepare immutable records','Append compact immutable records and SHA indexes',
  'Project only currently eligible results'].map(name=>({name,status:'completed',conclusion:'success'}));
 const proof=x=>({status:'ahead',base_commit:{sha:x},merge_base_commit:{sha:x},ahead_by:1,behind_by:0});
 const x={p,target:c,source,ingest,merge:{sha:a,parents:[{sha:b},{sha:c}]},
  c1:proof(a),c2:proof(b),pulls:[{merged_at:'now',base:{ref:'main'},body:'Refs #1792'}],
  jobs:{jobs:[{name:'ingest',run_id:200,run_attempt:2,head_sha:b,conclusion:'success',steps}]},
  issue:{number:1792,state:'closed',body:'| SC-07 | Pass | run 100; ref '+a+'; source case-runner |'},
  record,index:{record:path,target_sha:a,source:{run_id:100,repository:'BestNathan/nession'},
   execution_id:'x',contract_sha256:'y'},
  log:'Projecting '+path+'\n{"projected":true,"changed":true}'};
 assert.equal(verifyHistoricalReplay(x).projection_changed,true);
 for(const delta of [{source:{...source,head_sha:c}},{c1:{...proof(a),status:'diverged'}},
  {record:{...record,result:'Fail'}},
  {log:'Projecting '+path+'\n{"projected":true,"changed":false}'},
  {issue:{...x.issue,state:'open'}}])assert.throws(()=>verifyHistoricalReplay({...x,...delta}));
}
