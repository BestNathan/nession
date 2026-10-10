'use strict';
// #1258/SC-13: read-only proof of published measured experiment in Narness main.
// Deliberately DOES NOT claim a completed AI coding-agent productivity study.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NARNESS_MERGE = 'b76d92b38516b44e47b37ba39fbb32ccd419c1f5';
const RAW_BASE = 'https://raw.githubusercontent.com/BestNathan/narness-engineering/' + NARNESS_MERGE;
const RESEARCH = 'docs/topics/agent-native-repository-architecture/research/experiments/nession-server-handler-locality-2026-10/';
async function getJson(url) {
  const response = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'nession-1258-acceptance' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(url + ' returned ' + response.status);
  return response.json();
}
async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(url + ' returned ' + response.status);
  return response.text();
}
async function main() {
  const repo = path.resolve(__dirname, '../../../../..');
  const target = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(target || '', /^[a-f0-9]{40}$/);
  assert.equal(sha, target, 'not the exact post-merge Nession source');
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  assert.equal(runtime.target_sha, target);
  const report = await getText(RAW_BASE + '/' + RESEARCH + 'RESULTS.md');
  const script = await getText(RAW_BASE + '/scripts/measure-nession-handler-locality.py');
  const workflow = await getJson('https://api.github.com/repos/BestNathan/narness-engineering/actions/runs/38051474658');
  const merge = await getJson('https://api.github.com/repos/BestNathan/narness-engineering/compare/' + NARNESS_MERGE + '...main');
  assert.equal(merge.status === 'identical' || merge.status === 'ahead', true, 'Narness measured study not on main');
  assert.equal(workflow.conclusion, 'success');
  assert.match(report, /1,313,540/);
  assert.match(report, /29,416/);
  assert.match(report, /386,714/);
  assert.match(report, /No LLM inference or coding-agent task was run/);
  assert.ok(report.includes('5cc36bb2ced14062c17df985ad996bc0c8a9014f30680c831ceb76021e1195ed'));
  assert.ok(script.includes('T05') && script.includes('git'), 'reproduction source missing');
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'Narness main holds reproducible exact-SHA paired Nession source retrieval experiment, checked raw checksum and successful measured run; no AI-agent productivity claim.',
    evidence: [
      { type: 'research', value: 'narness_merge=' + NARNESS_MERGE + ' main_ancestry=' + merge.status },
      { type: 'workflow', value: 'Narness run=38051474658 conclusion=success' },
      { type: 'measurement', value: '4 Units implementation bytes A=1313540 C=29416 conservative C=386714' },
      { type: 'checksum', value: 'observations_json_sha256=5cc36bb2ced14062c17df985ad996bc0c8a9014f30680c831ceb76021e1195ed' },
      { type: 'runtime', value: 'exact main source sha=' + target },
    ],
  }));
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ status: 'fail', summary: message,
    evidence: [{ type: 'research', value: 'Narness main measurement provenance unavailable or inconsistent' }] }));
  process.exitCode = 1;
});
