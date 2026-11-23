// #4297 / #4241: independent read-only orphan catalog + trusted GHCR evidence.
// The Issue, PR prose, model and OCI tag do not supply release authority.
// All pins below are independently checked against GitHub REST source/Jobs/logs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadedResult} from './acceptance-cross-issue-receipt.mjs';
import {extractSection,parseSuccessCriteria,parseAcceptanceReport} from './requirement-acceptance.mjs';
import {validateAcceptancePlan} from './acceptance-plan.mjs';

const REPO='BestNathan/nession', PREFIX='/repos/'+REPO;
const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const MAIN_ANCHOR='ff00fbd6b504ca2953293dce9ea4097fce9a3452';
const SC01_HEAD='729699a7bcbf1af074f1948f8d7491ca7c446324';
const SC01_PR=4266;
const SOURCE_ACCEPT_RUN=45105031223;
const OWNER_ACCEPT_COMMENT=7090587994;
const OWNER_ACCEPT_ACK=7090599215;
const OWNER_ACCEPT_RUN=45104919638;
const SOURCE_ACCEPT_HEAD='ff7c0818ea31142896b42ea5b8058375a8327702';
const CATALOG_FIRST='82881f5333d4bff1091beee8ce4e6d270aeead60';
const SOURCE_PRS=Object.freeze({
  4242:'d0e9a31036388007ae8a2a6dbe59a01115fca939',
  4243:'6415c79ea5418262b7cf4fb8ae2b601ff129672f',
  4244:'c1f9219af23da63553ef6b7235066b161efcb38e',
  4246:'d2783dbf4a836e4ecfe9e9cca81438e66952d466',
  4251:'6580c1e92192a70ba7626d949c87dd66152d5687',
  4257:'08b572f7547f50f79176138461964d063201865a',
  4272:'f66d31c9751565f13af0841e781b668371c5bb9b',
  4273:'fbe9c8daa0a40f41b69659068cefed9c75478f22',
  4277:'b6381e6b47c8f614e48ec5c3f9687384d781ed56',
  4295:'a93dddb2514e239baa06b24a4c04c696e495f4dc',
});
const RELEASES=Object.freeze([
  // name,version,run,catalog,sha256(build.sh),OCI Index,implementing PR (0 means #4160 baseline)
  ['gh','2.105.0',44721571308,CATALOG_FIRST,'e2c592c63a154e275401c10cd05ea7b2bb7652508583ad73a83d7623167b47d1','2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587',0],
  ['jq','1.8.1',44864365276,'dcd98846c7daead0ccbce664cfd23373f2fa30fa','d15f7fdf68d5dcdfe09ed91854d899594e81adc8f57a7dd77f198a101d6851bd','3f0d11626e8633fcb9eb3ea885fa3ccfb692a1292055b8d63608ba3343fd15a4',0],
  ['rust','1.96.0',44987103624,SOURCE_PRS[4251],'677030981dcfd65d43a2198f41b5c46226c305c02c497d485b3f76bb61ee7cae','ef5637081a2191262d92a7f780b19b8fece747294b9963ce198f21b1d9795587',4251],
  ['node','24.22.3',44986798782,SOURCE_PRS[4242],'5d32a9efa35babee9c290d0e60b2ffd13a865d506907de7f7befc565ea111db6','813e68563ecb87c626ec964cab85e70844231ca33a7baf339143c4955d92fa38',4242],
  ['node','22.23.5',44986798782,SOURCE_PRS[4242],'97a3e43a71723051f681ecf435ac3a9b257e09af2ae3516babb860874c18dadb','30202cb3aac092aa3fd61a5f8ca760aa9ed1669c6971a2ee88e3a0d19fe9d7c1',4242],
  ['git','2.56.0',45038935012,SOURCE_PRS[4295],'34cc44203a5b4a49e4a894c11cdf1452e1b8abb56678f74ce39234eb257cf169','7b40cf83f58e0907710405dec2e8ad6774ef1695b790809987d2b7c2bfd606ef',4257],
  ['rg','15.2.0',44985763088,SOURCE_PRS[4243],'2c896d990b8797ea1a1adfe847b93ff63e4a024b9ed0611f298e56f30f972ef8','1ed9f3eaacf9fb90673ab05dc70b91defd74a69fd6721f343d2020be65583c14',4243],
  ['just','1.59.0',44985763088,SOURCE_PRS[4243],'71dcb2f2c2298042add79481cbdf37be6194202230e50cc16a60eaf9129b746d','52275a52ace36ff6eabe677ffe55be81987bfc48245ae66c37c98d2a6690d065',4243],
  ['sccache','0.19.0',44985763088,SOURCE_PRS[4243],'60279e9b8a5d1e79848d03db1c0b54a12c36ad8e5a179d2b914c55e33a2f60a8','663c0f18ad1dab4dbe1e8cd0b7c54a32e32204aa242348fa5c5b9b9a5cbb93a7',4243],
  ['claude','2.1.330',44987552392,SOURCE_PRS[4246],'05755ca8cbbd63b4f9bb73f07210dec5ad601721de2275535ae5f8d45799ead9','67b868c42f4fbf52baffbd157f1306abb745a0d1a09e0f1e0b4b79fe1db55b24',4246],
  ['codex','0.171.0',44987552392,SOURCE_PRS[4246],'389429c53fcf26ce097e7e8722863bd55c2e26721504a32d1b4c857d53b732ab','f34ff2010d08cc8180b1c1e293bff006b2bcef8ad8dc4f673d7cc16c96345788',4246],
  ['kubectl','1.35.0',44986490415,SOURCE_PRS[4244],'43e2c119de178973e34ca97c8f71c5f318d3bdad49be651cc03ead463bf38911','fae382a25fde7648e37b906a3e8f006d2786e2e5f9331c9305ff231de7bed11b',4244],
  ['cf','1.0.0-rc.2',44988367094,SOURCE_PRS[4272],'ecff8dccfb41f42bdd0c63fa344a3cc76b7d1b959d3f5351ce2da218bded57d0','fa98b3e8fa0c3e5cfc9edd43c502dea6f911e008f84fbd0901f2abc0e1215a92',4272],
  ['ansible','2.22.0',45039534062,SOURCE_PRS[4273],'8b8ea597f89d9b002f12a88788f5ddca0661d47c09b1a911235d138707084b8c','08803ffc8924120056412eee4ad8c517cd00d15c8f1ff068c03919602135674e',4273],
]);
const ARCH=Object.freeze(['linux/amd64','linux/arm64']);
const denied=(condition,why)=>{if(!condition)throw Error('toolchain #4241 readback: '+why);};
const repoOwned=(obj)=>obj?.head?.repo?.full_name===REPO &&
  obj?.base?.repo?.full_name===REPO;
