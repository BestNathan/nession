'use strict';
// Read-only access to public Issue-scoped Agent Store records.
// Keep historical filename for compatibility, but accept an explicit Issue
// scope so #1974 can verify the real Qwen #2961 producer. The GitHub API and
// the pinned Git blobs are the source of truth; no local JSON is trusted.
const assert=require('node:assert/strict');
const {fetchJson,HEX40}=require('./trusted-run-store-proof.cjs');
const REPO='BestNathan/nession';
const STORE='agent-store';
const RESULT_PATH=/^workflows\/issues\/[1-9][0-9]*\/results\/[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json$/;
const SLICE_PATH=/^workflows\/issues\/[1-9][0-9]*\/slices\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/;
const PRODUCER_RESULT_PATH=/^workflows\/issues\/[1-9][0-9]*\/producer-results-v2\/[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json$/;
async function pinnedStore(){
  const ref=await fetchJson('/git/ref/heads/'+STORE);
  const sha=ref?.object?.sha;
  assert.match(sha??'',HEX40,'agent-store ref is not a pinned SHA');
  const tree=await fetchJson('/git/trees/'+sha+'?recursive=1');
  assert.equal(tree.truncated,false,'agent-store tree is truncated');
  return {sha,tree};
}
async function blob(entry,ref){
  const file=await fetchJson('/contents/'+entry.path+'?ref='+ref);
  assert.equal(file.encoding,'base64','store entry is not a regular base64 blob');
  const bytes=Buffer.from(file.content.replace(/\s/g,''),'base64');
  assert.equal(file.sha,entry.sha,'store blob identity changed');
  return {bytes,doc:JSON.parse(bytes.toString('utf8'))};
}
async function issueRecords(issue=1997){
  assert.ok(Number.isSafeInteger(issue)&&issue>0,'invalid canonical Store Issue scope');
  const prefix='workflows/issues/'+issue+'/';
  const {sha,tree}=await pinnedStore();
  const results=[],slices=[];
  for(const entry of tree.tree){
    if(entry.type!=='blob')continue;
    if(!entry.path.startsWith(prefix))continue;
    if(RESULT_PATH.test(entry.path)||PRODUCER_RESULT_PATH.test(entry.path))
      results.push({path:entry.path,sha:entry.sha,...await blob(entry,sha)});
    else if(SLICE_PATH.test(entry.path))slices.push({path:entry.path,sha:entry.sha,...await blob(entry,sha)});
  }
  return {storeSha:sha,results,slices};
}
const isResultV2=doc=>doc?.schema_version===2&&doc?.kind==='authenticated_agent_task_result';
const isIntent=doc=>doc?.schema_version===1&&[
  'trusted_publisher_write_ahead_intent',
  'trusted_qwen_publisher_write_ahead_intent',
  'trusted_qwen_repair_publisher_write_ahead',
].includes(doc?.kind);
const isSlice=doc=>doc?.schema_version===1&&doc?.kind==='agent_slice_identity';
module.exports={REPO,STORE,issueRecords,isResultV2,isIntent,isSlice,fetchJson,HEX40};
