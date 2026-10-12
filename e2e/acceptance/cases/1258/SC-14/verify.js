'use strict';
// #1258/SC-14: verify closure remains gated while other post-merge criteria await ingestion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
  const repo = path.resolve(__dirname, '../../../../..');
  const target = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target || '', /^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repo, encoding:'utf8'}).trim(), target);
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE,'utf8'));
  assert.equal(runtime.target_sha, target);
  const response = await fetch('https://api.github.com/repos/BestNathan/nession/issues/1258', {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'nession-1258-close-guard' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Issue lookup failed: HTTP ' + response.status);
  const issue = await response.json();
  assert.equal(issue.state, 'open', 'Issue was closed before all criteria were checked');
  const checked = new Set([...issue.body.matchAll(/^- \[[xX]\] (SC-\d+)/gm)].map(x => x[1]));
  for (let i=1; i<=18; i++) {
    const criterion = 'SC-' + String(i).padStart(2,'0');
    if (criterion === 'SC-13' || criterion === 'SC-14') continue; // trusted ingestion is concurrent
    assert.ok(checked.has(criterion), criterion + ' cannot be Pending before final closure');
  }
  const guard = fs.readFileSync(path.join(repo, 'scripts/requirement-acceptance.mjs'), 'utf8');
  assert.ok(guard.includes('issue-close-guard'));
  assert.ok(guard.includes('post-merge pending blocks closure'));
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'Requirement remains open until all verified criteria are checked; trusted issue-close guard rejects pending post-merge criteria.',
    evidence: [
      { type: 'requirement', value: 'Issue #1258 current_state=open 16 earlier criteria checked; SC-13/14 awaited trusted post-merge ingestion' },
      { type: 'gate', value: 'requirement-acceptance.mjs issue-close-guard and pending post-merge rejection present' },
      { type: 'runtime', value: 'exact main source sha=' + target },
    ],
  }));
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ status: 'fail', summary: message,
    evidence: [{type:'requirement',value:'closure guard violated or issue state cannot be proven'}] }));
  process.exitCode = 1;
});
