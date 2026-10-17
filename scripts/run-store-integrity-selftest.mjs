import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {classifyRunStorePath,validateRunStoreChange,auditStagedRunStore,
  auditAnchoredRunStore,RUN_STORE_REFS} from './run-store-integrity.mjs';

function run(root,...args){
  return execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function makeRepo() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-run-integrity-'));
  run(root,'init','-q');
  run(root,'config','user.name','Nession Integrity Fixture');
  run(root,'config','user.email','fixture@example.invalid');
  return root;
}
function write(root,name,content) {
  const dest=path.join(root,name);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,content);
}
function commit(root,msg){
  run(root,'add','-A');run(root,'commit','-qm',msg);return run(root,'rev-parse','HEAD');
}
// A writable Store publisher cannot safely accept workflow_dispatch from an
// arbitrary ref. No YAML job-level if can protect a modified workflow version
// selected from the attacker-controlled ref, so disable manual dispatch until
// server-enforced trusted writer identity/Rulesets are provisioned (#1690).
// #1789 review 2026-10-17: ENUMERATE the declared triggers, jobs and per-job
// permissions instead of textual-matching for two banned trigger names. An
// accidental `push:`/`pull_request_target:` trigger, an extra job, or a write
// permission on any job other than the publisher must fail closed rather than
// slip past a regex that only knows the names it was written to look for.
const REPOSITORY_METRICS_ALLOWED_TRIGGERS=Object.freeze(['schedule','workflow_run']);
const REPOSITORY_METRICS_ALLOWED_JOBS=Object.freeze(['authorize-replay','rust-health',
  'web-health','e2e-health','publish']);
const REPOSITORY_METRICS_WRITER_JOB='publish';
// The most the publisher may ever hold. Every declared entry must equal this
// value; an added key or a widened scope fails.
const REPOSITORY_METRICS_WRITER_CEILING=Object.freeze({actions:'read',
  contents:'write',issues:'read','pull-requests':'read'});
