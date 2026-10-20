// Canonical Pages-owned public Workflow publication receipt contract.
// It attests exact published bytes, not GitHub PR ownership or SC verdicts.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const MARKER=/^\d{4}-\d{2}-\d{2}T[^\s]+Z Public Workflow topology verified: main_sha=([a-f0-9]{40}), nodes=([0-9]+), json_sha256=([a-f0-9]{64}), html_sha256=([a-f0-9]{64})$/;

export function validateWorkflowPublication({main_sha,nodes,json_sha256,html_sha256}) {
  if(!SHA.test(main_sha)||nodes!==27||!DIGEST.test(json_sha256)||
     !DIGEST.test(html_sha256))throw Error('invalid public Workflow publication proof');
  return Object.freeze({main_sha,nodes,json_sha256,html_sha256});
}
export function formatWorkflowPublication(proof) {
  const p=validateWorkflowPublication(proof);
  return 'Public Workflow topology verified: main_sha='+p.main_sha+
    ', nodes='+p.nodes+', json_sha256='+p.json_sha256+
    ', html_sha256='+p.html_sha256;
}
export function parseWorkflowPublicationLog(log,expectedSha) {
  if(typeof log!=='string'||log.length>1024*1024||!SHA.test(expectedSha))
    throw Error('unbounded or unpinned Pages publisher log');
  const matches=log.split(/\r?\n/).map(x=>x.match(MARKER)).filter(Boolean);
  if(matches.length!==1)throw Error('missing or ambiguous published Workflow topology marker');
  const [,sha,count,json,html]=matches[0];
  const proof=validateWorkflowPublication({main_sha:sha,nodes:Number(count),
    json_sha256:json,html_sha256:html});
  if(proof.main_sha!==expectedSha)throw Error('published Workflow source SHA mismatch');
  return proof;
}
function selfTest(){
  const source='a'.repeat(40);
  const proof={main_sha:source,nodes:27,json_sha256:'b'.repeat(64),html_sha256:'c'.repeat(64)};
  const log='2026-10-20T10:58:24.7102458Z '+formatWorkflowPublication(proof);
  assert.deepEqual(parseWorkflowPublicationLog(log,source),proof);
  assert.throws(()=>parseWorkflowPublicationLog(log,'d'.repeat(40)),/SHA mismatch/);
  assert.throws(()=>parseWorkflowPublicationLog(log+'\n'+log,source),/ambiguous/);
  assert.throws(()=>parseWorkflowPublicationLog('echo "'+formatWorkflowPublication(proof)+'"',source),/missing/);
  assert.throws(()=>parseWorkflowPublicationLog(log.replace('nodes=27','nodes=0'),source),/invalid/);
  assert.throws(()=>parseWorkflowPublicationLog(log.replace('json_sha256='+proof.json_sha256,'json_sha256='+'f'.repeat(63)),source),/missing/);
  assert.throws(()=>parseWorkflowPublicationLog(log.replace('html_sha256='+proof.html_sha256,'html_sha256=x'),source),/missing/);
  assert.throws(()=>parseWorkflowPublicationLog(log+'\n'.repeat(1024*1024),source),/unbounded/);
  console.log('Pages Workflow publication receipt: exact SHA/HTML/JSON hashes, bounded log and forgery negatives passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='emit'){
    const [,sha,rawNodes,json,html]=process.argv.slice(2);
    console.log(formatWorkflowPublication({main_sha:sha,nodes:Number(rawNodes),json_sha256:json,html_sha256:html}));
  }else throw Error('self-test | emit SHA NODES JSON_SHA256 HTML_SHA256');
}
