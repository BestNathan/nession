import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {formatWorkflowPublication,parseWorkflowPublicationLog} from '../scripts/publication-receipt.mjs';

const sha='a'.repeat(40);
const row={main_sha:sha,nodes:27,json_sha256:'b'.repeat(64),html_sha256:'c'.repeat(64)};
const log='2026-10-20T11:08:01.123Z '+formatWorkflowPublication(row);
test('Pages-owned Workflow publication receipt is exact SHA/bytes and bounded',()=>{
  assert.deepEqual(parseWorkflowPublicationLog(log,sha),row);
  assert.throws(()=>parseWorkflowPublicationLog(log,'d'.repeat(40)),/SHA mismatch/);
  assert.throws(()=>parseWorkflowPublicationLog(log+'\n'+log,sha),/ambiguous/);
  assert.throws(()=>parseWorkflowPublicationLog(log.replace('nodes=27','nodes=0'),sha),/invalid/);
  assert.throws(()=>parseWorkflowPublicationLog(log.replace('html_sha256='+row.html_sha256,'html_sha256=x'),sha),/missing/);
});
test('public publisher invokes canonical Pages receipt after verified HTTPS hashes',async()=>{
  const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
  const begin=yaml.indexOf('for attempt in {1..18}; do');
  const verified=yaml.indexOf('[[ "$matched" == true ]]',begin);
  const receipt=yaml.indexOf('node pages/scripts/publication-receipt.mjs emit');
  assert.ok(begin>=0&&verified>begin&&receipt>verified);
  assert.match(yaml,/EXPECTED_WORKFLOW_JSON_SHA256/);
  assert.match(yaml,/EXPECTED_WORKFLOW_HTML_SHA256/);
  assert.match(yaml,/persist-credentials: false/);
});