function ancestor(compare,base) {
  return compare?.base_commit?.sha===base &&
    compare?.merge_base_commit?.sha===base && compare?.behind_by===0 &&
    Number.isSafeInteger(compare.ahead_by) &&
    ['identical','ahead'].includes(compare.status);
}
function exactJob(jobs,run,name) {
  denied(Array.isArray(jobs?.jobs)&&jobs.jobs.length<=100,'incomplete Job list');
  const matches=jobs.jobs.filter(j=>j.name===name);
  denied(matches.length===1,'missing or duplicate job '+name);
  const j=matches[0];
  denied(Number.isSafeInteger(j.id)&&j.run_id===run.id&&
    (j.run_attempt==null||j.run_attempt===run.run_attempt)&&
    j.status==='completed'&&j.conclusion==='success','failed '+name);
  return j;
}
function attestPublisher(log,name,version,fingerprint,digest) {
  const ref='ghcr.io/bestnathan/nession-toolchain:'+name+'-'+version;
  denied(typeof log==='string'&&log.length<1048576,'unbounded Publisher log');
  denied(log.includes('TOOLCHAIN_FINGERPRINT: sha256:'+fingerprint),
    'missing exact build.sh fingerprint '+ref);
  denied(log.includes('Complete Toolchain OCI Index '+ref+'@sha256:'+digest),
    'missing immutable OCI Index '+ref);
  denied(/GHCR publish: uploaded=\d+ reused=\d+ manifests=\d+/.test(log),
    'missing actual GHCR upload/reuse receipt '+ref);
  for(const arch of ARCH) denied(log.includes('"'+arch+'"'),'missing OCI Index architecture '+arch);
}
function attestReadback(log,name,version,digest) {
  denied(typeof log==='string'&&log.length<1048576 &&
    log.includes('Independent OCI Index/Manifest/Config/EROFS readback PASS: '+
      'ghcr.io/bestnathan/nession-toolchain:'+name+'-'+version+'@sha256:'+digest),
    'missing independent remote raw EROFS/OCI readback '+name+' '+version);
}
function attestOrphan(pr,num,merge,commit,comparison,files) {
  denied(pr?.number===Number(num)&&pr.merge_commit_sha===merge&&
    pr.merged_at&&repoOwned(pr)&&pr.base.ref==='toolchains' &&
    pr.state==='closed' &&
    /(?:^|\n)Refs\s+#4241\b/i.test(String(pr.body??'')),
    'untrusted orphan PR association #'+num);
  denied(commit?.sha===merge&&commit.parents?.length===2,
    'orphan source must be a genuine two-parent merge #'+num);
  denied(ancestor(comparison,merge),'detached or stale orphan merge #'+num);
  denied(Array.isArray(files)&&files.length>0&&files.length<100 &&
    files.every(f=>/^[a-z][a-z0-9-]*\/[0-9][a-zA-Z0-9.-]*\/build\.sh$/.test(f.filename) &&
      ['added','modified'].includes(f.status)),'untrusted PR files #'+num);
  return {number:Number(num),merge_sha:merge,paths:files.map(f=>f.filename)};
}
function attestRecipe(file,fingerprint,name) {
  denied(file?.type==='file'&&file.encoding==='base64'&&
    typeof file.content==='string','unavailable immutable recipe '+name);
  const script=Buffer.from(file.content.replace(/\s/g,''),'base64');
  denied(script.length>0&&script.length<131072 &&
    createHash('sha256').update(script).digest('hex')===fingerprint,
    'tampered recipe script bytes '+name);
}
// Reuse the existing fully authenticated release proof for the specific
// closure Bug. No other Issue gets orphan-source or registry evidence.
export function shouldCollectToolchain4241(stage,issue) {
  return stage==='post-merge'&&['4241','4297'].includes(String(issue));
}

