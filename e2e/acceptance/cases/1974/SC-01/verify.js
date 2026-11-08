'use strict';
// #1974 SC-01: source-selected original Qwen Developer v2 proof, not a
// permanently hardcoded historical #2961 intent. This Case never mutates Store.
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {HEX40}=require('../../../shared/agent-store-1997.cjs');
const {attestLatestQwenProducer}=require('../../../shared/qwen-live-source.cjs');
const {report,fail}=require('../../../shared/trusted-run-store-proof.cjs');

const root=path.resolve(__dirname,'../../../../..');
async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA||'';
  assert.match(target,HEX40,'exact target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    target,'Case checkout SHA mismatch');
  assert.equal(process.env.GITHUB_REF_NAME,'main',
    'source-aligned Result v2 Case requires merged main');

  const result=await attestLatestQwenProducer();
  if(result.status!=='verified'){
    console.log(JSON.stringify({status:'pending',
      summary:'A new authenticated Qwen Developer Result v2 with independent original Artifact, trusted Publisher and Store Writer is not yet proven: '+result.reason,
      evidence:[{type:'store',value:'agent-store='+(result.storeSha||'unavailable')},
        {type:'blocked',value:'No historical intent may be rewritten or self-promoted as a Developer v2'}]}));
    return;
  }
  const s=result.fixture,a=result.attested;
  assert.equal(a.verification,'authenticated_at_attestation');
  assert.equal(a.origin.source_url,'https://github.com/BestNathan/nession/actions/runs/'+s.runId);
  assert.match(a.origin.result_digest,/^[a-f0-9]{64}$/);
  assert.match(a.origin.writer_receipt_digest,/^[a-f0-9]{64}$/);
  report('Independent original Worker ZIP, authenticated Publisher receipt, immutable Store Writer ancestor and exact implementing PR head jointly attest a real Qwen Developer Result v2.',[
    {type:'store',value:'agent-store='+result.storeSha+' path='+s.producerPath},
    {type:'worker',value:'Agent / Development run='+s.runId+'/'+a.attempt},
    {type:'publisher',value:'Original Writer digest='+a.origin.writer_receipt_digest},
    {type:'pr',value:'#'+s.pr+' exact attested head='+s.sha},
  ]);
}
main().catch(fail);