// Bounded structural helpers. They intentionally understand only the shapes this
// workflow is allowed to have and fail closed everywhere else.
function columnZeroBlock(text,key){
  const lines=String(text).split('\n');
  const start=lines.findIndex(line=>new RegExp('^'+key+':').test(line));
  if(start<0)return null;
  const out=[];
  for(let i=start+1;i<lines.length;i+=1){
    const line=lines[i];
    if(line.trim()===''||line.startsWith('#')){out.push(line);continue;}
    if(/^\S/.test(line))break; // next column-0 key
    out.push(line);
  }
  return out.join('\n');
}
function keysAt(blockText,indent){
  const re=new RegExp('^'+' '.repeat(indent)+'([A-Za-z0-9_.-]+):');
  return String(blockText??'').split('\n').map(line=>line.match(re)?.[1]).filter(Boolean);
}
function jobBodies(workflow){
  const jobs=columnZeroBlock(workflow,'jobs');
  if(jobs===null)throw new Error('missing Metrics jobs block');
  const bodies=new Map();
  let current=null;
  for(const line of jobs.split('\n')){
    const key=line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
    if(key){current=key[1];bodies.set(current,[]);continue;}
    if(current)bodies.get(current).push(line);
  }
  return new Map([...bodies].map(([name,lines])=>[name,lines.join('\n')]));
}
function permissionBlocks(jobBody){
  const lines=String(jobBody).split('\n');
  const blocks=[];
  for(let i=0;i<lines.length;i+=1){
    if(!/^    permissions:\s*$/.test(lines[i]))continue;
    const entries=new Map();
    for(let j=i+1;j<lines.length;j+=1){
      if(lines[j].trim()==='')continue;
      const entry=lines[j].match(/^      ([a-z-]+):\s*(\S+)\s*$/);
      if(!entry)break;
      entries.set(entry[1],entry[2]);
    }
    blocks.push(entries);
  }
  return blocks;
}
function verifyRepositoryMetricsTrustedSource(workflow) {
  const triggerText=columnZeroBlock(workflow,'on')??'';
  const triggers=keysAt(triggerText,2);
  const unexpectedTrigger=triggers.find(name=>!REPOSITORY_METRICS_ALLOWED_TRIGGERS.includes(name));
  if(unexpectedTrigger||triggers.length!==REPOSITORY_METRICS_ALLOWED_TRIGGERS.length)
    throw new Error('repository Metrics source must be scheduled or default-main attested-only: unexpected trigger '+
      (unexpectedTrigger??('count '+triggers.length)));
  // The trigger bodies themselves must still name the Replay Request workflow.
  if(!/^  schedule:\s*$/m.test(triggerText) ||
      !/^  workflow_run:\s*\n    workflows: \["Metrics \/ Replay Request"\]\s*\n    types: \[completed\]/m.test(triggerText)) {
    throw new Error('repository Metrics source must be scheduled or default-main attested-only: trigger body drift');
  }
  // Workflow-level default token: every declared scope must be read.
  const workflowPermissions=(columnZeroBlock(workflow,'permissions')??'').split('\n')
    .map(line=>line.match(/^  ([a-z-]+):\s*(\S+)\s*$/)).filter(Boolean).map(m=>[m[1],m[2]]);
  if(!workflowPermissions.length||workflowPermissions.some(([,value])=>value!=='read')) {
    throw new Error('repository Metrics source must be read-only by default');
  }
  const bodies=jobBodies(workflow);
  const unexpectedJob=[...bodies.keys()].find(name=>!REPOSITORY_METRICS_ALLOWED_JOBS.includes(name));
  const missingJob=REPOSITORY_METRICS_ALLOWED_JOBS.find(name=>!bodies.has(name));
  if(unexpectedJob||missingJob||bodies.size!==REPOSITORY_METRICS_ALLOWED_JOBS.length)
    throw new Error('unsafe Metrics source job: '+
      (unexpectedJob?'unexpected job '+unexpectedJob:'missing job '+missingJob));
  // Per-job ceiling: only the publisher may declare write, and exactly once.
  for(const [name,body] of bodies){
    const blocks=permissionBlocks(body);
    if(blocks.length>1)
      throw new Error('Metrics writer contents:write must be scoped to publish only: duplicate permissions in '+name);
    if(name===REPOSITORY_METRICS_WRITER_JOB)continue;
    const declared=blocks[0];
    if(declared&&[...declared.values()].some(value=>value!=='read'))
      throw new Error('Metrics writer contents:write must be scoped to publish only: job '+name);
  }
  const writerBlocks=permissionBlocks(bodies.get(REPOSITORY_METRICS_WRITER_JOB)??'');
  if(writerBlocks.length!==1)
    throw new Error('Metrics writer contents:write must be scoped to publish only: publish permission count');
  const writerPermissions=writerBlocks[0];
  const outsideCeiling=[...writerPermissions].find(([key,value])=>REPOSITORY_METRICS_WRITER_CEILING[key]!==value);
  if(outsideCeiling||writerPermissions.get('contents')!=='write')
    throw new Error('Metrics writer contents:write must be scoped to publish only: '+
      (outsideCeiling?('unexpected permission '+outsideCeiling[0]):'contents must be write'));
  const auth=workflow.split(/^  authorize-replay:\s*$/m)[1]?.split(/^  rust-health:\s*$/m)[0]??'';
  if(!auth.includes("github.event_name == 'schedule' || github.event_name == 'workflow_run'") ||
      !auth.includes('node scripts/metrics-replay-source.mjs authorize')||
      !/^\s+permissions:\s*\n\s+contents: read\s*\n\s+actions: read\s*$/m.test(auth)||
      !auth.includes('persist-credentials: false')){
    throw new Error('Metrics authorization must be read-only and main-source-attested');
  }
  for(const job of ['rust-health','web-health','e2e-health','publish']) {
    const jobPrefix='\n  '+job+':\n';
    const start=workflow.indexOf(jobPrefix);
    if(start<0)throw new Error('missing Metrics source job '+job);
    const jobBody=workflow.slice(start+jobPrefix.length);
    const line=jobBody.split(/^  [a-z][a-z0-9-]*:/m)[0]
      .split(/^    steps:/m)[0];
    for(const constraint of ["needs.authorize-replay.result == 'success'",
      "github.ref == 'refs/heads/main'",
      "github.repository == 'BestNathan/nession'"]) {
      if(!line.includes(constraint))throw new Error('unsafe Metrics source job '+job);
    }
    if(job==='publish'&&!line.includes('needs: [authorize-replay, rust-health, web-health, e2e-health]'))
      throw new Error('unsafe Metrics source job '+job);
    if(job!=='publish'&&!line.includes('needs: authorize-replay'))
      throw new Error('unsafe Metrics source job '+job);
  }
  const writer=workflow.split(/^  publish:\s*$/m)[1]??'';
  if((writer.match(/^    permissions:/gm)||[]).length!==1 ||
      !/^\s+permissions:\s*\n      actions: read\s*\n      contents: write\s*$/m.test(writer)) {
    throw new Error('Metrics writer contents:write must be scoped to publish only');
  }
  if(!writer.includes('node "${GITHUB_WORKSPACE}/scripts/run-store-integrity.mjs" staged metrics "${GITHUB_WORKSPACE}/metrics-store"')) {
    throw new Error('trusted Metrics publisher omitted staged Run Store integrity validation');
  }
  return true;
}
const repoMetricsYml=fs.readFileSync('.github/workflows/metrics-repository.yml','utf8');
assert.equal(verifyRepositoryMetricsTrustedSource(repoMetricsYml),true);
assert.throws(()=>verifyRepositoryMetricsTrustedSource(
  repoMetricsYml.replace(/^  schedule:/m,'  workflow_dispatch:\n  schedule:')
),/attested-only/);
assert.throws(()=>verifyRepositoryMetricsTrustedSource(
  repoMetricsYml.replace('  contents: read','  contents: write')
),/read-only/);
assert.throws(()=>verifyRepositoryMetricsTrustedSource(
  repoMetricsYml.replace("needs.authorize-replay.result == 'success' && github.ref",
    "github.event_name == 'workflow_dispatch' && github.ref")
),/unsafe Metrics source/);
assert.throws(()=>verifyRepositoryMetricsTrustedSource(
  repoMetricsYml.replace('  publish:\n','  publish:\n    permissions:\n      contents: write\n')
),/unsafe Metrics source|scoped to publish/);
assert.throws(()=>verifyRepositoryMetricsTrustedSource(
  repoMetricsYml.replace('node "${GITHUB_WORKSPACE}/scripts/run-store-integrity.mjs" staged metrics "${GITHUB_WORKSPACE}/metrics-store"',
    'echo "skip staged audit"')
),/omitted staged Run Store integrity/);
// #1789 review 2026-10-17: the verifier must ENUMERATE triggers, jobs and
// per-job permissions. These fixtures are the ones a name-matching check could
// not have caught: an added trigger it never looked for, an added job, and a
// widened permission scope.
for(const [label,mutation] of [
  ['push trigger',yml=>yml.replace(/^  schedule:/m,'  push:\n  schedule:')],
  ['pull_request_target trigger',yml=>yml.replace(/^  schedule:/m,'  pull_request_target:\n  schedule:')],
  ['extra job',yml=>yml.replace(/^  publish:\s*$/m,'  quiet-writer:\n    runs-on: ubuntu-latest\n  publish:')],
  ['write permission on a health job',yml=>yml.replace(
    /^(  rust-health:[\s\S]*?)\n    steps:/m,'$1\n    permissions:\n      contents: write\n    steps:')],
  ['extra permission key on the publisher',yml=>yml.replace(
    '      contents: write\n','      contents: write\n      packages: write\n')],
  ['duplicate publisher permission block',yml=>yml.replace(
    /^(  publish:[\s\S]*?)    steps:/m,'$1    permissions:\n      contents: read\n    steps:')],
]){
  assert.throws(()=>verifyRepositoryMetricsTrustedSource(mutation(repoMetricsYml)),
    /attested-only|unsafe Metrics source|scoped to publish/,label+' must be rejected');
}
// Positive counterexample: the real workflow still passes after the hardening.
assert.equal(verifyRepositoryMetricsTrustedSource(repoMetricsYml),true);

