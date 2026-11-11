#!/usr/bin/env node
// Issue #2358. Trusted-main request admission for a *data-only* Knowledge commit.
// An owner repository_dispatch requests one SHA-pinned, normal fast-forward;
// only the separately approved GitHub App publisher may perform the mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'BestNathan/nession';
const EVENT = 'knowledge-publish-v1';
const SHA = /^[0-9a-f]{40}$/;
const PROPOSAL_REF = /^refs\/heads\/knowledge-proposals\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge-ledger-contract.mjs');

function fail(message) { throw Error('knowledge-publisher-request: ' + message); }
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0)
    fail('git ' + args[0] + ' failed: ' + (result.stderr || result.error?.message || 'unknown').trim());
  return result.stdout.trim();
}
const SIGNAL_NAME = 'Store / Knowledge Proposal Signal';
const SIGNAL_PATH = '.github/workflows/store-knowledge-proposal-signal.yml';
function parseRequest(event, context) {
  if (!context || context.repository !== REPO ||
      context.ref !== 'refs/heads/main' || context.runAttempt !== '1' ||
      !SHA.test(context.sha || ''))
    fail('only exact first-attempt trusted main requests are admitted');

  if (context.eventName === 'repository_dispatch') {
    // Retain the explicitly authorized external owner API for recovery.
    if (context.actor !== 'BestNathan' || event?.action !== EVENT ||
        event.sender?.login !== 'BestNathan') fail('owner dispatch required');
    const payload = event.client_payload;
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
        Object.keys(payload).sort().join(',') !== 'expected_head,proposal_ref,proposal_sha')
      fail('expected exactly proposal_ref, proposal_sha and expected_head');
    const { proposal_ref, proposal_sha, expected_head } = payload;
    if (typeof proposal_ref !== 'string' || !PROPOSAL_REF.test(proposal_ref))
      fail('proposal_ref must be a bounded knowledge-proposals branch');
    if (typeof proposal_sha !== 'string' || !SHA.test(proposal_sha) ||
        typeof expected_head !== 'string' || !SHA.test(expected_head) ||
        proposal_sha === expected_head)
      fail('two distinct exact 40-character SHA values are required');
    return { proposal_ref, proposal_sha, expected_head };
  }

  if (context.eventName === 'issue_comment') {
    // An authenticated owner comment is an exact source-pinned handoff.
    // GitHub emits issue_comment on trusted main; ordinary GITHUB_TOKEN
    // comments cannot self-trigger arbitrary credentialed workflows.
    if (context.actor !== 'BestNathan' || event?.action !== 'created' ||
        event.repository?.full_name !== REPO ||
        event.sender?.login !== 'BestNathan' ||
        event.comment?.user?.login !== 'BestNathan' ||
        event.comment?.author_association !== 'OWNER' ||
        !Number.isSafeInteger(event.comment?.id) || event.comment.id <= 0 ||
        !Number.isSafeInteger(event.issue?.number) || event.issue.number <= 0 ||
        event.issue?.pull_request != null ||
        event.issue?.repository_url !== 'https://api.github.com/repos/' + REPO)
      fail('an authenticated owner Issue comment is required');
    const lines=String(event.comment.body||'').replace(/\r\n?/g,'\n').trimEnd().split('\n');
    if (lines.length !== 4 || lines[0] !== '/knowledge-publish v1' ||
        !lines[1].startsWith('proposal_ref=') ||
        !lines[2].startsWith('proposal_sha=') ||
        !lines[3].startsWith('expected_head='))
      fail('Issue comment must contain exactly four typed publication lines');
    const proposal_ref=lines[1].slice('proposal_ref='.length);
    const proposal_sha=lines[2].slice('proposal_sha='.length);
    const expected_head=lines[3].slice('expected_head='.length);
    if (!PROPOSAL_REF.test(proposal_ref) || !SHA.test(proposal_sha) ||
        !SHA.test(expected_head) || proposal_sha===expected_head)
      fail('invalid owner-approved proposal/expected-head identity');
    return {proposal_ref,proposal_sha,expected_head,source_comment_id:event.comment.id};
  }

  if (context.eventName === 'workflow_run') {
    // A trusted default-branch workflow_run webhook is the bridge from
    // *owner-created* proposal refs. Never trust a proposed branch's code,
    // artifact, a PR-controlled script, or a metadata-only "success" label.
    const run = event?.workflow_run;
    if (event?.action !== 'completed' || event.repository?.full_name !== REPO ||
        !run || !Number.isSafeInteger(run.id) || run.id <= 0 ||
        run.name !== SIGNAL_NAME || run.path !== SIGNAL_PATH ||
        run.event !== 'create' || run.status !== 'completed' ||
        run.conclusion !== 'success' || run.run_attempt !== 1 ||
        run.head_repository?.full_name !== REPO ||
        run.repository?.full_name !== REPO ||
        run.actor?.login !== 'BestNathan' ||
        run.triggering_actor?.login !== 'BestNathan' ||
        typeof run.head_branch !== 'string' ||
        !PROPOSAL_REF.test('refs/heads/' + run.head_branch) ||
        !SHA.test(run.head_sha || ''))
      fail('untrusted or mismatched owner-created Knowledge proposal signal');
    return {
      proposal_ref:'refs/heads/' + run.head_branch,
      proposal_sha:run.head_sha,
      expected_head:null, // resolve live Knowledge SHA, then require exactly one direct child
      source_run_id:run.id,
    };
  }
  fail('unsupported publisher invocation; owner dispatch or authenticated proposal signal only');
}
function assertSingleCommitProposal(parentsText, proposalSha, expectedHead) {
  const parents=parentsText.split(/\s+/);
  if (parents.length !== 2 || parents[0] !== proposalSha || parents[1] !== expectedHead)
    fail('proposal must be exactly one direct child of current Knowledge head');
}
function remoteSha(root, ref) {
  const lines = git(root, 'ls-remote', '--heads', 'origin', ref).split('\n').filter(Boolean);
  if (lines.length !== 1) fail('ref missing or ambiguous: ' + ref);
  const [sha, observed] = lines[0].split(/\s+/);
  if (!SHA.test(sha) || observed !== ref) fail('unexpected remote ref readback');
  return sha;
}
// A completed workflow with all jobs skipped can report overall success.
// Require the exact read-only signal job and step to have *actually run*
// at the same upstream Run ID and proposal SHA before granting authority.
function verifySignalJobReceipt(response,sourceRunId,proposalSha) {
  if (!response || !Array.isArray(response.jobs) || response.jobs.length !== 1 ||
      response.total_count !== 1)
    fail('proposal signal must have exactly one completed source job');
  const job=response.jobs[0];
  if (job.run_id !== sourceRunId || job.head_sha !== proposalSha ||
      job.name !== 'Emit approved owner proposal creation signal' ||
      job.status !== 'completed' || job.conclusion !== 'success' ||
      !Array.isArray(job.steps) ||
      !job.steps.some(step=>step.name==='Record nonprivileged proposal event provenance' &&
        step.status==='completed' && step.conclusion==='success'))
    fail('proposal signal job/step was skipped, failed, or does not match pinned run/SHA');
}
function validateSignalJobRemotely(runId,proposalSha) {
  const token=process.env.GH_TOKEN;
  if (!token || typeof token !== 'string') fail('read-only Actions token required for signal proof');
  const path='repos/'+REPO+'/actions/runs/'+runId+'/jobs?per_page=100';
  const result=spawnSync('gh',['api',path],{
    encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
    env:{...process.env,GH_TOKEN:token},
  });
  if(result.error || result.status!==0)
    fail('source signal job readback failed: '+(result.error?.message||result.stderr||'unknown').trim());
  let response;
  try{response=JSON.parse(result.stdout);}catch{fail('invalid original source signal job JSON');}
  verifySignalJobReceipt(response,runId,proposalSha);
}
// GitHub issue_comment events include the full public Issue/Repo envelopes,
// not just the four-line owner command. Keep a strict bounded event size;
// 8 KiB was sufficient only for repository_dispatch, not for real comments.
function prepare(eventPath, destination) {
  if (typeof eventPath !== 'string' || !eventPath ||
      !fs.statSync(eventPath).isFile() || fs.statSync(eventPath).size > 256 * 1024)
    fail('missing or oversized GitHub event');
  const request = parseRequest(
    JSON.parse(fs.readFileSync(eventPath, 'utf8')),
    { repository: process.env.GITHUB_REPOSITORY, eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF, actor: process.env.GITHUB_ACTOR,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA },
  );
  const {proposal_ref, proposal_sha} = request;
  if(request.source_run_id)validateSignalJobRemotely(request.source_run_id,proposal_sha);
  const root = process.cwd();
  if (git(root, 'rev-parse', 'HEAD') !== process.env.GITHUB_SHA ||
      !/^https:\/\/github\.com\/BestNathan\/nession(?:\.git)?$/.test(git(root, 'remote', 'get-url', 'origin')))
    fail('checkout is not the exact trusted main-owned source');
  if (!destination.startsWith(process.env.RUNNER_TEMP + path.sep) ||
      fs.existsSync(destination)) fail('destination must be fresh under RUNNER_TEMP');
  const observedHead=remoteSha(root, 'refs/heads/knowledge');
  const expected_head=request.expected_head ?? observedHead;
  if (observedHead !== expected_head)
    fail('STALE_HEAD: live Knowledge head differs from expected');
  if (remoteSha(root, proposal_ref) !== proposal_sha)
    fail('proposal ref moved or does not match requested SHA');
  git(root, 'fetch', '--no-tags', 'origin', 'refs/heads/knowledge');
  git(root, 'fetch', '--no-tags', 'origin', proposal_ref);
  if (git(root, 'rev-parse', 'FETCH_HEAD') !== proposal_sha)
    fail('fetched proposal is not the pinned commit');
  git(root, 'merge-base', '--is-ancestor', expected_head, proposal_sha);
  // All admission paths (owner comment, recovery dispatch and legacy create
  // signal) authorize exactly one new data-only commit. An ancestor-only check
  // would allow a comment or dispatch to publish an unreviewed commit chain.
  assertSingleCommitProposal(git(root, 'rev-list', '--parents', '-n', '1', proposal_sha), proposal_sha, expected_head);
  const localBranch = 'knowledge-publisher-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT;
  git(root, 'worktree', 'add', '-b', localBranch, destination, proposal_sha);
  if (git(destination, 'status', '--porcelain')) fail('candidate must be clean');
  const result = spawnSync(process.execPath, [CHECKER, 'check', destination, expected_head], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0)
    fail('canonical Knowledge contract denied candidate: ' + (result.stderr || result.error?.message || '').trim());
  const receipt = {
    schema_version: 1, event: process.env.GITHUB_EVENT_NAME,
    source_run_id: request.source_run_id ?? null,
    source_comment_id: request.source_comment_id ?? null, source_ref: proposal_ref,
    source_sha: proposal_sha, expected_head,
    trusted_main_sha: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    candidate_path: destination, status: 'validated_no_write',
  };
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'knowledge-publisher-admission.json'),
    JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
