#!/usr/bin/env node
// #3773: housekeeping for disposable Knowledge proposal refs, never the ledger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const PREFIX = 'refs/heads/knowledge-proposals/';
const REF = /^refs\/heads\/knowledge-proposals\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;
const VALID = ref => typeof ref === 'string' && REF.test(ref);
function git(root, args, options = {}) {
  const run = spawnSync('git', ['-C', root, ...args], {
    encoding:'utf8', timeout:60000, maxBuffer:1024*1024,
    env:{...process.env, GIT_NO_REPLACE_OBJECTS:'1', GIT_TERMINAL_PROMPT:'0',
      ...(options.env || {})},
  });
  if (run.error || (!options.allowFailure && run.status !== 0))
    throw Error('git '+args[0]+' failed: '+
      (run.stderr || run.error?.message || 'exit '+run.status).trim().slice(0,250));
  return {code:run.status, text:run.stdout.trim(), err:run.stderr.trim()};
}
function refs(root, pattern) {
  const output = git(root, ['ls-remote','--heads','origin',pattern]).text;
  if (!output) return [];
  return output.split('\n').map(line => {
    const m = /^([0-9a-f]{40})\t(refs\/heads\/\S+)$/.exec(line);
    if (!m) throw Error('invalid remote ref listing');
    return {sha:m[1],ref:m[2]};
  });
}
function ancestor(root, proposal, knowledge) {
  if (!SHA.test(proposal) || !SHA.test(knowledge)) return false;
  const x = git(root,['merge-base','--is-ancestor',proposal,knowledge],{allowFailure:true});
  if (x.code === 0) return true;
  if (x.code === 1 || x.code === 128) return false;
  throw Error('unexpected ancestry status '+x.code);
}
function deleteWithLease(root, ref, sha, env = {}) {
  if (!VALID(ref) || !SHA.test(sha)) throw Error('unsafe proposal ref');
  // An atomic server-side lease prevents deleting a branch that moved.
  return git(root,['push','--porcelain','--force-with-lease='+ref+':'+sha,
    'origin',':'+ref],{allowFailure:true,env});
}
function authenticatedMain(root) {
  if (process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REPOSITORY !== 'BestNathan/nession' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      !['push','workflow_dispatch','issue_comment','repository_dispatch','workflow_run']
        .includes(process.env.GITHUB_EVENT_NAME) ||
      process.env.GITHUB_RUN_ATTEMPT !== '1' ||
      !SHA.test(process.env.GITHUB_SHA || '') ||
      !process.env.KNOWLEDGE_GIT_TOKEN || !process.env.RUNNER_TEMP)
    throw Error('approved trusted-main Knowledge App context required');
  if (git(root,['rev-parse','HEAD']).text !== process.env.GITHUB_SHA ||
      git(root,['rev-parse','--is-shallow-repository']).text !== 'false' ||
      !/^https:\/\/github\.com\/BestNathan\/nession(?:\.git)?$/.test(
        git(root,['remote','get-url','origin']).text))
    throw Error('trusted main checkout/full history/repository precondition failed');
}
function cleanup(root) {
  authenticatedMain(root);
  const initial = refs(root,'refs/heads/knowledge');
  if (initial.length !== 1 || initial[0].ref !== 'refs/heads/knowledge')
    throw Error('Knowledge branch missing');
  git(root,['fetch','--no-tags','origin','refs/heads/knowledge']);
  const head = git(root,['rev-parse','FETCH_HEAD']).text;
  if (head !== initial[0].sha || refs(root,'refs/heads/knowledge')[0]?.sha !== head)
    throw Error('Knowledge moved during readback');
  const proposals = refs(root,PREFIX+'*');
  if (proposals.length > 100) throw Error('proposal enumeration cap exceeded');
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'nession-knowledge-gc-'));
  const askpass = path.join(temp,'askpass.sh');
  fs.writeFileSync(askpass,
    '#!/bin/sh\ncase "$1" in\n'+
    '  *Username*) printf "%s\\n" x-access-token ;;\n'+
    '  *Password*) printf "%s\\n" "$KNOWLEDGE_GIT_TOKEN" ;;\n'+
    '  *) exit 1 ;;\nesac\n',{mode:0o700});
  const result = {knowledge_sha:head,scanned:proposals.length,deleted:[],skipped:[],failed:[]};
  try {
    for (const {sha,ref} of proposals) {
      if (!VALID(ref)) { result.skipped.push({ref,reason:'invalid'}); continue; }
      if (!ancestor(root,sha,head)) {
        result.skipped.push({ref,reason:'not_published'}); continue;
      }
      // Confirm each observed ref is unchanged before the atomic deletion lease.
      const current = refs(root,ref);
      if (!current.length) { result.skipped.push({ref,reason:'already_absent'}); continue; }
      if (current.length !== 1 || current[0].sha !== sha || current[0].ref !== ref) {
        result.skipped.push({ref,reason:'ref_moved'}); continue;
      }
      if (refs(root,'refs/heads/knowledge')[0]?.sha !== head)
        throw Error('Knowledge moved during cleanup');
      const attempt = deleteWithLease(root,ref,sha,{GIT_ASKPASS:askpass});
      const after = refs(root,ref);
      if (after.length === 0) result.deleted.push({ref,sha});
      else if (after[0].sha !== sha) result.skipped.push({ref,reason:'concurrent_move'});
      else result.failed.push({ref,reason:'delete_rejected',
        detail:attempt.err.slice(0,140)});
    }
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
  console.log(JSON.stringify(result));
  if (result.failed.length) throw Error('proposal deletions failed: '+result.failed.length);
}
function selfTest() {
  for (const ref of ['refs/heads/main','refs/heads/knowledge',
    'refs/heads/knowledge-proposals/a/b','refs/heads/knowledge-proposals/../main',
    'refs/heads/knowledge-proposals/-a','refs/heads/knowledge-proposals/a-',
    'refs/heads/knowledge-proposals/UPPER']) assert.equal(VALID(ref),false,ref);
  assert.equal(VALID(PREFIX+'issue-3773'),true);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-gc-fixture-'));
  const work = path.join(temp,'work'), remote = path.join(temp,'remote.git');
  try {
    fs.mkdirSync(work);
    git(temp,['init','--bare','-q',remote]);
    git(work,['init','-q']);
    git(work,['config','user.name','Fixture']);
    git(work,['config','user.email','fixture@example.invalid']);
    git(work,['remote','add','origin',remote]);
    fs.writeFileSync(path.join(work,'file'),'base\n');
    git(work,['add','.']); git(work,['commit','-qm','base']);
    const base = git(work,['rev-parse','HEAD']).text;
    fs.writeFileSync(path.join(work,'file'),'knowledge\n');
    git(work,['commit','-qam','knowledge']);
    const knowledge = git(work,['rev-parse','HEAD']).text;
    assert.equal(ancestor(work,base,knowledge),true);
    assert.equal(ancestor(work,knowledge,knowledge),true);
    git(work,['push','origin',knowledge+':refs/heads/knowledge']);
    git(work,['push','origin',base+':'+PREFIX+'eligible']);
    assert.equal(deleteWithLease(work,PREFIX+'eligible',base).code,0);
    assert.equal(refs(work,PREFIX+'eligible').length,0);
    git(work,['push','origin',base+':'+PREFIX+'moved']);
    git(work,['push','origin',knowledge+':'+PREFIX+'moved']);
    assert.notEqual(deleteWithLease(work,PREFIX+'moved',base).code,0);
    assert.equal(refs(work,PREFIX+'moved')[0].sha,knowledge);
    fs.writeFileSync(path.join(work,'file'),'not-published\n');
    git(work,['commit','-qam','unpublished']);
    assert.equal(ancestor(work,git(work,['rev-parse','HEAD']).text,knowledge),false);
    assert.throws(()=>deleteWithLease(work,'refs/heads/knowledge',base));
    console.log('knowledge-proposal-cleanup self-test passed: ancestry, deletion, lease and protected refs');
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
try {
  if (process.argv[2] === 'self-test') selfTest();
  else if (process.argv[2] === 'cleanup') cleanup(process.cwd());
  else throw Error('usage: self-test | cleanup');
} catch(e) {
  console.error('knowledge-proposal-cleanup: '+e.message);
  process.exitCode=1;
}
