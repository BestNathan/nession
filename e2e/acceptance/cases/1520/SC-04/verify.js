'use strict';
// #1520 SC-04: observe real staging merge identity; never infer production release.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../../../..');
// git log/show uses shallow grafts and hides parents even when the commit
// object itself contains two. Inspect the SHA-pinned raw Git object instead.
function mergeParents(raw) {
  const header = String(raw).split('\n\n', 1)[0];
  const lines = header.split('\n').filter(line => line.startsWith('parent '));
  const parents = lines.map(line => line.slice(7));
  assert.equal(parents.length, 2, 'staging SHA must be normal two-parent PR merge commit');
  for (const parent of parents) assert.match(parent, /^[a-f0-9]{40}$/, 'invalid Git parent SHA');
  return parents;
}
function selfTest() {
  const a='a'.repeat(40), b='b'.repeat(40);
  const raw='tree '+a+'\nparent '+a+'\nparent '+b+'\nauthor Example <example@example.org> 0 +0000\n\nmessage\n';
  assert.deepEqual(mergeParents(raw), [a, b]);
  assert.throws(() => mergeParents(raw.replace('parent '+b+'\n', '')), /two-parent/);
  assert.throws(() => mergeParents(raw.replace('parent '+b, 'parent BAD')), /parent SHA/);
  assert.throws(() => mergeParents(raw.replace('parent '+b+'\n', 'parent '+b+'\nparent '+b+'\n')), /two-parent/);
  console.log('staging merge parent raw-object proof self-test passed');
}
async function check(){
  const sha=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(sha,/^[a-f0-9]{40}$/);
  const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
  assert.equal(checkout,sha,'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'staging','not executing on real staging push');
  const parents=mergeParents(execFileSync('git',['cat-file','-p',sha],{cwd:repo,encoding:'utf8'}));
  const runtime=JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha,sha,'Runtime did not start at staged SHA');
  assert.equal(runtime.profile,'full-stack-local');
  const url=String(runtime.base_url||'');
  assert.match(url,/^http:\/\/localhost:[0-9]+$/);
  const response=await fetch(url+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(response.status,200,'merged staging Web stack not serving');
  process.stdout.write(JSON.stringify({status:'pass',
    summary:'Normal two-parent staging merge commit runs isolated product Web at the exact SHA; production release is explicitly separate.',
    evidence:[
      {type:'git',value:'staging merge='+sha+' parent0='+parents[0]+' parent1='+parents[1]},
      {type:'runtime',value:'full-stack target_sha='+runtime.target_sha+' Web HTTP=200'},
      {type:'release-boundary',value:'staging verification only; main/prod deployment not asserted'},
    ]})+'\n');
}
if (process.argv.includes('--self-test')) selfTest();
else check().catch(e=>{
  const m=e instanceof Error?e.message:String(e);
  process.stderr.write(m+'\n');
  process.stdout.write(JSON.stringify({status:'fail',summary:m,
    evidence:[{type:'runtime',value:'staging merge identity / live proof failed'}]})+'\n');
  process.exitCode=1;
});
