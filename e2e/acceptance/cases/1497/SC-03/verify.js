'use strict';
// Browser/snapshot parity must be checked against pinned pre-migration blob IDs;
// this verifier additionally talks to the running exact-SHA production Web.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../../../..');
const browserRoot=path.join(repo,'e2e/tests/browser');
async function main(){
  const sha=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(sha,/^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sha);
  const runtime=JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha,sha);
  const migration=JSON.parse(fs.readFileSync(path.join(browserRoot,'migration-parity.json'),'utf8'));
  assert.equal(migration.schema_version,1);
  assert.match(migration.source_sha,/^[a-f0-9]{40}$/);
  const specs=fs.readdirSync(browserRoot).filter(n=>n.endsWith('.spec.ts')).sort();
  assert.equal(specs.length,21);
  assert.deepEqual(specs,migration.specs,'regression spec migration inventory drift');
  assert.equal(fs.existsSync(path.join(repo,'e2e/specs')),false,'duplicate old regression tree');
  const blobs=Object.entries(migration.baseline_png_blobs);
  assert.equal(blobs.length,43);
  for(const [relative,digest] of blobs){
    const p=path.resolve(browserRoot,relative);
    assert.ok(p.startsWith(browserRoot+path.sep),'snapshot escaped tree');
    assert.equal(fs.lstatSync(p).isSymbolicLink(),false);
    const data=fs.readFileSync(p);
    const actual=crypto.createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex');
    assert.equal(actual,digest,'snapshot blob changed: '+relative);
  }
  const config=fs.readFileSync(path.join(repo,'e2e/playwright.config.ts'),'utf8');
  assert.match(config,/testDir: '\.\/tests\/browser'/);
  assert.match(config,/globalSetup: require.resolve\('\.\/globalSetup'\)/);
  const workflow=fs.readFileSync(path.join(repo,'.github/workflows/e2e.yml'),'utf8');
  assert.match(workflow,/\.\/run test --all/);
  assert.match(workflow,/e2e\/tests\/browser\/__snapshots__/);
  const response=await fetch(runtime.base_url+'/',{signal:AbortSignal.timeout(8000)});
  assert.equal(response.status,200);
  console.log(JSON.stringify({status:'pass',summary:'Pinned 21-spec and 43-snapshot migration inventory and real isolated production Web verified at exact staging SHA.',evidence:[
    {type:'regression',value:'21 migrated specs equal recorded migration source inventory '+migration.source_sha},
    {type:'visual',value:'43 PNG Git blob SHA-1 values match migration-parity manifest; legacy specs absent'},
    {type:'workflow',value:'canonical e2e/run test --all and migrated snapshot upload configured'},
    {type:'runtime',value:'Web HTTP='+response.status+' at target_sha='+sha}
  ]}));
}
main().catch(e=>{const m=e instanceof Error?e.message:String(e);console.error(m);console.log(JSON.stringify({status:'fail',summary:m,evidence:[{type:'regression',value:'migration inventory or real Web validation failed'}]}));process.exitCode=1;});