// #4297 SC-03: the parent closure receipt alone does not prove that the
// original Owner /accept crossed the new trusted orphan-source dispatch lane.
// Bind the immutable Owner comment, bot acknowledgment, trusted main Manual
// Request job/log, and the *actual* downstream Acceptance Run together.
// Nothing here is permission to update an Issue; only the normal projector
// can write a criterion. A reference in a comment or Agent answer alone is
// never accepted as a dispatch receipt.
export function attest4297OwnerManualDispatch(comment, ack, manual, jobs, log, acceptance) {
  const issueUrl='https://api.github.com/repos/'+REPO+'/issues/4241';
  const command='/accept post-merge '+MAIN_ANCHOR;
  denied(comment?.id===OWNER_ACCEPT_COMMENT &&
    comment.issue_url===issueUrl &&
    comment.body===command &&
    comment.user?.login==='BestNathan' && comment.user?.type==='User' &&
    comment.author_association==='OWNER' &&
    typeof comment.created_at==='string' &&
    comment.updated_at===comment.created_at,
    'unverified original Owner /accept source');
  denied(ack?.id===OWNER_ACCEPT_ACK && ack.issue_url===issueUrl &&
    ack.user?.login==='github-actions[bot]' && ack.user?.type==='Bot' &&
    ack.body?.startsWith('Comment command `'+command+'` accepted for Issue #4241.') &&
    ack.body.includes('https://github.com/'+REPO+'/actions/runs/'+OWNER_ACCEPT_RUN) &&
    ack.body.includes('<!-- nession-command-comment:'+OWNER_ACCEPT_COMMENT+' -->') &&
    typeof ack.created_at==='string' &&
    ack.created_at>=comment.created_at &&
    ack.updated_at===ack.created_at,
    'missing or spoofed Owner command router acknowledgment');
  denied(manual?.id===OWNER_ACCEPT_RUN && manual.run_attempt===1 &&
    manual.name==='Comment Accept #4241 comment:'+OWNER_ACCEPT_COMMENT &&
    manual.path==='.github/workflows/acceptance-manual-request.yml' &&
    manual.event==='workflow_dispatch' && manual.head_branch==='main' &&
    manual.head_sha===SOURCE_ACCEPT_HEAD &&
    manual.actor?.login==='github-actions[bot]' &&
    manual.triggering_actor?.login==='github-actions[bot]' &&
    manual.repository?.full_name===REPO &&
    manual.head_repository?.full_name===REPO &&
    manual.status==='completed' && manual.conclusion==='success' &&
    typeof manual.created_at==='string' &&
    manual.created_at>=comment.created_at &&
    ack.created_at>=manual.created_at,
    'untrusted Owner Manual Request Run/Attempt/source');
  const request=exactJob(jobs,manual,'request');
  denied(['Verify comment source and canonical Acceptance policy',
    'Reconcile or dispatch existing stage-qualified Agent Acceptance']
    .every(name=>request.steps?.filter(s=>s.name===name &&
      s.status==='completed' && s.conclusion==='success').length===1),
    'Manual Request source/dispatch steps not successful');
  denied(typeof log==='string' && log.length<131072 &&
    log.includes('Reconstructed authorized accept request for Issue #4241, comment '+
      OWNER_ACCEPT_COMMENT),
    'missing source-authenticated native Owner request log');
  const lines=log.split(/\r?\n/).map(line=>
    /^\d{4}-\d{2}-\d{2}T[^ ]+Z (\{.*\})$/.exec(line)?.[1])
    .filter(line=>line?.startsWith('{"action":'));
  denied(lines.length===1,'missing or ambiguous native dispatch result');
  let outcome;
  try { outcome=JSON.parse(lines[0]); } catch {
    throw Error('toolchain #4241 readback: malformed native dispatch result');
  }
  denied(outcome?.action==='dispatched' &&
    outcome.reason==='authenticated orphan catalog and publisher evidence' &&
    Array.isArray(outcome.agent_runs) && outcome.agent_runs.length===1 &&
    outcome.agent_runs[0]?.stage==='post-merge' &&
    outcome.agent_runs[0]?.target_ref===MAIN_ANCHOR &&
    acceptance?.id===SOURCE_ACCEPT_RUN && acceptance.run_attempt===1 &&
    acceptance.head_sha===SOURCE_ACCEPT_HEAD &&
    typeof acceptance.created_at==='string' &&
    acceptance.created_at>=manual.created_at,
    'native Manual Request did not dispatch original exact-target Acceptance');
  return {kind:'toolchain_4297_verified_owner_manual_dispatch',
    issue:4241,comment_id:OWNER_ACCEPT_COMMENT,ack_id:OWNER_ACCEPT_ACK,
    manual_run:OWNER_ACCEPT_RUN,manual_attempt:1,manual_job:request.id,
    dispatched_acceptance_run:SOURCE_ACCEPT_RUN,
    acceptance_target:MAIN_ANCHOR,main_dispatch_sha:SOURCE_ACCEPT_HEAD,
    authenticated_owner:'BestNathan',maximum_authority:'read_only_evidence'};
}

