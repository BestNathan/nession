#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Deterministic adapter: Issue JSONs are fetched read-only by the workflow.
// This script never edits Issues or invokes an Agent for test selection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGitPlan } from './issue-e2e-plan.mjs';
import { parsePreMergeIssueNumbers } from './requirement-acceptance.mjs';

const SHA = /^[a-f0-9]{40}$/;
export function prepare(event, issues, repoRoot) {
  const pr = event?.pull_request;
  if (event?.repository?.full_name !== 'BestNathan/nession' || !pr ||
      !SHA.test(pr.head?.sha) || !SHA.test(pr.base?.sha) ||
      pr.head?.repo?.full_name !== 'BestNathan/nession')
    throw Error('invalid PR/source identity');
  const refs = parsePreMergeIssueNumbers(pr.body, 'BestNathan', 'nession', pr.title);
  const listed = new Set(refs);
  for (const issue of issues) {
    if (!listed.has(issue.number) || !['open','OPEN'].includes(issue.state))
      throw Error('unrelated or closed Issue in test plan');
  }
  if (!issues.length || issues.some(i => !i.body?.includes('## E2E Verification'))) {
    return { schema_version:1, kind:'issue_e2e_selection', pr_number:pr.number,
      target_sha:pr.head.sha, base_sha:pr.base.sha,
      mode:'full', reason:'legacy-or-unlinked', selected:[], issues:[] };
  }
  return { ...buildGitPlan(repoRoot,issues,pr.base.sha,pr.head.sha),pr_number:pr.number };
}
function selfTest() {
  const event = { repository:{full_name:'BestNathan/nession'},pull_request:{
    number:17, title:'Refs #1702', body:'Refs #1702',
    head:{sha:'a'.repeat(40),repo:{full_name:'BestNathan/nession'}},
    base:{sha:'b'.repeat(40)} }};
  assert.equal(prepare(event,[],'.').mode,'full');
  assert.throws(()=>prepare({...event,pull_request:{...event.pull_request,head:{sha:'x'}}},[],'.'),/identity/);
  assert.throws(()=>prepare(event,[{number:999,body:'',state:'open'}],'.'),/unrelated/);
  assert.equal(prepare(event,[{number:1702,body:'old issue',state:'open'}],'.').mode,'full');
  console.log('Issue E2E planner adapter: legacy fallback, source identity and unrelated Issue rejected');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const [op,eventFile,issuesFile,sourceRoot,output] = process.argv.slice(2);
if (op === 'self-test') selfTest();
else if (op === 'plan') {
  if (!eventFile || !issuesFile || !sourceRoot || !output) throw Error('plan EVENT ISSUES ROOT OUTPUT');
  const plan = prepare(JSON.parse(fs.readFileSync(eventFile,'utf8')),
    JSON.parse(fs.readFileSync(issuesFile,'utf8')),sourceRoot);
  fs.writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log('E2E selection mode: '+plan.mode+', selected: '+plan.selected.map(x=>x.id).join(','));
} else throw Error('use self-test or plan');
}
