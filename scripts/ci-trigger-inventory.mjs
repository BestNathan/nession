#!/usr/bin/env node
// Reproducible, repository-wide Actions trigger inventory for #2095.
// Never infer branch required-check settings from YAML: those are server-side.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, workflowName, upstreamWorkflowNames, approvedExternalWorkflowRunSource } from './workflow-conventions.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const DIR=path.join(ROOT,'.github/workflows');
const yaml=()=>fs.readdirSync(DIR).filter(x=>/\.ya?ml$/.test(x)).sort();
function eventScope(source){
  const lines=source.split(/\r?\n/);
  const start=lines.findIndex(l=>/^on:\s*$/.test(l));
  if(start<0)throw Error('missing on: event block');
  const events=[];
  let event=null;
  for(let i=start+1;i<lines.length;i++){
    const raw=lines[i],indent=(raw.match(/^ */)||[''])[0].length;
    if(raw.trim()&&!raw.trim().startsWith('#')&&indent===0)break;
    const hit=raw.match(/^  ([a-z][a-z_-]*):(?:\s*.*)?$/);
    if(hit){event={name:hit[1],pathFilters:[],branchFilters:[],workflows:[]};events.push(event);continue}
    if(!event)continue;
    const field=raw.match(/^    (paths|paths-ignore|branches|branches-ignore|workflows):\s*(.*)$/);
    if(field){
      const [_,key,val]=field;
      const target=key.startsWith('paths')?event.pathFilters:
        key.startsWith('branches')?event.branchFilters:event.workflows;
      if(val.startsWith('['))
        target.push(key+':'+val);
      else {
        let j=i+1;
        while(j<lines.length&&/^      -\s+/.test(lines[j])){
          target.push(key+':'+lines[j].replace(/^      -\s+/, '').trim());
          j++;
        }
      }
    }
  }
  return events;
}
export function inspectWorkflows(){
  const all=yaml(),inventory=[],nameIndex=new Map(),files=new Set();
  for(const [id,legacy,,,target,domain] of CATALOG){
    // Existing catalog id has either its canonical target path or legacy path.
    const preferred=CATALOG.find(x=>x[0]===id)[3];
    const actual=all.includes(preferred)?preferred:legacy;
    if(!all.includes(actual))throw Error('missing workflow from catalog: '+id);
    if(files.has(actual))throw Error('duplicate workflow path: '+actual);
    files.add(actual);
    const source=fs.readFileSync(path.join(DIR,actual),'utf8');
    const name=workflowName(source);
    if(!name||nameIndex.has(name))throw Error('missing or duplicate workflow display name '+actual);
    nameIndex.set(name,id);
    inventory.push({id,file:actual,name,domain,events:eventScope(source),
      upstream:upstreamWorkflowNames(source).names,downstream:[]});
  }
  assert.deepEqual([...files].sort(),all,'unclassified Actions workflow found');
  for(const item of inventory)for(const source of item.upstream){
    const upstream=inventory.find(x=>x.name===source);
    if(!upstream){
      const content=fs.readFileSync(path.join(DIR,item.file),'utf8');
      if(approvedExternalWorkflowRunSource(item.file,content,source))continue;
      throw Error('dangling workflow_run consumer: '+item.name+' -> '+source);
    }
    upstream.downstream.push(item.name);
  }
  return inventory;
}
const norm=s=>String(s).replaceAll('|','\\|').replace(/\s+/g,' ');
export function report(rows){
  const lines=[
    '# Nession GitHub Actions trigger audit',
    '',
    'Generated from the checked-out Workflow catalog and YAML (run `node scripts/ci-trigger-inventory.mjs report`).',
    'It inventories trigger events, branch/path filters, downstream completion consumers, and possible fan-out for every active workflow.',
    '**Required branch check contexts:** not independently confirmed; the connected GitHub integration returns HTTP 403 for the main branch protection required-status-checks endpoint. Treat this as an explicit verification gap, not as proof that no checks are required.',
    '',
    '| Workflow | Trigger and path/branch scope | Consumer(s) of completion | Potential duplicate/fan-out | Required check |',
    '|---|---|---|---|---|',
  ];
  for(const row of rows){
    const eventNames=row.events.map(e=>e.name);
    const scope=row.events.map(e=>e.name+
      (e.branchFilters.length?' branches='+e.branchFilters.map(norm).join(','):'')+
      (e.pathFilters.length?' paths='+e.pathFilters.map(norm).join(','):'')
    ).join('; ');
    const flags=[];
    if(eventNames.includes('push')&&row.events.find(e=>e.name==='push').pathFilters.length===0)
      flags.push('unfiltered push');
    if(eventNames.includes('pull_request')&&row.events.find(e=>e.name==='pull_request').pathFilters.length===0)
      flags.push('unfiltered PR');
    if(row.upstream.length)flags.push('workflow_run upstream '+row.upstream.join(','));
    lines.push('| '+norm(row.name)+' (`'+row.file+'`) | '+norm(scope)+
      ' | '+norm(row.downstream.join(', ')||'no declared workflow_run downstream')+
      ' | '+norm(flags.join('; ')||'path/event scoped')+' | unverified |');
  }
  lines.push('','## Interpretation and policy exceptions','',
    '- Normal PR and merge-SHA E2E run only linked/impacted IDs. A green selected run is **not** Full Regression.',
    '- Full Regression runs from the separate pinned-SHA scheduled/manual workflow, or when explicitly required by a critical verification milestone.',
    '- A workflow_run subscriber is not necessarily an extra expensive test; verify whether its selection job is gated to main source completion before classifying waste.',
    '- Full Quality/E2E producer obligations and acceptance-source consumers must be migrated together. Exact-SHA checks and artifact provenance are not optional.',
    '- A label is a risk declaration, not authorization or a test Pass. SC evidence is source-aligned and defaults to PR stage.',
    '',
    '## Reproduction','',
    '`node scripts/ci-trigger-inventory.mjs report`',
    '');
  return lines.join('\n');
}
function selfTest(){
  const entries=inspectWorkflows();
  assert.ok(entries.length>=40);
  assert.equal(new Set(entries.map(e=>e.name)).size,entries.length);
  const e2e=entries.find(e=>e.id==='e2e-tests');
  assert.ok(e2e);
  assert.ok(e2e.downstream.some(s=>s.includes('Test Ingest')));
  assert.ok(report(entries).includes('unverified'));
  assert.ok(report(entries).includes('workflow_run'));
  assert.throws(()=>eventScope('name: Example\njobs:\n  x:\n    runs-on: ubuntu-latest'),/missing on/);
  console.log('CI trigger audit: '+entries.length+' cataloged workflows, scope, fan-out and required-check honesty passed');
}
if(process.argv[2]==='self-test')selfTest();
else if(process.argv[2]==='report')console.log(report(inspectWorkflows()));
else throw Error('usage: ci-trigger-inventory.mjs self-test|report');
