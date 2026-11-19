#!/usr/bin/env node
// #4032: GHCR controls deployment. ACR is replication-only and observable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const FILES=[
  '.github/workflows/deploy-staging-ghcr.yml',
  '.github/workflows/deploy-staging-acr.yml',
  '.github/workflows/deploy-identity.yml',
  '.github/workflows/release-staging-convergence.yml',
  'scripts/gitops-commit.sh',
  'scripts/staging-convergence-readiness.mjs',
  'scripts/staging-branch-convergence.mjs'
];
export function checkSources(f) {
  const get=p=>{assert.ok(f.has(p),'missing '+p);return f.get(p);};
  const gh=get(FILES[0]),acr=get(FILES[1]),identity=get(FILES[2]);
  const convergence=get(FILES[3]),writer=get(FILES[4]);
  assert.match(gh,/name: Deploy \/ Staging GHCR/);
  assert.match(gh,/verify-staging-ghcr-source\.mjs wait "\$GITHUB_SHA"/);
  assert.match(gh,/needs: verify-source/);
  assert.match(gh,/source_run_id/);
  assert.match(gh,/source_run_attempt/);
  assert.match(gh,/Verify exact-source GHCR digests and update Staging GitOps/);
  assert.match(gh,/scripts\/gitops-commit\.sh staging/);
  assert.match(gh,/group: gitops-writer/);
  assert.doesNotMatch(gh,/ALIYUN_ACR_|crpi-ck06yio90i1ttwlz|mirror-acr:/);
  assert.match(acr,/image: \[server, agent, mcp, ui\]/);
  assert.match(acr,/mirror-acr:/);
  assert.doesNotMatch(acr,/deploy-staging-gitops:|scripts\/gitops-commit\.sh|contents: write/);
  assert.match(writer,/TARGET_IMAGE="\$\{SOURCE_IMAGE\}"/);
  assert.doesNotMatch(writer,/TARGET_IMAGE="crpi-|ACR image .*unavailable/);
  assert.match(writer,/for img in server agent ui mcp; do/);
  assert.match(writer,/DEPLOY_SOURCE_SHA/);
  for(const text of [identity,convergence,get(FILES[5]),get(FILES[6])]){
    assert.match(text,/deploy-staging-ghcr\.yml/);
    assert.doesNotMatch(text,/deploy-staging-acr\.yml|Deploy \/ Staging ACR/);
  }
  assert.match(identity,/sources=\(release-staging\.yml\)/);
  assert.match(convergence,/Deploy \/ Staging GHCR/);
}
function selfTest(){
  const baseline=new Map(FILES.map(p=>[p,fs.readFileSync(path.join(ROOT,p),'utf8')]));
  checkSources(baseline);
  const fixtures=[
    [FILES[0],s=>s.replace('needs: verify-source','needs: mirror-acr')],
    [FILES[0],s=>s.replaceAll('source_run_attempt','wrong_attempt')],
    [FILES[0],s=>s.replace('group: gitops-writer','group: unsafe-writer')],
    [FILES[0],s=>s+'\n# ALIYUN_ACR_PASSWORD must not enter deploy\n'],
    [FILES[1],s=>s+'\n  deploy-staging-gitops:\n'],
    [FILES[1],s=>s.replace('image: [server, agent, mcp, ui]','image: [server, agent, ui]')],
    [FILES[2],s=>s.replace('deploy-staging-ghcr.yml','deploy-staging-acr.yml')],
    [FILES[3],s=>s.replace('Deploy / Staging GHCR','Deploy / Staging ACR')],
    [FILES[4],s=>s.replace('TARGET_IMAGE="${SOURCE_IMAGE}"','TARGET_IMAGE="crpi-mirror/nession"')],
    [FILES[4],s=>s.replace('for img in server agent ui mcp; do','for img in server agent ui; do')],
    [FILES[5],s=>s.replace('deploy-staging-ghcr.yml','deploy-staging-acr.yml')],
  ];
  for(const [p,mutate] of fixtures){
    const changed=new Map(baseline),next=mutate(baseline.get(p));
    assert.notEqual(next,baseline.get(p),'fixture did not mutate '+p);
    changed.set(p,next);assert.throws(()=>checkSources(changed),'fixture must fail '+p);
  }
  console.log('GHCR GitOps independent ACR: baseline plus '+fixtures.length+' negative cases passed');
}
if(process.argv[2]==='--self-test')selfTest();
else throw Error('usage: ghcr-gitops-separation.mjs --self-test');
