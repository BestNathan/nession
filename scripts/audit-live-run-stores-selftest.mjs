import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {AUDITED_STORES,parseProtectedAnchors,auditLiveRunStores} from './audit-live-run-stores.mjs';

function git(root,...args) {
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
  }).trim();
}
function write(root,file,content) {
  const dest=path.join(root,file);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,content);
}
const sha='f'.repeat(40);
assert.throws(()=>parseProtectedAnchors(''),/anchor secret/);
assert.throws(()=>parseProtectedAnchors('{"metrics":"x"}'),/exact store/);
assert.throws(()=>parseProtectedAnchors(JSON.stringify({
  'acceptance-results':sha,'task-results':sha,metrics:sha,'new-ref':sha,
})),/exact store/);
assert.deepEqual(Object.keys(parseProtectedAnchors(JSON.stringify(Object.fromEntries(
  AUDITED_STORES.map(s=>[s,sha]))))),[...AUDITED_STORES]);

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-live-audit-fixture-'));
try {
  const repo=path.join(tmp,'repo'),remote=path.join(tmp,'origin.git');
  fs.mkdirSync(repo);
  git(repo,'init','-qb','main');
  git(repo,'config','user.name','Nession Fixture');
  git(repo,'config','user.email','fixture@example.invalid');
  write(repo,'README.md','trusted main\n');
  git(repo,'add','README.md');git(repo,'commit','-qm','trusted source');
  const sourceSha=git(repo,'rev-parse','HEAD');
  git(tmp,'init','--bare','-q',remote);
  git(repo,'remote','add','origin',remote);
  git(repo,'push','-q','origin','main');
  const anchors={},originalTips={};
  for(const store of AUDITED_STORES) {
    git(repo,'checkout','-q','--orphan',store);
    git(repo,'rm','-rfq','.');
    write(repo,'README.md','migration baseline\n');
    git(repo,'add','-A');git(repo,'commit','-qm','baseline');
    anchors[store]=git(repo,'rev-parse','HEAD');
    const entry=store==='metrics'
      ? 'raw/workflows/agent-provider-smoke/2026-10-14/canary.json'
      : 'runs/2026-10-14/100-1.json';
    write(repo,entry,'{"result":"valid"}\n');
    git(repo,'add','-A');git(repo,'commit','-qm','append immutable');
    originalTips[store]=git(repo,'rev-parse','HEAD');
    git(repo,'push','-q','origin',store);
  }
  git(repo,'checkout','-q','main');
  const api=async(url,opts)=>{
    assert.equal(opts.method,'GET');
    assert.equal(opts.redirect,'error');
    assert.ok(opts.headers.Authorization.startsWith('Bearer '));
    const store=url.split('/').at(-1);
    return {ok:true,json:async()=>({ref:'refs/heads/'+store,
      object:{type:'commit',sha:git(remote,'rev-parse','refs/heads/'+store)}})};
  };
  const base={checkout:repo,sourceSha,anchors,token:'fixture-readonly-token',
    fetchFn:api};
  const result=await auditLiveRunStores(base);
  assert.equal(result.passed,true);
  assert.equal(result.records.length,3);
  // `git rev-parse --show-toplevel` resolves symlinks, so the root comparison
  // must realpath both sides. Reaching the same checkout through a symlinked
  // ancestor is the same tree and must be accepted — otherwise the check can
  // never pass on a host whose tmpdir is a symlink (darwin: /var -> /private/var).
  const alias=path.join(tmp,'alias');
  fs.symlinkSync(tmp,alias);
  assert.equal((await auditLiveRunStores({...base,
    checkout:path.join(alias,'repo')})).passed,true);
  // The counterexample: a directory INSIDE the same tree at the same SHA is not
  // the checkout root and must still be rejected, proving the realpath change
  // did not turn the identity check into a no-op.
  const nested=path.join(repo,'scripts');
  fs.mkdirSync(nested,{recursive:true});
  assert.equal(git(nested,'rev-parse','HEAD'),sourceSha);
  assert.equal(git(nested,'rev-parse','--show-toplevel'),fs.realpathSync(repo));
  await assert.rejects(()=>auditLiveRunStores({...base,checkout:nested}),
    /SHA\/root mismatch/);
  const baselineTrees=Object.fromEntries(AUDITED_STORES.map(store=>[
    store,git(remote,'rev-parse',anchors[store]+'^{tree}')]));
  const migrated={...base,anchorTrust:'main_migration_observation',baselineTrees};
  const migrationResult=await auditLiveRunStores(migrated);
  assert.equal(migrationResult.anchoring,'repository_main_migration_observation_only');
  assert.equal(migrationResult.historical_provenance_trust,'not_independent_or_retroactive');
  await assert.rejects(()=>auditLiveRunStores({...migrated,
    baselineTrees:{...baselineTrees,metrics:'f'.repeat(40)}}),
    /migration baseline tree identity does not match/);
  await assert.rejects(()=>auditLiveRunStores({...base,anchorTrust:'main_migration_observation'}),
    /migration baseline tree identity does not match/);
  assert.ok(result.records.every(x=>x.checked_changes===1&&x.checked_commits===1));
  assert.throws(()=>parseProtectedAnchors(JSON.stringify({
    ...anchors,metrics:'0'.repeat(39),
  })),/exact store/);
  await assert.rejects(()=>auditLiveRunStores({...base,sourceSha:'a'.repeat(40)}),
    /trusted main checkout/);
  await assert.rejects(()=>auditLiveRunStores({...base,token:''}),/credential/);
  await assert.rejects(()=>auditLiveRunStores({...base,
    fetchFn:async()=>({ok:true,json:async()=>({ref:'refs/heads/evil',
      object:{type:'commit',sha}})})}),/untrusted GitHub ref/);
  await assert.rejects(()=>auditLiveRunStores({...base,
    fetchFn:async(url,opts)=>{
      const x=await api(url,opts);
      if(url.endsWith('/metrics'))return {ok:true,json:async()=>({ref:'refs/heads/metrics',
        object:{type:'commit',sha}})};
      return x;
    },
  }),/API and fetched Git ref disagree/);

  // Malicious ordinary fast-forward edit: baseline ancestry still holds, but
  // the canonical Git delta audit must reject the historical blob overwrite.
  git(repo,'checkout','-q','metrics');
  write(repo,'raw/workflows/agent-provider-smoke/2026-10-14/canary.json',
    '{"result":"forged"}\n');
  git(repo,'add','-A');git(repo,'commit','-qm','malicious fast-forward edit');
  git(repo,'push','-q','origin','metrics');
  git(repo,'checkout','-q','main');
  await assert.rejects(()=>auditLiveRunStores(base),/forbidden metrics M/);

  // A separately pinned last-known-good head must additionally detect a
  // history-reset/ref replacement, even if the new path additions are valid.
  git(repo,'checkout','-q','task-results');
  git(repo,'reset','--hard','HEAD~1');
  write(repo,'runs/2026-10-14/other.json','{"result":"fork"}\n');
  git(repo,'add','-A');git(repo,'commit','-qm','replacement after baseline');
  git(repo,'push','-q','--force','origin','task-results');
  git(repo,'checkout','-q','main');
  const tipAnchors={...anchors};
  // Pin the original observed tip independently; the replacement omits it.
  tipAnchors['task-results']=originalTips['task-results'];
  await assert.rejects(()=>auditLiveRunStores({...base,anchors:tipAnchors}),
    /baseline is not ancestor|checkout HEAD differs/);
  console.log('live anchored Run Store audit fixtures: three refs, API cross-check, malicious fast-forward, forged ref and history reset passed');
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
