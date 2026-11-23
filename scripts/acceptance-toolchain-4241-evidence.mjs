// #4297 / #4241: independent read-only orphan catalog + trusted GHCR evidence.
// The Issue, PR prose, model and OCI tag do not supply release authority.
// All pins below are independently checked against GitHub REST source/Jobs/logs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const REPO='BestNathan/nession', PREFIX='/repos/'+REPO;
const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const MAIN_ANCHOR='ff00fbd6b504ca2953293dce9ea4097fce9a3452';
const SC01_HEAD='729699a7bcbf1af074f1948f8d7491ca7c446324';
const SC01_PR=4266;
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
export function shouldCollectToolchain4241(stage,issue) {
  return stage==='post-merge'&&String(issue)==='4241';
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
    denied(pr?.number===Number(num)&&pr.merge_commit_sha===merge&&
      pr.merged_at&&repoOwned(pr)&&pr.base.ref==='toolchains' &&
      pr.state==='closed' &&
      /(?:^|\n)Refs\s+#4241\b/i.test(String(pr.body??'')),
      'untrusted orphan PR association #'+num);
    const commit=await read(PREFIX+'/commits/'+merge);
    denied(commit?.sha===merge&&commit.parents?.length===2,
      'orphan source must be a genuine two-parent merge #'+num);
    denied(ancestor(await read(PREFIX+'/compare/'+merge+'...'+currentCatalog),merge),
      'detached or stale orphan merge #'+num);
    const files=await read(PREFIX+'/pulls/'+num+'/files?per_page=100');
    denied(Array.isArray(files)&&files.length>0&&files.length<100 &&
      files.every(f=>/^[a-z][a-z0-9-]*\/[0-9][a-zA-Z0-9.-]*\/build\.sh$/.test(f.filename) &&
        ['added','modified'].includes(f.status)),'untrusted PR files #'+num);
    uniquePrs.set(Number(num),{number:Number(num),merge_sha:merge,
      paths:files.map(f=>f.filename)});
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
    denied(file?.type==='file'&&file.encoding==='base64'&&
      typeof file.content==='string','unavailable immutable recipe '+name);
    const script=Buffer.from(file.content.replace(/\s/g,''),'base64');
    denied(script.length>0&&script.length<131072 &&
      createHash('sha256').update(script).digest('hex')===fingerprint,
      'tampered recipe script bytes '+name+' '+version);
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
  return {kind:'verified_toolchain_4241_readonly',issue:4241,target_sha:targetSha,
    catalog_head:currentCatalog,main_source:MAIN_ANCHOR,
    historical_sc01:{pr:SC01_PR,head_sha:SC01_HEAD,merge_sha:sc01.merge_commit_sha},
    orphan_prs:[...uniquePrs.values()],published:accepted,
    // This is source evidence for the independent Agent. It is NOT an SC verdict.
    maximum_authority:'read_only_evidence'};
}
export function selfTestToolchain4241() {
  assert.equal(shouldCollectToolchain4241('post-merge',4241),true);
  assert.equal(shouldCollectToolchain4241('pr',4241),false);
  assert.equal(shouldCollectToolchain4241('post-merge',4297),false);
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
  assert.equal(RELEASES.length,14);
  console.log('toolchain #4241: trusted catalog/Run/Index/JOB negative fixtures passed');
  return true;
}