// A checked parent Issue is only a locator. The live closure transition,
// original Agent result ZIP, first-attempt jobs and original acceptance SHA
// must all agree. This attests history; only the canonical Agent may judge
// the child's SC and only the deterministic updater may mutate its rows.
export function attest4297ParentClosure(parent,events,run,jobs,artifact,result,
  sourceReachable,releaseEvidence) {
  denied(sourceReachable===true&&parent?.number===4241&&
    parent.state==='closed'&&parent.state_reason==='completed'&&
    typeof parent.closed_at==='string','parent not formally completed');
  const criteria=parseSuccessCriteria(extractSection(parent.body,'Success Criteria'));
  const report=parseAcceptanceReport(extractSection(parent.body,'Acceptance Report'));
  const plan=validateAcceptancePlan(parent.body,criteria.criteria.keys(),report.rows);
  denied(!criteria.errors.length&&!report.errors.length&&!plan.errors.length,
    'invalid parent Acceptance contract');
  for(const id of ['SC-01','SC-02','SC-03','SC-04','SC-05']){
    const prefix=id==='SC-01'
      ? 'run 44980355063; ref '+SC01_HEAD+'; source agent-qwen;'
      : 'run '+SOURCE_ACCEPT_RUN+'; ref '+MAIN_ANCHOR+'; source agent-qwen;';
    denied(criteria.criteria.get(id)?.checked===true&&
      report.rows.get(id)?.result==='Pass'&&
      String(report.rows.get(id).evidence).startsWith(prefix),
      'parent source/result mismatch '+id);
  }
  denied(Array.isArray(events)&&events.length<100&&
    events.filter(x=>x.event==='closed').length===1&&
    !events.some(x=>x.event==='reopened')&&
    events.some(x=>x.event==='closed'&&x.created_at===parent.closed_at&&
      x.actor?.login==='github-actions[bot]'),
    'unverified bot Issue closure');
  denied(run?.id===SOURCE_ACCEPT_RUN&&run.run_attempt===1&&
    run.name==='Agent / SC Acceptance'&&
    run.path==='.github/workflows/agent-sc-acceptance.yml'&&
    run.event==='workflow_dispatch'&&run.head_branch==='main'&&
    run.head_sha===SOURCE_ACCEPT_HEAD&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.status==='completed'&&run.conclusion==='success',
    'unverified parent Acceptance Run/Attempt');
  const executor=exactJob(jobs,run,'Execute acceptance');
  const updater=exactJob(jobs,run,'Deterministic Issue updater');
  for(const [job,names] of [
    [executor,['Collect trusted GitHub Actions evidence',
      'Run read-only Acceptance Agent','Upload structured Acceptance Result']],
    [updater,['Apply Acceptance Report and checkbox projection']],
  ])denied(job.run_attempt===1&&job.head_sha===SOURCE_ACCEPT_HEAD&&
    names.every(name=>job.steps?.filter(x=>x.name===name&&
      x.status==='completed'&&x.conclusion==='success').length===1),
    'missing canonical Acceptance/Issue updater steps');
  denied(artifact?.name==='acceptance-result-4241-post-merge-'+
      SOURCE_ACCEPT_RUN+'-1'&&artifact.expired===false&&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest??'')&&
    Number.isSafeInteger(artifact.id)&&artifact.id>0&&
    Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&
    artifact.size_in_bytes<=131072&&
    artifact.workflow_run?.id===SOURCE_ACCEPT_RUN&&
    artifact.workflow_run?.head_sha===SOURCE_ACCEPT_HEAD&&
    artifact.workflow_run?.repository_id===run.repository?.id,
    'unverified original Acceptance artifact');
  const required=['SC-02','SC-03','SC-04','SC-05'];
  denied(result?.schema_version===1&&result.issue===4241&&
    result.stage==='post-merge'&&result.run_id===SOURCE_ACCEPT_RUN&&
    result.target_ref===MAIN_ANCHOR&&result.source==='agent-qwen'&&
    /^[a-f0-9]{64}$/.test(result.contract_sha256??'')&&
    Array.isArray(result.selected_criteria)&&
    required.every(id=>result.selected_criteria.includes(id))&&
    Array.isArray(result.criteria)&&required.every(id=>
      result.criteria.filter(x=>x?.criterion===id&&x.result==='Pass').length===1),
    'original immutable Agent result incomplete or not Pass');
  denied(releaseEvidence?.published?.length===14&&
    new Set(releaseEvidence.published.map(x=>x.tool)).size===13,
    'independent GHCR/EROFS evidence incomplete');
  return {kind:'toolchain_4297_verified_parent_closure',
    parent_issue:4241,parent_closed_at:parent.closed_at,
    closure_actor:'github-actions[bot]',acceptance_run:SOURCE_ACCEPT_RUN,
    acceptance_attempt:1,acceptance_target:MAIN_ANCHOR,
    acceptance_executor_job:executor.id,acceptance_updater_job:updater.id,
    acceptance_artifact_id:artifact.id,
    acceptance_artifact_digest:artifact.digest,passed_sc:required,
    published:14,tools:13,maximum_authority:'read_only_evidence'};
}
export async function collectToolchain4241({repo,targetSha,stage,issue,get,getLog}) {
  denied(repo===REPO&&shouldCollectToolchain4241(stage,issue)&&SHA.test(targetSha),
    'wrong repository, Issue, stage or ref');
  denied(typeof get==='function'&&typeof getLog==='function','read-only readers required');
  const memo=new Map();
  const read=async path=>{
    if(!memo.has(path))memo.set(path,Promise.resolve().then(()=>get(path)));
    return memo.get(path);
  };
  // The Acceptance target is an authenticated protected main ancestor, not an
  // orphan SHA, untrusted comment-selected ref or arbitrary Git object.
  const [main,toolchains]=await Promise.all([
    read(PREFIX+'/branches/main'),read(PREFIX+'/branches/toolchains')]);
  const currentMain=main?.commit?.sha,currentCatalog=toolchains?.commit?.sha;
  denied(SHA.test(currentMain)&&SHA.test(currentCatalog),'missing protected live refs');
  denied(ancestor(await read(PREFIX+'/compare/'+targetSha+'...'+currentMain),targetSha),
    'target not on current main ancestry');
  denied(ancestor(await read(PREFIX+'/compare/'+MAIN_ANCHOR+'...'+targetSha),MAIN_ANCHOR),
    'target predates final trusted Publisher main baseline');
  // SC-01 is a separate previously accepted PR source. It is NOT authorized
  // by orphan release evidence or retroactively relabeled an implementation.
  const sc01=await read(PREFIX+'/pulls/'+SC01_PR);
  denied(sc01?.number===SC01_PR&&sc01?.head?.sha===SC01_HEAD &&
    sc01?.merged_at&&repoOwned(sc01)&&sc01.base.ref==='main'&&
    SHA.test(sc01.merge_commit_sha),'historical SC-01 source mismatch');
  denied(ancestor(await read(PREFIX+'/compare/'+sc01.merge_commit_sha+'...'+targetSha),
    sc01.merge_commit_sha),'SC-01 main source not on acceptance target ancestry');
  const uniquePrs=new Map();
  for(const [num,merge] of Object.entries(SOURCE_PRS)){
    const pr=await read(PREFIX+'/pulls/'+num);
    const commit=await read(PREFIX+'/commits/'+merge);
    const comparison=await read(PREFIX+'/compare/'+merge+'...'+currentCatalog);
    const files=await read(PREFIX+'/pulls/'+num+'/files?per_page=100');
    uniquePrs.set(Number(num),attestOrphan(pr,num,merge,commit,comparison,files));
  }
  const accepted=[];
  for(const [name,version,id,catalog,fingerprint,digest,primaryPr] of RELEASES) {
    denied(DIGEST.test(fingerprint)&&DIGEST.test(digest)&&SHA.test(catalog),
      'malformed pin');
    denied(ancestor(await read(PREFIX+'/compare/'+catalog+'...'+currentCatalog),catalog),
      'catalog source no longer on canonical orphan ancestry '+name);
    if(primaryPr) denied(uniquePrs.get(primaryPr)?.paths.includes(name+'/'+version+'/build.sh'),
      'unrelated orphan PR cannot implement '+name+' '+version);
    const file=await read(PREFIX+'/contents/'+name+'/'+version+'/build.sh?ref='+catalog);
    attestRecipe(file,fingerprint,name+' '+version);
    const run=await read(PREFIX+'/actions/runs/'+id);
    denied(run?.id===id&&run.run_attempt===1&&run.name==='Release / Toolchains'&&
      run.path==='.github/workflows/release-toolchains.yml'&&
      run.event==='workflow_run'&&run.head_branch==='main'&&
      run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
      run.status==='completed'&&run.conclusion==='success'&&SHA.test(run.head_sha),
      'untrusted Publisher Run/Attempt '+id);
    denied(ancestor(await read(PREFIX+'/compare/'+run.head_sha+'...'+targetSha),run.head_sha),
      'Publisher main source not on acceptance target '+id);
    const jobs=await read(PREFIX+'/actions/runs/'+id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    exactJob(jobs,run,'plan');
    const root='release ('+name+', '+version+') / ';
    for(const jobName of ['targets','probe','publish','readback'])exactJob(jobs,run,root+jobName);
    for(const arch of ARCH){
      const triplet=arch==='linux/amd64'?'linux, amd64, linux-amd64':'linux, arm64, linux-arm64';
      exactJob(jobs,run,root+'prepare ('+triplet+')');
      exactJob(jobs,run,root+'verify ('+triplet+')');
    }
    const plan=exactJob(jobs,run,'plan');
    const publish=exactJob(jobs,run,root+'publish');
    const readback=exactJob(jobs,run,root+'readback');
    const [planLog,publishLog,readbackLog]=await Promise.all([
      getLog(PREFIX+'/actions/jobs/'+plan.id+'/logs'),
      getLog(PREFIX+'/actions/jobs/'+publish.id+'/logs'),
      getLog(PREFIX+'/actions/jobs/'+readback.id+'/logs'),
    ]);
    denied(typeof planLog==='string'&&planLog.length<1048576&&
      new RegExp('Selected [1-9][0-9]* catalog versions at '+catalog+'\\b').test(planLog),
      'Run did not select exact catalog source '+id);
    attestPublisher(publishLog,name,version,fingerprint,digest);
    attestReadback(readbackLog,name,version,digest);
    accepted.push({tool:name,version,pr:primaryPr||null,run:id,attempt:run.run_attempt,
      source_sha:catalog,script_fingerprint:'sha256:'+fingerprint,
      index:'sha256:'+digest,platforms:[...ARCH],publish_job:publish.id,
      readback_job:readback.id});
  }
  denied(accepted.length===14&&new Set(accepted.map(x=>x.tool)).size===13,
    'incomplete user-selected distribution matrix');
  let linkedClosure=null;
  if(String(issue)==='4297'){
    const [parent,events,run,jobs,artifacts,comparison,
      ownerComment,ownerAck,manual,manualJobs]=await Promise.all([
      read(PREFIX+'/issues/4241'),
      read(PREFIX+'/issues/4241/events?per_page=100'),
      read(PREFIX+'/actions/runs/'+SOURCE_ACCEPT_RUN+'/attempts/1'),
      read(PREFIX+'/actions/runs/'+SOURCE_ACCEPT_RUN+'/attempts/1/jobs?per_page=100'),
      read(PREFIX+'/actions/runs/'+SOURCE_ACCEPT_RUN+'/artifacts?per_page=100'),
      read(PREFIX+'/compare/'+SOURCE_ACCEPT_HEAD+'...'+targetSha),
      read(PREFIX+'/issues/comments/'+OWNER_ACCEPT_COMMENT),
      read(PREFIX+'/issues/comments/'+OWNER_ACCEPT_ACK),
      read(PREFIX+'/actions/runs/'+OWNER_ACCEPT_RUN+'/attempts/1'),
      read(PREFIX+'/actions/runs/'+OWNER_ACCEPT_RUN+'/attempts/1/jobs?per_page=100'),
    ]);
    denied(Array.isArray(artifacts?.artifacts)&&artifacts.artifacts.length<100,
      'incomplete parent Acceptance artifact listing');
    const matches=artifacts.artifacts.filter(a=>
      a.name==='acceptance-result-4241-post-merge-'+SOURCE_ACCEPT_RUN+'-1');
    denied(matches.length===1,'missing/ambiguous original Acceptance artifact');
    const result=await downloadedResult(REPO,matches[0],
      process.env.GH_TOKEN??process.env.GITHUB_TOKEN);
    const manualRequest=exactJob(manualJobs,manual,'request');
    const manualLog=await getLog(PREFIX+'/actions/jobs/'+manualRequest.id+'/logs');
    const ownerDispatch=attest4297OwnerManualDispatch(ownerComment,ownerAck,
      manual,manualJobs,manualLog,run);
    linkedClosure={...attest4297ParentClosure(parent,events,run,jobs,matches[0],
      result,ancestor(comparison,SOURCE_ACCEPT_HEAD),{published:accepted}),
      owner_manual_dispatch:ownerDispatch};
  }
  return {kind:'verified_toolchain_4241_readonly',issue:4241,target_sha:targetSha,
    ...(linkedClosure ? {verified_4297_parent_closure:linkedClosure} : {}),
    catalog_head:currentCatalog,main_source:MAIN_ANCHOR,
    historical_sc01:{pr:SC01_PR,head_sha:SC01_HEAD,merge_sha:sc01.merge_commit_sha},
    orphan_prs:[...uniquePrs.values()],published:accepted,
    // This is source evidence for the independent Agent. It is NOT an SC verdict.
    maximum_authority:'read_only_evidence'};
}
export function selfTestToolchain4241() {
  assert.equal(shouldCollectToolchain4241('post-merge',4241),true);
  assert.equal(shouldCollectToolchain4241('pr',4241),false);
  assert.equal(shouldCollectToolchain4241('post-merge',4297),true);
  assert.equal(shouldCollectToolchain4241('pr',4297),false);
  assert.equal(shouldCollectToolchain4241('post-merge',4298),false);
  const valid={id:17,run_attempt:1};
  assert.equal(exactJob({jobs:[{id:20,run_id:17,name:'publish',
    status:'completed',conclusion:'success'}]},valid,'publish').id,20);
  assert.throws(()=>exactJob({jobs:[{id:20,run_id:17,name:'publish',
    status:'completed',conclusion:'skipped'}]},valid,'publish'),/failed/);
  assert.throws(()=>exactJob({jobs:[]},valid,'publish'),/missing/);
  assert.equal(ancestor({base_commit:{sha:'a'.repeat(40)},merge_base_commit:{sha:'a'.repeat(40)},
    behind_by:0,ahead_by:1,status:'ahead'},'a'.repeat(40)),true);
  assert.equal(ancestor({base_commit:{sha:'a'.repeat(40)},merge_base_commit:{sha:'b'.repeat(40)},
    behind_by:0,ahead_by:1,status:'ahead'},'a'.repeat(40)),false);
  const good='TOOLCHAIN_FINGERPRINT: sha256:'+RELEASES[0][4]+
    '\nComplete Toolchain OCI Index ghcr.io/bestnathan/nession-toolchain:gh-2.105.0@sha256:'+
    RELEASES[0][5]+' platforms={"linux/amd64", "linux/arm64"}\n'+
    'GHCR publish: uploaded=1 reused=2 manifests=3';
  attestPublisher(good,'gh','2.105.0',RELEASES[0][4],RELEASES[0][5]);
  assert.throws(()=>attestPublisher(good,'gh','2.105.0','a'.repeat(64),RELEASES[0][5]),
    /fingerprint/);
  assert.throws(()=>attestPublisher(good.replace('linux/arm64','linux/riscv64'),
    'gh','2.105.0',RELEASES[0][4],RELEASES[0][5]),/architecture/);
  assert.throws(()=>attestReadback('success','gh','2.105.0',RELEASES[0][5]),
    /readback/);
  // Real source selectors are tested against forged mentions, foreign stores,
  // detached ancestry, invalid merge parent count, and malicious file paths.
  const merge=SOURCE_PRS[4242],other='a'.repeat(40);
  const sameRepo={full_name:REPO};
  const pr={number:4242,merge_commit_sha:merge,
    merged_at:'2026-11-22T00:00:00Z',state:'closed',body:'Refs #4241',
    head:{repo:sameRepo},base:{repo:sameRepo,ref:'toolchains'}};
  const commit={sha:merge,parents:[{sha:'b'.repeat(40)},{sha:'c'.repeat(40)}]};
  const cmp={base_commit:{sha:merge},merge_base_commit:{sha:merge},
    ahead_by:1,behind_by:0,status:'ahead'};
  const files=[{filename:'node/24.22.3/build.sh',status:'added'}];
  assert.equal(attestOrphan(pr,4242,merge,commit,cmp,files).number,4242);
  assert.throws(()=>attestOrphan({...pr,body:'Refs #9999'},4242,merge,commit,cmp,files),/association/);
  assert.throws(()=>attestOrphan({...pr,base:{repo:sameRepo,ref:'gitops'}},
    4242,merge,commit,cmp,files),/association/);
  assert.throws(()=>attestOrphan({...pr,head:{repo:{full_name:'other/repo'}}},
    4242,merge,commit,cmp,files),/association/);
  assert.throws(()=>attestOrphan({...pr,merge_commit_sha:other},
    4242,merge,commit,cmp,files),/association/);
  assert.throws(()=>attestOrphan(pr,4242,merge,
    {...commit,parents:[...commit.parents,{sha:'d'.repeat(40)}]},cmp,files),/two-parent/);
  assert.throws(()=>attestOrphan(pr,4242,merge,commit,
    {...cmp,merge_base_commit:{sha:other}},files),/stale/);
  assert.throws(()=>attestOrphan(pr,4242,merge,commit,cmp,
    [{filename:'scripts/evil.sh',status:'added'}]),/files/);
  const script='#!/bin/sh\necho fixture\n';
  const fingerprint=createHash('sha256').update(script).digest('hex');
  const file={type:'file',encoding:'base64',content:Buffer.from(script).toString('base64')};
  attestRecipe(file,fingerprint,'fixture');
  assert.throws(()=>attestRecipe(file,'a'.repeat(64),'fixture'),/tampered/);
  assert.throws(()=>attestRecipe({...file,content:'!!!'},fingerprint,'fixture'),/tampered/);
  // Source-verified Issue closure cannot be inferred from Release runs alone.
  const sc=['SC-01','SC-02','SC-03','SC-04','SC-05'];
  const fence=String.fromCharCode(96).repeat(3);
  const fixtureBody='## Success Criteria\n'+sc.map(id=>'- [x] '+id+' done').join('\n')+
    '\n\n## Acceptance Plan\n'+fence+'yaml\nacceptance:\n'+
    sc.map(id=>'  '+id+':\n    when: '+(id==='SC-01'?'pr':'merged')+'\n'+
      (id==='SC-01'?'':'    branch: main\n')+'    method: agent').join('\n')+
    '\n'+fence+'\n\n## Acceptance Report\n'+
    '| Criterion | Result | Evidence |\n| --- | --- | --- |\n'+
    sc.map(id=>'| '+id+' | Pass | run '+(id==='SC-01'?44980355063:SOURCE_ACCEPT_RUN)+
      '; ref '+(id==='SC-01'?SC01_HEAD:MAIN_ANCHOR)+
      '; source agent-qwen; independent verified result |').join('\n');
  const closedAt='2026-11-23T03:20:42Z';
  const parent={number:4241,body:fixtureBody,state:'closed',
    state_reason:'completed',closed_at:closedAt};
  const events=[{event:'closed',created_at:closedAt,
    actor:{login:'github-actions[bot]'}}];
  const run={id:SOURCE_ACCEPT_RUN,run_attempt:1,name:'Agent / SC Acceptance',
    path:'.github/workflows/agent-sc-acceptance.yml',event:'workflow_dispatch',
    head_branch:'main',head_sha:SOURCE_ACCEPT_HEAD,status:'completed',
    conclusion:'success',repository:{id:19,full_name:REPO},
    head_repository:{full_name:REPO}};
  const job=(name,id,steps)=>({name,id,run_id:SOURCE_ACCEPT_RUN,
    run_attempt:1,head_sha:SOURCE_ACCEPT_HEAD,status:'completed',
    conclusion:'success',steps:steps.map(name=>({name,status:'completed',
      conclusion:'success'}))});
  const execute=job('Execute acceptance',21,[
    'Collect trusted GitHub Actions evidence','Run read-only Acceptance Agent',
    'Upload structured Acceptance Result']);
  const update=job('Deterministic Issue updater',22,
    ['Apply Acceptance Report and checkbox projection']);
  const jobs={jobs:[execute,update]};
  const artifact={id:23,digest:'sha256:'+'a'.repeat(64),
    name:'acceptance-result-4241-post-merge-'+SOURCE_ACCEPT_RUN+'-1',
    expired:false,size_in_bytes:900,workflow_run:{id:SOURCE_ACCEPT_RUN,
      head_sha:SOURCE_ACCEPT_HEAD,repository_id:19}};
  const result={schema_version:1,issue:4241,stage:'post-merge',
    run_id:SOURCE_ACCEPT_RUN,target_ref:MAIN_ANCHOR,source:'agent-qwen',
    contract_sha256:'b'.repeat(64),selected_criteria:sc.slice(1),
    criteria:sc.slice(1).map(criterion=>({criterion,result:'Pass'}))};
  const release={published:RELEASES.map(([tool,version])=>({tool,version}))};
  const verify=(...args)=>attest4297ParentClosure(...args);
  assert.equal(verify(parent,events,run,jobs,artifact,result,true,release).published,14);
  for(const args of [
    [{...parent,state:'open'},events,run,jobs,artifact,result,true,release],
    [parent,[{...events[0],actor:{login:'BestNathan'}}],
      run,jobs,artifact,result,true,release],
    [parent,events,{...run,run_attempt:2},jobs,artifact,result,true,release],
    [parent,events,run,{jobs:[execute]},artifact,result,true,release],
    [parent,events,run,jobs,{...artifact,digest:'invalid'},result,true,release],
    [parent,events,run,jobs,artifact,
      {...result,criteria:result.criteria.slice(1)},true,release],
    [parent,events,run,jobs,artifact,result,false,release],
    [parent,events,run,jobs,artifact,result,true,
      {published:release.published.slice(1)}],
  ])assert.throws(()=>verify(...args),/toolchain #4241 readback/);
  // The formal SC-03 source is the Owner comment -> bot ack ->
  // authenticated Manual Request -> actual first-attempt Agent dispatch.
  // An unrelated/forged comment or a green Manual Job without a real
  // authorized dispatch must never qualify the parent Issue.
  const originalTime='2026-11-23T03:15:02Z';
  const issueUrl='https://api.github.com/repos/'+REPO+'/issues/4241';
  const command='/accept post-merge '+MAIN_ANCHOR;
  const ownerComment={id:OWNER_ACCEPT_COMMENT,issue_url:issueUrl,
    body:command,user:{login:'BestNathan',type:'User'},
    author_association:'OWNER',created_at:originalTime,updated_at:originalTime};
  const ackTime='2026-11-23T03:15:49Z';
  const ownerAck={id:OWNER_ACCEPT_ACK,issue_url:issueUrl,
    body:'Comment command `'+command+'` accepted for Issue #4241. '+
      '[Actions run](https://github.com/'+REPO+'/actions/runs/'+OWNER_ACCEPT_RUN+
      '). This request is not an Acceptance Pass.\n\n'+
      '<!-- nession-command-comment:'+OWNER_ACCEPT_COMMENT+' -->',
    user:{login:'github-actions[bot]',type:'Bot'},
    created_at:ackTime,updated_at:ackTime};
  const ownerManual={id:OWNER_ACCEPT_RUN,run_attempt:1,
    name:'Comment Accept #4241 comment:'+OWNER_ACCEPT_COMMENT,
    path:'.github/workflows/acceptance-manual-request.yml',
    event:'workflow_dispatch',head_branch:'main',head_sha:SOURCE_ACCEPT_HEAD,
    actor:{login:'github-actions[bot]'},
    triggering_actor:{login:'github-actions[bot]'},
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success',created_at:'2026-11-23T03:15:42Z'};
  const requestJob={id:27,run_id:OWNER_ACCEPT_RUN,name:'request',
    status:'completed',conclusion:'success',
    steps:['Verify comment source and canonical Acceptance policy',
      'Reconcile or dispatch existing stage-qualified Agent Acceptance']
      .map(name=>({name,status:'completed',conclusion:'success'}))};
  const manualJobs={jobs:[requestJob]};
  const dispatchLog='2026-11-23T03:16:13.0077356Z Reconstructed authorized '+
    'accept request for Issue #4241, comment '+OWNER_ACCEPT_COMMENT+'\n'+
    '2026-11-23T03:16:51.8532976Z '+
    JSON.stringify({action:'dispatched',
      reason:'authenticated orphan catalog and publisher evidence',
      agent_runs:[{stage:'post-merge',target_ref:MAIN_ANCHOR}]});
  const acceptance={...run,created_at:'2026-11-23T03:16:51Z'};
  const receipt=attest4297OwnerManualDispatch(ownerComment,ownerAck,
    ownerManual,manualJobs,dispatchLog,acceptance);
  assert.equal(receipt.dispatched_acceptance_run,SOURCE_ACCEPT_RUN);
  assert.equal(receipt.manual_run,OWNER_ACCEPT_RUN);
  for(const fields of [
    [{...ownerComment,body:'/accept post-merge '+'b'.repeat(40)},ownerAck,
      ownerManual,manualJobs,dispatchLog,acceptance],
    [{...ownerComment,user:{login:'attacker',type:'User'}},ownerAck,
      ownerManual,manualJobs,dispatchLog,acceptance],
    [{...ownerComment,updated_at:'2026-11-23T03:15:59Z'},ownerAck,
      ownerManual,manualJobs,dispatchLog,acceptance],
    [ownerComment,{...ownerAck,body:'forged ack'},
      ownerManual,manualJobs,dispatchLog,acceptance],
    [ownerComment,ownerAck,{...ownerManual,run_attempt:2},
      manualJobs,dispatchLog,acceptance],
    [ownerComment,ownerAck,ownerManual,
      {jobs:[{...requestJob,conclusion:'failure'}]},dispatchLog,acceptance],
    [ownerComment,ownerAck,ownerManual,manualJobs,
      dispatchLog.replace('"action":"dispatched"','"action":"pending"'),acceptance],
    [ownerComment,ownerAck,ownerManual,manualJobs,
      dispatchLog+'\n'+dispatchLog.split('\n')[1],acceptance],
    [ownerComment,ownerAck,ownerManual,manualJobs,
      dispatchLog.replace(MAIN_ANCHOR,'a'.repeat(40)),acceptance],
    [ownerComment,ownerAck,ownerManual,manualJobs,
      dispatchLog,{...acceptance,created_at:'2026-11-23T03:14:00Z'}],
  ]) assert.throws(()=>attest4297OwnerManualDispatch(...fields),
    /toolchain #4241 readback/, 'forged, incomplete or stale Owner dispatch is rejected');
  assert.equal(RELEASES.length,14);
  console.log('toolchain #4241: trusted catalog/Run/Index/JOB negative fixtures passed');
  return true;
}
