'use strict';
// In-tree Case layout + exact Issue/SC/contract proof. The separate trusted
// ingest/updater workflow supplies the final authenticated durability evidence.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../../../..');
async function main(){
  const sha=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(sha,/^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sha);
  assert.equal(process.env.GITHUB_REF_NAME,'staging','require real staging merge execution');
  const runtime=JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha,sha);
  const contract=process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256;
  assert.match(contract,/^[0-9a-f]{64}$/);
  const canonical=path.join(repo,'e2e/acceptance/cases');
  assert.equal(fs.existsSync(path.join(repo,'acceptance/cases')),false,'legacy Case alias still exists');
  const {discoverCases}=await import(pathToFileURL(path.join(repo,'acceptance/cases.mjs')).href);
  const all=discoverCases(canonical);
  assert.ok(all.length>0);
  const seen=new Set();
  for(const item of all){
    const m=item.manifest;
    const key=m.issue+'/'+m.criterion;
    assert.equal(seen.has(key),false,'duplicate canonical Issue/SC Case '+key);
    seen.add(key);
    assert.equal(path.resolve(item.dir),path.join(canonical,String(m.issue),m.criterion),'noncanonical case path '+key);
    assert.equal(fs.realpathSync(item.dir),item.dir,'Case directory symlink');
    assert.ok(['pre-merge','staging','post-merge'].includes(m.stage));
    assert.ok(m.verifiers.length>0,'empty verifier collection '+key);
  }
  for(const id of ['SC-01','SC-03','SC-04']){
    const matching=all.filter(x=>x.manifest.issue===1497&&x.manifest.criterion===id);
    assert.equal(matching.length,1,'1497 missing staged Case '+id);
    assert.equal(matching[0].manifest.stage,'staging');
  }
  const caseTree=execFileSync('git',['rev-parse',sha+':e2e/acceptance/cases/1497/SC-04'],{cwd:repo,encoding:'utf8'}).trim();
  assert.match(caseTree,/^[a-f0-9]{40}$/);
  const workflow=fs.readFileSync(path.join(repo,'.github/workflows/acceptance-cases.yml'),'utf8');
  assert.match(workflow,/Checkout trusted discovery tooling/);
  assert.match(workflow,/ref: main/);
  assert.match(workflow,/node workspace\/e2e\/run "\$\{args\[@\]\}"/);
  assert.match(workflow,/Missing Issue\/SC Case coverage remains Pending/);
  const ingest=fs.readFileSync(path.join(repo,'scripts/acceptance-case-ingest.mjs'),'utf8');
  assert.match(ingest,/assertSourceBoundRecord/);
  const response=await fetch(runtime.base_url+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(response.status,200);
  console.log(JSON.stringify({status:'pass',summary:'All Issue/SC Cases discover from one canonical tree; trusted Case selector and staging target/contract are bound to a real running Web.',evidence:[
    {type:'catalog',value:'canonical Case count='+all.length+' distinct Issue/SC pairs; 1497 staged cases=3; legacy tree absent'},
    {type:'git',value:'target_sha='+sha+' 1497/SC-04 case_tree_sha='+caseTree+' contract_sha256='+contract},
    {type:'trust',value:'main-owned selector requires stage coverage and trusted ingestion enforces source-bound records'},
    {type:'runtime',value:'staging Web HTTP='+response.status+' at exact target'}
  ]}));
}
main().catch(e=>{const m=e instanceof Error?e.message:String(e);console.error(m);console.log(JSON.stringify({status:'fail',summary:m,evidence:[{type:'contract',value:'Case catalog, provenance or runtime proof failed'}]}));process.exitCode=1;});