const A='acceptance-results',T='task-results',M='metrics',S='agent-store';
assert.deepEqual(RUN_STORE_REFS,[A,T,M,S]);
assert.equal(classifyRunStorePath(M,'raw/workflows/canary/2026-10-13/1-1.json'),'immutable');
assert.equal(classifyRunStorePath(M,'agent-metrics.json'),'projection');
assert.equal(classifyRunStorePath(S,'roles/developer/dev-qwen-01/issues/1664/head.json'),'cas-pointer');
assert.equal(classifyRunStorePath(S,'workflows/issues/1664/states/00000001.json'),'immutable');
assert.equal(classifyRunStorePath(S,'workflows/issues/1664/results/33-1-'+'a'.repeat(64)+'.json'),'immutable');
assert.equal(classifyRunStorePath(S,'roles/developer/dev-qwen-01/issues/1664/checkpoints/00000001.json'),'immutable');
assert.equal(classifyRunStorePath(S,'roles/developer/dev-qwen-01/issues/1664/runs/33-1.json'),'immutable');
assert.equal(classifyRunStorePath(S,'roles/developer/dev-qwen-01/issues/1664/.head-1.json'),'unclassified');
assert.throws(()=>classifyRunStorePath(M,'raw/workflows/../../secrets'),/unsafe/);
assert.throws(()=>classifyRunStorePath(M,'raw\\workflows\\secret'),/unsafe/);
assert.throws(()=>classifyRunStorePath('unknown','metrics.json'),/unclassified run store/);
assert.throws(()=>validateRunStoreChange(M,'M','raw/workflows/a.json'),/forbidden/);
assert.throws(()=>validateRunStoreChange(M,'D','agent-metrics.json'),/forbidden/);
assert.throws(()=>validateRunStoreChange(A,'A','unexpected.txt'),/forbidden/);
assert.throws(()=>validateRunStoreChange(S,'T','roles/developer/dev-qwen-01/issues/1664/head.json'),/forbidden/);
assert.equal(validateRunStoreChange(M,'M','metrics.json').kind,'projection');