function selfTest() {
  const base='a'.repeat(40), proposal='b'.repeat(40), intermediate='c'.repeat(40);
  assert.doesNotThrow(()=>assertSingleCommitProposal(proposal+' '+base,proposal,base));
  for(const invalid of [proposal+' '+intermediate,proposal+' '+base+' '+intermediate,
    proposal,intermediate+' '+base,proposal+' '+base+' '+base])
    assert.throws(()=>assertSingleCommitProposal(invalid,proposal,base));
  const context = { repository: REPO, eventName: 'repository_dispatch', ref: 'refs/heads/main',
    actor: 'BestNathan', runAttempt: '1', sha: 'a'.repeat(40) };
  const payload = { proposal_ref: 'refs/heads/knowledge-proposals/issue-2358',
    proposal_sha: 'b'.repeat(40), expected_head: 'c'.repeat(40) };
  const event = { action: EVENT, sender: { login: 'BestNathan' }, client_payload: payload };
  assert.deepEqual(parseRequest(event, context), payload);
  for (const [key, value] of [
    ['actor', 'other-user'], ['eventName', 'workflow_dispatch'], ['ref', 'refs/heads/dev'],
    ['runAttempt', '2'], ['repository', 'other/nession'], ['sha', 'main'],
  ]) assert.throws(() => parseRequest(event, { ...context, [key]: value }));
  for (const changed of [
    { action: 'other' }, { sender: { login: 'attacker' } },
    { client_payload: { ...payload, command: 'sh bad.sh' } },
    { client_payload: { ...payload, proposal_ref: 'refs/heads/main' } },
    { client_payload: { ...payload, proposal_ref: 'refs/heads/knowledge-proposals/../../main' } },
    { client_payload: { ...payload, proposal_sha: payload.expected_head } },
    { client_payload: { ...payload, expected_head: 'not-a-sha' } },
  ]) assert.throws(() => parseRequest({ ...event, ...changed }, context));
  const issueContext={...context,eventName:'issue_comment'};
  const issueEvent={
    action:'created',repository:{full_name:REPO},sender:{login:'BestNathan'},
    issue:{number:3156,repository_url:'https://api.github.com/repos/'+REPO},
    comment:{id:98765,user:{login:'BestNathan'},author_association:'OWNER',
      body:'/knowledge-publish v1\n'+
        'proposal_ref='+payload.proposal_ref+'\n'+
        'proposal_sha='+payload.proposal_sha+'\n'+
        'expected_head='+payload.expected_head},
  };
  assert.deepEqual(parseRequest(issueEvent,issueContext),{
    ...payload,source_comment_id:98765,
  });
  for(const [field,value] of [
    ['id',0],['author_association','CONTRIBUTOR'],
    ['user',{login:'attacker'}],
    ['body',issueEvent.comment.body+'\nignored=yes'],
    ['body',issueEvent.comment.body.replace('proposal_ref=refs/heads','proposal_ref=refs/pull')],
    ['body',issueEvent.comment.body.replace(payload.proposal_sha,'not-a-sha')],
    ['body',issueEvent.comment.body.replace('expected_head=','bad_key=')],
  ])assert.throws(()=>parseRequest({
    ...issueEvent,comment:{...issueEvent.comment,[field]:value},
  },issueContext));
  for(const changed of [
    {sender:{login:'attacker'}},
    {issue:{...issueEvent.issue,pull_request:{url:'fake'}}},
    {repository:{full_name:'attacker/repo'}},
    {action:'edited'},
  ])assert.throws(()=>parseRequest({...issueEvent,...changed},issueContext));
  assert.throws(()=>parseRequest(issueEvent,{...issueContext,actor:'github-actions[bot]'}));
  assert.throws(()=>parseRequest(issueEvent,{...issueContext,ref:'refs/heads/proposal'}));
  const autoContext={...context,actor:'github-actions[bot]',eventName:'workflow_run'};
  const signalRun={
    id:12345,name:SIGNAL_NAME,path:SIGNAL_PATH,event:'create',
    status:'completed',conclusion:'success',run_attempt:1,
    head_branch:'knowledge-proposals/issue-3156',
    head_sha:'b'.repeat(40),
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'},
  };
  const signalEvent={action:'completed',repository:{full_name:REPO},workflow_run:signalRun};
  assert.deepEqual(parseRequest(signalEvent,autoContext),{
    proposal_ref:'refs/heads/knowledge-proposals/issue-3156',
    proposal_sha:'b'.repeat(40),expected_head:null,source_run_id:12345,
  });
  for (const [field,value] of [
    ['name','Other / Signal'],['path','.github/workflows/evil.yml'],
    ['event','push'],['status','in_progress'],['conclusion','failure'],
    ['run_attempt',2],['head_branch','main'],
    ['head_branch','knowledge-proposals/../../main'],
    ['head_sha','not-a-sha'],['actor',{login:'attacker'}],
    ['triggering_actor',{login:'attacker'}],
    ['repository',{full_name:'attacker/repo'}],
    ['head_repository',{full_name:'attacker/repo'}],
  ]) assert.throws(()=>parseRequest({
    ...signalEvent,workflow_run:{...signalRun,[field]:value},
  },autoContext),/untrusted or mismatched/);
  for (const [field,value] of [
    ['action','requested'],['repository',{full_name:'other/repo'}],
  ]) assert.throws(()=>parseRequest({...signalEvent,[field]:value},autoContext));
  assert.throws(()=>parseRequest(signalEvent,{...autoContext,ref:'refs/heads/knowledge-proposals/test'}));
  assert.throws(()=>parseRequest(signalEvent,{...autoContext,runAttempt:'2'}));
  assert.throws(()=>parseRequest(signalEvent,{...autoContext,eventName:'push'}));
  const validJob={run_id:12345,head_sha:'b'.repeat(40),
    name:'Emit approved owner proposal creation signal',
    status:'completed',conclusion:'success',
    steps:[{name:'Record nonprivileged proposal event provenance',
      status:'completed',conclusion:'success'}]};
  verifySignalJobReceipt({total_count:1,jobs:[validJob]},12345,'b'.repeat(40));
  for(const malformed of [
    {total_count:0,jobs:[]},
    {total_count:2,jobs:[validJob,validJob]},
    {total_count:1,jobs:[{...validJob,conclusion:'skipped'}]},
    {total_count:1,jobs:[{...validJob,run_id:12346}]},
    {total_count:1,jobs:[{...validJob,head_sha:'c'.repeat(40)}]},
    {total_count:1,jobs:[{...validJob,steps:[{...validJob.steps[0],conclusion:'skipped'}]}]},
    {total_count:1,jobs:[{...validJob,steps:[]}]},
  ])assert.throws(()=>verifySignalJobReceipt(malformed,12345,'b'.repeat(40)));
  console.log('knowledge-publisher-request: owner dispatch and owner create→workflow_run deny-by-default positive/negative fixtures passed');
}
try {
  const [command, eventPath, destination] = process.argv.slice(2);
  if (command === 'self-test') selfTest();
  else if (command === 'prepare' && eventPath && destination) prepare(eventPath, destination);
  else fail('usage: self-test | prepare <github-event-json> <fresh-runner-temp-worktree>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
