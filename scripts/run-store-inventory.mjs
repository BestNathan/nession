#!/usr/bin/env node
// Canonical, main-owned Run Store governance inventory. Only the read-only live
// probe claims GitHub protection state; source analysis is never enforcement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RUN_STORE_REFS} from './run-store-integrity.mjs';

const REPO='BestNathan/nession',HEX40=/^[0-9a-f]{40}$/;
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifestPath=path.join(ROOT,'scripts/run-store-inventory.json');
const fail=m=>{throw Error('run-store-inventory: '+m)};
const read=p=>fs.readFileSync(p,'utf8');
const data=()=>JSON.parse(read(manifestPath));
const refPattern=/(?:refs\/heads\/)?(acceptance-results|task-results|agent-store|metrics)(?:\b|$)/g;

export function findStorePushes(workflow){
  const entries=[];
  for(const [i,line] of workflow.split(/\r?\n/).entries()){
    const direct=/^\s*(?:-\s*run:\s*)?git(?:\s+-C\s+[^\s]+)?\s+push\b/.test(line);
    const cas=/^\s*node\s+\S*run-store-cas-push\.mjs["']?\s+(acceptance-results|task-results|metrics|agent-store)\s/.exec(line);
    if(!direct&&!cas)continue;
    const refs=cas?[cas[1]]:[...line.matchAll(refPattern)].map(x=>x[1]);
    for(const ref of new Set(refs))
      entries.push({ref,line:i+1,command:line.trim(),kind:cas?'cas':'direct'});
  }
  return entries;
}
export function checkInventory(manifest,workflows){
  if(manifest?.schema_version!==1||manifest.kind!=='run_store_writer_inventory'||
     manifest.repository!==REPO||!Array.isArray(manifest.stores))
    fail('invalid inventory schema or repository');
  const refs=manifest.stores.map(x=>x.ref);
  if(new Set(refs).size!==refs.length||
     JSON.stringify([...refs].sort())!==JSON.stringify([...RUN_STORE_REFS].sort()))
    fail('inventory stores diverge from canonical run-store-integrity refs');
  const seen=new Map();
  for(const store of manifest.stores){
    if(!['active','planned'].includes(store.lifecycle)||
       !Array.isArray(store.writers)||store.writers.length>20)
      fail('invalid Store state or writer inventory: '+store.ref);
    if(store.lifecycle==='active'&&!store.writers.length)
      fail('active orphan Store is missing writer inventory: '+store.ref);
    if(store.lifecycle==='planned'&&store.writers.length)
      fail('planned Store must not claim an active writer: '+store.ref);
    if(store.ref==='agent-store'&&
       (store.lifecycle!=='active'||
        !String(store.rollout_blocker??'').includes('UNPROVEN')||
        !String(store.rollout_blocker??'').includes('Ruleset')))
      fail('real Agent Store and deferred admin proof must be classified honestly');
    // Even a disposable App smoke has the repository-scoped writer key.
    // Branch-selectable manual code could ignore its main-only job guard.
    if(store.ref==='agent-store'){
      const smoke=workflows.get('.github/workflows/store-app-writer-smoke.yml');
      const header=typeof smoke==='string'
        ?smoke.split(/^permissions:\s*$/m)[0]:null;
      const events=typeof header==='string'
        ?[...header.matchAll(/^  ([a-z_]+):/gm)].map(x=>x[1]):[];
      if(typeof smoke!=='string'||
         !/^name: Store \/ App Writer Smoke$/m.test(smoke)||
         JSON.stringify(events)!==JSON.stringify(['push'])||
         !/^on:\s*\n  push:\s*\n    branches: \[main\]/m.test(header)||
         !smoke.includes("github.ref == 'refs/heads/main'")||
         !/^  contents: read$/m.test(smoke)||
         !smoke.includes('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')||
         !smoke.includes('vars.RUN_STORE_WRITER_APP_ID')||
         !smoke.includes('secrets.RUN_STORE_WRITER_APP_PRIVATE_KEY')||
         !smoke.includes('permission-contents: write')||
         !smoke.includes('run-store-smoke/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}'))
        fail('App Writer Smoke must use trusted main push only; no ref-selected privileged dispatch');
    }
    // The real agent-store bootstrap has a scoped App private key. Unlike
    // workflow_run/issue_comment it must NOT permit arbitrary-ref manual
    // dispatch: the caller can select changed workflow YAML and bypass a
    // job-level main guard before token minting.
    if(store.ref==='agent-store'){
      const source=workflows.get('.github/workflows/store-agent-bootstrap.yml');
      const triggers=typeof source==='string'
        ?source.split(/^permissions:\s*$/m)[0]:null;
      const events=typeof triggers==='string'
        ?[...triggers.matchAll(/^  ([a-z_]+):/gm)].map(x=>x[1]):[];
      if(typeof source!=='string'||
         !/^name: Store \/ Agent Bootstrap$/m.test(source)||
         !/^on:\s*\n  push:\s*\n    branches: \[main\]/m.test(triggers)||
         JSON.stringify(events)!==JSON.stringify(['push'])||
         !/^[ \t]+paths:\s*$/m.test(triggers)||
         !/^  contents: read$/m.test(source)||
         !source.includes("github.ref == 'refs/heads/main'")||
         !source.includes('ref: ${{ github.sha }}')||
         !source.includes('persist-credentials: false')||
         !source.includes('node scripts/lib/agent/store/bootstrap.mjs self-test')||
         !source.includes('node scripts/lib/agent/store/bootstrap.mjs --apply')||
         !source.includes('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')||
         !source.includes('vars.RUN_STORE_WRITER_APP_ID')||
         !source.includes('secrets.RUN_STORE_WRITER_APP_PRIVATE_KEY')||
         !source.includes('permission-contents: write'))
        fail('Agent Store bootstrap must use authenticated main push only; no ref-selected privileged dispatch');
    }
    // A deployable, but not yet live-proven, candidate Store writer MUST be
    // inventoried separately from active writers; a raw manual dispatch must
    // never be granted App credentials regardless of its main-only job guard.
    if(store.ref==='agent-store'&&store.controller_rollout){
      const rollout=store.controller_rollout;
      const requestPath='.github/workflows/acceptance-agent-controller.yml';
      const writerPath='.github/workflows/store-agent-controller-ingest.yml';
      if(store.lifecycle!=='active'||store.writers.length!==5||
          rollout.phase!=='live-verified-limited-trust'||
          rollout.request_workflow!==requestPath||
          rollout.trusted_writer_workflow!==writerPath)
        fail('unreviewed Controller Store rollout status');
      const request=workflows.get(requestPath),writer=workflows.get(writerPath);
      if(typeof request!=='string'||typeof writer!=='string'||
         !/^name: Acceptance \/ Agent Controller$/m.test(request)||
         !/^  workflow_dispatch:$/m.test(request)||
         !request.includes("github.ref == 'refs/heads/main'")||
         !request.includes("github.actor == 'BestNathan'")||
         !/^  contents: read$/m.test(request)||
         !/^  issues: read$/m.test(request)||
         !request.includes('node scripts/lib/agent/orchestration/controller-request.mjs prepare')||
         /RUN_STORE_WRITER_APP_|actions\/create-github-app-token|permission-contents: write|^\s+contents: write$|^\s+issues: write$/m.test(request))
        fail('Controller manual request must be unprivileged owner/main-only');
      if(!/^name: Store \/ Agent Controller Ingest$/m.test(writer)||
         !/^  workflow_run:$/m.test(writer)||
         /^  (workflow_dispatch|repository_dispatch):$/m.test(writer)||
         !writer.includes('workflows: ["Acceptance / Agent Controller"]')||
         !writer.includes('    branches: [main]')||
         !writer.includes("github.event.workflow_run.actor.login == 'BestNathan'")||
         !writer.includes('ref: main')||
         !writer.includes('persist-credentials: false')||
         !writer.includes('node scripts/lib/agent/orchestration/controller-request.mjs verify-source')||
         !writer.includes('node scripts/lib/agent/orchestration/controller-request.mjs consume')||
         !writer.includes('node scripts/lib/agent/orchestration/controller-start.mjs')||
         !writer.includes('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')||
         !writer.includes('permission-contents: write')||
         !writer.includes('vars.RUN_STORE_WRITER_APP_ID')||
         !writer.includes('secrets.RUN_STORE_WRITER_APP_PRIVATE_KEY')||
         !writer.includes('STORE_APP_TOKEN: ${{ steps.writer.outputs.token }}'))
        fail('Controller Store ingester is not authenticated main-owned scoped App writer');
    }
    if(store.ref==='agent-store'){
      // Real scoped App Writers are not the six legacy CAS Workflow wrappers:
      // they invoke the shared CAS publisher via trusted Controller modules.
      // Maintain an explicit, exhaustive limited-trust writer roster, including
      // bootstrap and reconciliation. It MUST NOT be mislabeled server-enforced.
      const approved=new Map([
        ['.github/workflows/store-agent-bootstrap.yml',['bootstrap','main_push_only']],
        ['.github/workflows/store-agent-controller-ingest.yml',['controller_initialization','main_workflow_run']],
        ['.github/workflows/agent-controller-dispatch.yml',['controller_dispatch','owner_main_dispatch_or_issue_comment']],
        ['.github/workflows/store-agent-development-ingest.yml',['encrypted_checkpoint_ingest','main_workflow_run_or_owner_comment']],
        ['.github/workflows/store-agent-dispatch-reconcile.yml',['failed_dispatch_reconcile','main_workflow_run']],
      ]);
      if(store.writers.length!==approved.size)fail('incomplete live agent-store writer roster');
      for(const writer of store.writers){
        const expected=approved.get(writer.workflow);
        if(!expected||writer.mode!==expected[0]||writer.event!==expected[1]||
           writer.source!=='scoped GitHub App installation token'||
           writer.credential_boundary!=='main-owned privileged job; no model-provided writer token'||
           writer.app_id_variable!=='RUN_STORE_WRITER_APP_ID'||
           writer.app_private_key_secret!=='RUN_STORE_WRITER_APP_PRIVATE_KEY'||
           writer.app_scope!=='nession: contents write')
          fail('unclassified active agent-store writer or credential boundary');
        const body=workflows.get(writer.workflow);
        if(typeof body!=='string'||
           !body.includes('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')||
           !body.includes('vars.RUN_STORE_WRITER_APP_ID')||
           !body.includes('secrets.RUN_STORE_WRITER_APP_PRIVATE_KEY')||
           !body.includes('permission-contents: write')||
           !body.includes('repositories: nession')||
           !body.includes('persist-credentials: false')||
           !body.includes("github.repository == 'BestNathan/nession'"))
          fail('real agent-store Writer lacks trusted main/App path');
        const triggers=body.split(/^permissions:\s*$/m)[0];
        const needs=writer.event;
        if((needs==='main_push_only'&&
              (!/^  push:\s*$/m.test(triggers)||/^  workflow_dispatch:\s*$/m.test(triggers)))||
           (needs==='main_workflow_run'&&
              (!/^  workflow_run:\s*$/m.test(triggers)||/^  workflow_dispatch:\s*$/m.test(triggers)))||
           (needs==='owner_main_dispatch_or_issue_comment'&&
              (!/^  issue_comment:\s*$/m.test(triggers)||!/^  workflow_dispatch:\s*$/m.test(triggers)))||
           (needs==='main_workflow_run_or_owner_comment'&&
              (!/^  workflow_run:\s*$/m.test(triggers)||!/^  issue_comment:\s*$/m.test(triggers)||
               /^  workflow_dispatch:\s*$/m.test(triggers))))
          fail('active agent-store Writer trigger deviates from declared limited-trust profile');
        if(seen.has(writer.workflow+'|agent-store'))fail('duplicate active agent-store Writer');
        seen.set(writer.workflow+'|agent-store',writer);
        approved.delete(writer.workflow);
      }
      if(approved.size!==0)fail('missing active agent-store privileged Writer');
      // #1664 owns native Session crypto/CAS; #1690's independent anchors and
      // server-side ordinary-fast-forward denial remain Pending. Do not claim
      // they are verified merely because these trusted-main Workflow forms exist.
      continue;
    }
    for(const writer of store.writers){
      if(!/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(writer.workflow)||
         writer.source!=='github-actions GITHUB_TOKEN (legacy) or scoped GitHub App installation token (app rollout)'||
         !String(writer.execution).includes('main-owned')||
         !Array.isArray(writer.depends_on)||
         !Array.isArray(writer.permissions)||
         !writer.permissions.includes('contents: write'))
        fail('unclassified writer identity/authority/dependency: '+store.ref);
      const body=workflows.get(writer.workflow);
      if(typeof body!=='string')fail('writer workflow missing: '+writer.workflow);
      const app=writer.app_token;
      if(app?.when!=='RUN_STORE_WRITER_MODE unset or app; legacy explicitly rolls back'||
         app.app_id_variable!=='RUN_STORE_WRITER_APP_ID'||
         app.private_key_secret!=='RUN_STORE_WRITER_APP_PRIVATE_KEY'||
         app.scope!=='nession: contents write'||app.trusted_job_only!==true)
        fail('unclassified App writer identity or token scope: '+writer.workflow);
      // Every checkout step is a distinct credential boundary. A single
      // harmless checkout with persist-credentials:false elsewhere in the YAML
      // must NOT mask a credential-bearing checkout in a contents:write job.
      const steps=body.split(/^      - /m);
      const checkouts=steps.filter(step=>/^\s*(?:name:[^\n]*\n\s*)?uses: actions\/checkout@v4\b/m.test(step));
      if(checkouts.length===0||
         checkouts.some(step=>!/^\s*persist-credentials:\s*false\s*$/m.test(step)))
        fail('privileged Store writer checkout persists credentials: '+writer.workflow);
      // #1690 SC-09: a privileged writer must not accept arbitrary ref-
      // selected workflow_dispatch or attacker-selected repository_dispatch.
      // Such events can run branch-selected workflow code with contents:write,
      // irrespective of whether its default-branch YAML has a guarded job.
      const triggers=body.split(/^permissions:\s*$/m)[0];
      if(!/^on:\s*$/m.test(triggers)||
         !/^  (workflow_run|schedule):\s*$/m.test(triggers)||
         /^  (workflow_dispatch|repository_dispatch):\s*$/m.test(triggers))
        fail('untrusted manual dispatch/trigger on privileged Store writer: '+writer.workflow);
      const trustedSource=writer.workflow==='.github/workflows/metrics-repository.yml'
        ? body.includes('ref: ${{ github.sha }}')&&
          body.includes("github.ref == 'refs/heads/main'")
        : body.includes('ref: main');
      if(!trustedSource)
        fail('privileged Store writer must checkout trusted main without persisted credentials: '+writer.workflow);
      if(writer.workflow==='.github/workflows/metrics-repository.yml'){
        const request=workflows.get('.github/workflows/metrics-replay-request.yml');
        // The manual workflow can execute at an attacker-selected ref, so it
        // must NEVER possess Store credentials. Only its authenticated REST
        // run identity wakes this separate, trusted-main privileged workflow.
        if(typeof request!=='string'||
           !/^name: Metrics \/ Replay Request\s*$/m.test(request)||
           !/^  workflow_dispatch:\s*$/m.test(request)||
           !/^permissions:\s*\n  contents: read\s*$/m.test(request)||
           !request.includes("github.ref == 'refs/heads/main'")||
           !request.includes("github.actor == 'BestNathan'")||
           /contents: write|actions: write|repository_dispatch:|RUN_STORE_WRITER_APP_PRIVATE_KEY|actions\/checkout@|actions\/create-github-app-token/.test(request))
          fail('untrusted or privilege-bearing Metrics Replay request workflow');
        if(!/^  schedule:\s*$/m.test(triggers)||
           !/^  workflow_run:\s*\n    workflows: \["Metrics \/ Replay Request"\]\s*\n    types: \[completed\]/m.test(triggers)||
           /^  workflow_dispatch:\s*$/m.test(triggers)||
           !body.includes("node scripts/metrics-replay-source.mjs authorize")||
           !body.includes('  authorize-replay:')||
           !body.includes("github.event_name == 'schedule' || github.event_name == 'workflow_run'")||
           (body.match(/needs: authorize-replay/g)||[]).length!==3||
           (body.match(/needs\.authorize-replay\.result == 'success'/g)||[]).length!==4||
           !body.includes('needs: [authorize-replay, rust-health, web-health, e2e-health]')||
           !body.includes('        GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}'))
          fail('Metrics publisher must remain schedule-or-attested-request only, with all jobs gated');
      }
      // Source check does not prove runtime token possession or GitHub Ruleset
      // enforcement. It fails closed if a writer loses the controlled App path.
      if(!body.includes('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')||
         !body.includes('vars.RUN_STORE_WRITER_MODE')||
         !body.includes("if: (vars.RUN_STORE_WRITER_MODE == '' || vars.RUN_STORE_WRITER_MODE == 'app')")||
         !body.includes("vars.RUN_STORE_WRITER_MODE == 'legacy' && secrets.GITHUB_TOKEN || steps.store_app.outputs.token")||
         !/^(?:\s+)legacy\) ;;\s*$/m.test(body)||
         !body.includes("''|app) [[ -n \"$APP_TOKEN\" ]]")||
         !body.includes('vars.RUN_STORE_WRITER_APP_ID')||
         !body.includes('secrets.RUN_STORE_WRITER_APP_PRIVATE_KEY')||
         !/repositories:\s*nession\s*$/m.test(body)||
         !/permission-contents:\s*write\s*$/m.test(body)||
         !body.includes('refuse legacy fallback')||
         !body.includes('steps.store_app.outputs.token'))
        fail('missing pinned and scoped App migration path: '+writer.workflow);
      if(writer.workflow.endsWith('/e2e-test-ingest.yml')&&
         (body.match(/id: store_app/g)||[]).length!==2)
        fail('both E2E Test/PR writers require independent scoped App tokens');
      if(!/^\s+contents:\s*write\s*$/m.test(body)||
         !/secrets\.GITHUB_TOKEN/.test(body))
        fail('writer lacks declared contents:write/token source: '+writer.workflow);
      for(const perm of writer.permissions){
        if(!/^(?:contents|issues|pull-requests|actions): (?:read|write)$/.test(perm))
          fail('unknown writer permission');
        if(!new RegExp('^\\s+'+perm.replace(': ',':\\s*')+'\\s*$','m').test(body))
          fail('declared writer permissions differ: '+writer.workflow);
      }
      for(const dep of writer.depends_on){
        if(!/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(dep)||
           !workflows.has(dep))
          fail('unclassified upstream dependency: '+dep);
      }
      const actual=findStorePushes(body);
      if(!actual.some(p=>p.ref===store.ref&&p.kind==='cas'))
        fail('writer is not using the bounded CAS Store publisher: '+writer.workflow+' '+store.ref);
      if(actual.some(p=>p.ref===store.ref&&p.kind==='direct'))
        fail('unwrapped Git Store push bypasses CAS: '+writer.workflow+' '+store.ref);
      const key=writer.workflow+'|'+store.ref;
      if(seen.has(key))fail('duplicate Store writer declaration: '+key);
      seen.set(key,writer);
    }
  }
  for(const [workflow,body] of workflows){
    for(const push of findStorePushes(body)){
      if(!seen.has(workflow+'|'+push.ref))
        fail('unknown privileged Store push '+workflow+':'+push.line+' -> '+push.ref);
    }
  }
  if(!manifest.governance||
     manifest.governance.writer_rollout!=='app-by-default after verified main smoke; explicit legacy rollback; no Ruleset before production App ingestion checks'||
     manifest.governance.ruleset_enforcement!=='unknown_until_live_probe'||
     manifest.governance.branch_protection!=='unknown_until_live_probe'||
     manifest.governance.independent_anchor!=='pending_offline_admin_control')
    fail('static inventory must not assert live protection or independent anchoring');
  return {schema_version:1,stores:refs.length,writers:seen.size,
    workflows_checked:workflows.size,
    status:'source-inventory-proven; remote Rulesets require authenticated live probe'};
}
function workflows(root=ROOT){
  const dir=path.join(root,'.github/workflows');
  return new Map(fs.readdirSync(dir).filter(x=>x.endsWith('.yml'))
    .map(x=>['.github/workflows/'+x,read(path.join(dir,x))]));
}
function selfTest(){
  const manifest=data(),sources=workflows(),success=checkInventory(manifest,sources);
  const trusted={GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',
    GITHUB_SHA:'a'.repeat(40)};
  for(const event of ['push','schedule','workflow_dispatch'])
    assert.equal(assertTrustedLiveContext({...trusted,GITHUB_EVENT_NAME:event}),true);
  for(const invalid of [
    {...trusted,GITHUB_EVENT_NAME:'pull_request_target'},
    {...trusted,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/feature'},
    {...trusted,GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:'attacker/fork'},
    {...trusted,GITHUB_EVENT_NAME:'push',GITHUB_SHA:'main'},
  ]) assert.throws(()=>assertTrustedLiveContext(invalid),/trusted main/);
  assert.equal(success.writers,11);
  const agentStore=manifest.stores.find(x=>x.ref==='agent-store');
  assert.equal(agentStore.lifecycle,'active');
  const unknownAgentWriter=JSON.parse(JSON.stringify(manifest));
  unknownAgentWriter.stores.find(x=>x.ref==='agent-store').writers[0].workflow=
    '.github/workflows/untrusted-agent-writer.yml';
  assert.throws(()=>checkInventory(unknownAgentWriter,sources),/unclassified active agent-store writer/);
  const missingAgentWriter=JSON.parse(JSON.stringify(manifest));
  missingAgentWriter.stores.find(x=>x.ref==='agent-store').writers.pop();
  assert.throws(()=>checkInventory(missingAgentWriter,sources),/incomplete live agent-store writer roster|unreviewed Controller Store rollout status/);
  const falselyProtectedAgent=JSON.parse(JSON.stringify(manifest));
  falselyProtectedAgent.stores.find(x=>x.ref==='agent-store').rollout_blocker=
    'all requirements passed';
  assert.throws(()=>checkInventory(falselyProtectedAgent,sources),
    /deferred admin proof must be classified honestly/);
  const leakingAgentWriter=new Map(sources);
  const agentWriter='.github/workflows/agent-controller-dispatch.yml';
  leakingAgentWriter.set(agentWriter,leakingAgentWriter.get(agentWriter)
    .replace('persist-credentials: false','persist-credentials: true'));
  assert.throws(()=>checkInventory(manifest,leakingAgentWriter),
    /real agent-store Writer lacks trusted main\/App path/);
  const bootstrapPath='.github/workflows/store-agent-bootstrap.yml';
  const bootstrapSource=sources.get(bootstrapPath);
  for(const [label,mutate] of [
    ['arbitrary-ref manual workflow',s=>s.replace(/^  push:/m,'  workflow_dispatch:\n  push:')],
    ['untrusted branch selection',s=>s.replace('    branches: [main]','    branches: [main, feature]')],
    ['missing trusted checkout',s=>s.replace('ref: ${{ github.sha }}','ref: ${{ github.head_ref }}')],
    ['unscoped writer token',s=>s.replace('permission-contents: write','permission-contents: read')],
    ['inherited checkout credential',s=>s.replace('persist-credentials: false','persist-credentials: true')],
  ]){
    const changed=mutate(bootstrapSource);
    assert.notEqual(changed,bootstrapSource,'fixture must change '+label);
    const candidate=new Map(sources);candidate.set(bootstrapPath,changed);
    assert.throws(()=>checkInventory(manifest,candidate),
      /Agent Store bootstrap must use authenticated main push only/,label);
  }
  const smokePath='.github/workflows/store-app-writer-smoke.yml';
  const smokeSource=sources.get(smokePath);
  for(const [label,mutate] of [
    ['arbitrary-ref App smoke',s=>s.replace(/^  push:/m,'  workflow_dispatch:\n  push:')],
    ['untrusted App smoke branch',s=>s.replace('    branches: [main]','    branches: [main, feature]')],
    ['missing App smoke main guard',s=>s.replace("github.ref == 'refs/heads/main'","github.ref == 'refs/heads/feature'")],
    ['weakened App smoke token',s=>s.replace('permission-contents: write','permission-contents: read')],
  ]){
    const changed=mutate(smokeSource);
    assert.notEqual(changed,smokeSource,'fixture must change '+label);
    const candidate=new Map(sources);candidate.set(smokePath,changed);
    assert.throws(()=>checkInventory(manifest,candidate),
      /App Writer Smoke must use trusted main push only/,label);
  }
  const controllerRequest='.github/workflows/acceptance-agent-controller.yml';
  const controllerWriter='.github/workflows/store-agent-controller-ingest.yml';
  const unsafeControllerRequest=new Map(sources);
  unsafeControllerRequest.set(controllerRequest,unsafeControllerRequest.get(controllerRequest)
    .replace('  contents: read','  contents: write'));
  assert.throws(()=>checkInventory(manifest,unsafeControllerRequest),
    /Controller manual request must be unprivileged/);
  const unsafeControllerActor=new Map(sources);
  unsafeControllerActor.set(controllerRequest,unsafeControllerActor.get(controllerRequest)
    .replace("github.actor == 'BestNathan'","github.actor == 'anyone'"));
  assert.throws(()=>checkInventory(manifest,unsafeControllerActor),
    /Controller manual request must be unprivileged/);
  const unsafeControllerWriter=new Map(sources);
  unsafeControllerWriter.set(controllerWriter,unsafeControllerWriter.get(controllerWriter)
    .replace(/^  workflow_run:$/m,'  workflow_dispatch:'));
  assert.throws(()=>checkInventory(manifest,unsafeControllerWriter),
    /Controller Store ingester is not authenticated/);
  const unsafeControllerCheckout=new Map(sources);
  unsafeControllerCheckout.set(controllerWriter,unsafeControllerCheckout.get(controllerWriter)
    .replace('          ref: main','          ref: ${{ github.event.workflow_run.head_sha }}'));
  assert.throws(()=>checkInventory(manifest,unsafeControllerCheckout),
    /Controller Store ingester is not authenticated/);

  const bypass=new Map(sources);
  const scenario='.github/workflows/e2e-scenario-ingest.yml';
  bypass.set(scenario,bypass.get(scenario).replace(
    'node trusted/scripts/run-store-cas-push.mjs acceptance-results "${GITHUB_WORKSPACE}/results-repo"',
    'git -C results-repo push origin acceptance-results'));
  assert.throws(()=>checkInventory(manifest,bypass),/bounded CAS Store publisher/);
  const clone=x=>JSON.parse(JSON.stringify(x));
  const unmatched=clone(manifest);
  unmatched.stores.find(x=>x.ref==='metrics').writers.pop();
  assert.throws(()=>checkInventory(unmatched,sources),/unknown privileged Store push/);
  const foreign=clone(manifest);
  foreign.stores.find(x=>x.ref==='task-results').writers[0].source='attacker';
  assert.throws(()=>checkInventory(foreign,sources),/unclassified writer/);
  const downgraded=clone(manifest);
  downgraded.stores.find(x=>x.ref==='metrics').writers[0].app_token.scope='all repositories';
  assert.throws(()=>checkInventory(downgraded,sources),/unclassified App writer/);
  const fallback=new Map(sources);
  const caseWriter='.github/workflows/acceptance-case-ingest.yml';
  fallback.set(caseWriter,fallback.get(caseWriter).replace("legacy) ;;","''|legacy) ;;"));
  assert.throws(()=>checkInventory(manifest,fallback),/missing pinned and scoped App/);
  const appFallback=new Map(sources);
  appFallback.set(caseWriter,appFallback.get(caseWriter)
    .replace("vars.RUN_STORE_WRITER_MODE == 'legacy' && secrets.GITHUB_TOKEN || steps.store_app.outputs.token",
      "vars.RUN_STORE_WRITER_MODE == 'app' && steps.store_app.outputs.token || secrets.GITHUB_TOKEN"));
  assert.throws(()=>checkInventory(manifest,appFallback),/missing pinned and scoped App/);
  const unscoped=new Map(sources);
  const testWriter='.github/workflows/e2e-scenario-ingest.yml';
  unscoped.set(testWriter,unscoped.get(testWriter).replace('permission-contents: write','permission-contents: read'));
  assert.throws(()=>checkInventory(manifest,unscoped),/missing pinned and scoped App/);
  const undeclared=clone(manifest);
  undeclared.stores.push({ref:'private-secrets',lifecycle:'active',writers:[]});
  assert.throws(()=>checkInventory(undeclared,sources),/canonical/);
  const forged=clone(manifest);
  forged.governance.ruleset_enforcement='enforced';
  assert.throws(()=>checkInventory(forged,sources),/must not assert/);
  const replaySource='.github/workflows/metrics-replay-request.yml';
  const replayWriter='.github/workflows/metrics-repository.yml';
  const requestWithWriterToken=new Map(sources);
  requestWithWriterToken.set(replaySource,
    requestWithWriterToken.get(replaySource).replace('contents: read','contents: write'));
  assert.throws(()=>checkInventory(manifest,requestWithWriterToken),
    /privilege-bearing Metrics Replay request/);
  const requestWithWrongActor=new Map(sources);
  requestWithWrongActor.set(replaySource,
    requestWithWrongActor.get(replaySource).replace("github.actor == 'BestNathan'","github.actor == 'anyone'"));
  assert.throws(()=>checkInventory(manifest,requestWithWrongActor),
    /privilege-bearing Metrics Replay request/);
  const requestFromWrongWorkflow=new Map(sources);
  requestFromWrongWorkflow.set(replayWriter,
    requestFromWrongWorkflow.get(replayWriter)
      .replace('workflows: ["Metrics / Replay Request"]','workflows: ["Untrusted / Job"]'));
  assert.throws(()=>checkInventory(manifest,requestFromWrongWorkflow),
    /schedule-or-attested-request/);
  const noAuthorization=new Map(sources);
  noAuthorization.set(replayWriter,
    noAuthorization.get(replayWriter).replace(
      'needs: [authorize-replay, rust-health, web-health, e2e-health]',
      'needs: [rust-health, web-health, e2e-health]'));
  assert.throws(()=>checkInventory(manifest,noAuthorization),
    /schedule-or-attested-request/);
  const bypassAuthorizer=new Map(sources);
  bypassAuthorizer.set(replayWriter,
    bypassAuthorizer.get(replayWriter).replace(
      "needs.authorize-replay.result == 'success'",
      "needs.authorize-replay.result != 'cancelled'"));
  assert.throws(()=>checkInventory(manifest,bypassAuthorizer),
    /schedule-or-attested-request/);
  const ownerAuthRemoved=new Map(sources);
  ownerAuthRemoved.set(replayWriter,
    ownerAuthRemoved.get(replayWriter).replace(
      'node scripts/metrics-replay-source.mjs authorize','echo skipping provenance'));
  assert.throws(()=>checkInventory(manifest,ownerAuthRemoved),
    /schedule-or-attested-request/);
  const manuallyDispatched=new Map(sources);
  const privilegedMetrics='.github/workflows/metrics-repository.yml';
  manuallyDispatched.set(privilegedMetrics,
    manuallyDispatched.get(privilegedMetrics).replace(
      /^  schedule:/m,'  workflow_dispatch:\n  schedule:'));
  assert.throws(()=>checkInventory(manifest,manuallyDispatched),/untrusted manual dispatch\/trigger/);
  const repoDispatched=new Map(sources);
  repoDispatched.set(caseWriter,repoDispatched.get(caseWriter).replace(
    /^  workflow_run:/m,'  repository_dispatch:\n  workflow_run:'));
  assert.throws(()=>checkInventory(manifest,repoDispatched),/untrusted manual dispatch\/trigger/);
  const noTrustedCheckout=new Map(sources);
  noTrustedCheckout.set(caseWriter,noTrustedCheckout.get(caseWriter)
    .replace('          ref: main','          ref: ${{ github.event.workflow_run.head_sha }}'));
  assert.throws(()=>checkInventory(manifest,noTrustedCheckout),/checkout trusted main/);
  const metricsCheckoutLeak=new Map(sources);
  const health='.github/workflows/metrics-repository.yml';
  metricsCheckoutLeak.set(health,metricsCheckoutLeak.get(health)
    .replace('ref: ${{ github.sha }}\n          persist-credentials: false',
      'ref: ${{ github.sha }}\n          persist-credentials: true'));
  assert.throws(()=>checkInventory(manifest,metricsCheckoutLeak),
    /checkout persists credentials/);
  const extraUntrustedCheckout=new Map(sources);
  extraUntrustedCheckout.set(caseWriter,extraUntrustedCheckout.get(caseWriter)
    .replace('      - uses: actions/setup-node@v4',
      '      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.workflow_run.head_sha }}\n      - uses: actions/setup-node@v4'));
  assert.throws(()=>checkInventory(manifest,extraUntrustedCheckout),
    /checkout persists credentials/);
  const noPersistDisabled=new Map(sources);
  noPersistDisabled.set(caseWriter,noPersistDisabled.get(caseWriter)
    .replace('persist-credentials: false','persist-credentials: true'));
  assert.throws(()=>checkInventory(manifest,noPersistDisabled),/checkout persists credentials/);
  const triggerStripped=new Map(sources);
  triggerStripped.set(privilegedMetrics,triggerStripped.get(privilegedMetrics)
    .replace(/^  schedule:/m,'  workflow_dispatch:'));
  assert.throws(()=>checkInventory(manifest,triggerStripped),/untrusted manual dispatch\/trigger/);
  const unknownWorkflow=new Map(sources);
  unknownWorkflow.set('.github/workflows/unreviewed.yml',
    'on: push\npermissions:\n  contents: write\njobs:\n  writer:\n    steps:\n      - run: git push origin HEAD:metrics\n');
  assert.throws(()=>checkInventory(manifest,unknownWorkflow),/unknown privileged Store push/);
  const unsupported=new Map(sources);
  unsupported.delete('.github/workflows/e2e-tests.yml');
  assert.throws(()=>checkInventory(manifest,unsupported),/upstream dependency/);
  assert.deepEqual(findStorePushes('git -C result push origin acceptance-results\n'+
    'git push origin HEAD:metrics').map(x=>x.ref),['acceptance-results','metrics']);
  console.log('Run Store inventory: 4 active refs, 6 legacy plus 5 live agent-store scoped App writers, explicit deferred server authorization, no silent App fallback, negative fixtures passed');
}
function gh(endpoint){
  try{
    return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],{
      encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      stdio:['ignore','pipe','pipe'],
    }));
  }catch(e){return {unavailable:true,error_class:'permission-or-api-error',
    status:e.status??null};}
}
export function assertTrustedLiveContext(env){
  if(env.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_REF!=='refs/heads/main'||
     !['push','schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||
     !HEX40.test(env.GITHUB_SHA??''))
    fail('live protection audit must run on trusted main source SHA');
  return true;
}
function live(out){
  assertTrustedLiveContext(process.env);
  const inventory=data();
  checkInventory(inventory,workflows());
  const rulesets=gh('rulesets?per_page=100');
  const rows=[];
  for(const store of inventory.stores){
    const branch=gh('branches/'+store.ref);
    const protection=gh('branches/'+store.ref+'/protection');
    rows.push({ref:store.ref,lifecycle:store.lifecycle,
      branch_exists:!branch.unavailable,
      branch_protected:branch.unavailable?null:branch.protected===true,
      protection_endpoint_available:!protection.unavailable,
      protection_error:protection.unavailable?protection.error_class:null,
      // A non-admin caller cannot prove configured permissions by querying
      // only a summary; this is explicitly NOT an enforcement attestation.
      authorization_verified:false});
  }
  const output={schema_version:1,kind:'run_store_governance_observation',
    repo:REPO,source_sha:process.env.GITHUB_SHA,
    action_run_id:process.env.GITHUB_RUN_ID??null,
    observed_at:new Date().toISOString(),
    rulesets_readable:!rulesets.unavailable,
    rulesets:rulesets.unavailable?[]:
      (Array.isArray(rulesets)?rulesets:[]).map(r=>({id:r.id,
        name:r.name,enforcement:r.enforcement,target:r.target})),
    stores:rows,
    verdict:'not-enforced-until-independent-admin-and-authorization-proof'};
  fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
  console.log('Run Store governance live snapshot written; no server-side enforcement claimed');
}
const [command,file]=process.argv.slice(2);
if(command==='self-test')selfTest();
else if(command==='check')console.log(JSON.stringify(checkInventory(data(),workflows())));
else if(command==='live'&&file&&path.isAbsolute(file))live(file);
else fail('usage: self-test | check | live ABS_OUTPUT_JSON');