const roots=[];
try {
  const r=makeRepo();roots.push(r);
  write(r,'README.md','baseline');const baseline=commit(r,'baseline (historical records not attested)');
  write(r,'runs/2026-10-13/100-1/SC-01.json','{"pass":true}\n');
  write(r,'indexes/by-sha/'+'a'.repeat(40)+'/SC-01.json','{}\n');
  assert.equal(auditStagedRunStore(r,A).checked_changes,0);
  run(r,'add','-A');
  assert.equal(auditStagedRunStore(r,A).checked_changes,2);
  const c1=commit(r,'append two records');
  write(r,'runs/2026-10-13/101-1/SC-02.json','{"pass":true}\n');
  const c2=commit(r,'append another');
  const valid=auditAnchoredRunStore(r,A,baseline,c2);
  assert.equal(valid.checked_commits,2);
  assert.equal(valid.checked_changes,3);
  assert.equal(valid.anchor_source,'caller-supplied');
  assert.equal(auditAnchoredRunStore(r,A,c2,c2).checked_commits,0);
  assert.throws(()=>auditAnchoredRunStore(r,A,c2,c1),/checkout HEAD|ancestor/);
  // An ordinary fast-forward is NOT immutable: rewriting a prior record
  // creates a new commit that remains descendant of the initial baseline.
  write(r,'runs/2026-10-13/100-1/SC-01.json','{"pass":false}\n');
  run(r,'add','-A');
  assert.throws(()=>auditStagedRunStore(r,A),/forbidden acceptance-results M/);
  const malicious=commit(r,'fast-forward overwrite old historical result');
  assert.throws(()=>auditAnchoredRunStore(r,A,baseline,malicious),/forbidden acceptance-results M/);
  // A narrower baseline is not an independent anchor: the auditor can prove
  // ancestry only from the supplied commit; deployment MUST control it.
  assert.throws(()=>auditAnchoredRunStore(r,A,'f'.repeat(40),malicious),/Git operation failed/);
  run(r,'reset','--hard',c1);
  write(r,'runs/2026-10-13/102-1/SC-03.json','{}\n');
  const replacement=commit(r,'replacement history');
  assert.throws(()=>auditAnchoredRunStore(r,A,c2,replacement),/not ancestor/);

  const rm=makeRepo();roots.push(rm);
  write(rm,'README.md','baseline');write(rm,'metrics.json','{}\n');
  const mb=commit(rm,'baseline');
  write(rm,'raw/workflows/agent-provider-smoke/2026-10-13/run.json','{}\n');
  const ma=commit(rm,'add immutable metrics');
  write(rm,'metrics.json','{"runs":1}\n');
  write(rm,'agent-metrics-light.svg','<svg/>\n');
  const mp=commit(rm,'update metrics projections');
  assert.equal(auditAnchoredRunStore(rm,M,mb,mp).checked_commits,2);
  write(rm,'raw/workflows/agent-provider-smoke/2026-10-13/run.json','{"rewritten":true}\n');
  run(rm,'add','-A');
  assert.throws(()=>auditStagedRunStore(rm,M),/forbidden metrics M/);
  run(rm,'reset','--hard',mp);
  fs.unlinkSync(path.join(rm,'raw/workflows/agent-provider-smoke/2026-10-13/run.json'));
  run(rm,'add','-A');
  assert.throws(()=>auditStagedRunStore(rm,M),/forbidden metrics D/);
  run(rm,'reset','--hard',mp);
  write(rm,'raw/other/test.json','not classified');
  run(rm,'add','-A');
  assert.throws(()=>auditStagedRunStore(rm,M),/forbidden metrics A/);
  run(rm,'reset','--hard',mp);
  // Rename is treated as remove+append; removing history is forbidden.
  run(rm,'mv','metrics.json','renamed.json');
  assert.throws(()=>auditStagedRunStore(rm,M),/forbidden metrics/);
  run(rm,'reset','--hard',mp);
  const symlink='raw/workflows/agent-provider-smoke/2026-10-13/symlink.json';
  fs.symlinkSync('/etc/passwd',path.join(rm,symlink));
  run(rm,'add','-A');
  assert.throws(()=>auditStagedRunStore(rm,M),/nonregular or untrusted Git blob mode/);
  const symlinkCommit=commit(rm,'malicious append a Git symlink as record');
  assert.throws(()=>auditAnchoredRunStore(rm,M,mp,symlinkCommit),/nonregular or untrusted Git blob mode/);
  run(rm,'reset','--hard',mp);
  const executable='raw/workflows/agent-provider-smoke/2026-10-13/script.json';
  write(rm,executable,'not executable JSON\n');
  fs.chmodSync(path.join(rm,executable),0o755);
  run(rm,'add','-A');
  assert.throws(()=>auditStagedRunStore(rm,M),/nonregular or untrusted Git blob mode/);
  run(rm,'reset','--hard',mp);
  write(rm,'raw/workflows/agent-provider-smoke/2026-10-13/malicious.json','fake');
  run(rm,'add','-A');
  const okAddition=auditStagedRunStore(rm,M);
  assert.equal(okAddition.checked_changes,1);
  run(rm,'reset','--hard',mp);

  const rs=makeRepo();roots.push(rs);
  write(rs,'README.md','migration-only baseline');const sb=commit(rs,'baseline');
  const cp='roles/developer/dev-qwen-01/issues/1664/';
  write(rs,cp+'checkpoints/00000001.json','{"ciphertext":"only"}\n');
  write(rs,cp+'runs/33-1.json','{}\n');
  write(rs,cp+'head.json','{"version":1}\n');
  const s1=commit(rs,'append encrypted checkpoint');
  write(rs,cp+'head.json','{"version":2}\n');
  write(rs,cp+'checkpoints/00000002.json','{"ciphertext":"only"}\n');
  const s2=commit(rs,'CAS move after new immutable record');
  assert.equal(auditAnchoredRunStore(rs,S,sb,s2).checked_changes,5);
  write(rs,cp+'checkpoints/00000001.json','{"changed":"forbidden"}\n');
  run(rs,'add','-A');
  assert.throws(()=>auditStagedRunStore(rs,S),/forbidden agent-store M/);
  run(rs,'reset','--hard',s2);
  write(rs,'workflows/issues/1664/head.json','{"version":1}\n');
  assert.equal(auditStagedRunStore(rs,S).checked_changes,0);
  run(rs,'add','-A');
  assert.equal(auditStagedRunStore(rs,S).checked_changes,1);
  // Even a permitted head mutation does not prove proper CAS authorization.
  assert.equal(auditAnchoredRunStore(rs,S,sb,s2).checked_commits,2);

  const rt=makeRepo();roots.push(rt);
  write(rt,'README.md','migration-only baseline');const tb=commit(rt,'baseline');
  write(rt,'sources/1664/source.json','{}\n');
  write(rt,'runs/1664/run.json','{}\n');
  const t1=commit(rt,'append sources');
  assert.equal(auditAnchoredRunStore(rt,T,tb,t1).checked_changes,2);
  fs.unlinkSync(path.join(rt,'sources/1664/source.json'));run(rt,'add','-A');
  assert.throws(()=>auditStagedRunStore(rt,T),/forbidden task-results D/);
  console.log('run-store Git ancestry/delta audit: append, projections, CAS, overwrite, deletion, reset, path injection fixtures passed');
} finally {
  for(const root of roots)fs.rmSync(root,{recursive:true,force:true});
}
