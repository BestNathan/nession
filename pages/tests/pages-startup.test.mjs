import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {makeProjection} from '../scripts/project.mjs';
import {IndexContent} from '../src/app/App.tsx';
import {initialResources} from '../src/app/resources.tsx';
import {UiStateProvider} from '../src/app/ui-state.tsx';
import {loadingTitle, parseRoute, readyTitle} from '../src/app/router.ts';

const now='2026-11-03T06:00:00Z';
const sha='a'.repeat(40);
function resources(patch={}){return {...initialResources(),...patch};}
function render(hash,res){
  return renderToStaticMarkup(
    createElement(UiStateProvider,null,createElement(IndexContent,{hash,resources:res}))
  );
}
const knowledge={schema_version:1,status:'available',
  source:{branch:'knowledge',sha,generated_at:now},
  topics:['engineering'],categories:['knowledge'],
  articles:[{path:'topics/engineering/source.md',title:'Knowledge provenance',
    description:'Sourced project knowledge.',topic:'engineering',categories:['knowledge'],
    status:'verified',updated_at:now,sources:['https://github.com/BestNathan/nession/issues/1'],
    body:'## Source-bound decisions\n\nSafe **sourced** text.'}],
  changes:[]};

test('site-dependent deep links never render before site.json has resolved',()=>{
  for(const hash of ['#/work','#/agents','#/repository','#/evidence']){
    const html=render(hash,resources());
    assert.match(html,/Loading public engineering snapshot/);
    assert.doesNotMatch(html,/could not be rendered/);
  }
  assert.equal(loadingTitle(parseRoute('#/work')),'Collaboration — Nession');
  assert.equal(loadingTitle(parseRoute('#/agents')),'Agents — Nession');
  assert.equal(loadingTitle(parseRoute('#/repository')),'Repository — Nession');
  assert.equal(loadingTitle(parseRoute('#/work/issue/42')),'Collaboration — Nession');
});

test('a failed site source produces a truthful unavailable state, not a renderer exception',()=>{
  const res=resources({site:{status:'unavailable',data:null}});
  for(const hash of ['#/work','#/agents','#/evidence']){
    const html=render(hash,res);
    assert.match(html,/Engineering snapshot unavailable/);
    assert.doesNotMatch(html,/could not be rendered/);
  }
});

test('Knowledge, Documents and Prototypes remain independent of an unavailable site snapshot',()=>{
  const site={status:'unavailable',data:null};
  let html=render('#/prototypes',resources({site}));
  assert.match(html,/Loading published prototypes/);
  assert.doesNotMatch(html,/Engineering snapshot unavailable/);
  html=render('#/knowledge',resources({site}));
  assert.match(html,/Loading public Knowledge snapshot/);
  html=render('#/knowledge',resources({site,knowledge:{status:'available',data:knowledge}}));
  assert.match(html,/What we’ve learned, kept\./);
  assert.match(html,/Knowledge provenance/);
  assert.doesNotMatch(html,/Engineering snapshot unavailable/);
  html=render('#/documents',resources({site}));
  assert.match(html,/Documents/);
  assert.match(html,/Loading public catalog/);
  html=render('#/documents/protocol',resources({site}));
  assert.match(html,/Loading technical Documents/);
  html=render('#/documents/protocol',resources({site,documents:{status:'unavailable',data:null}}));
  assert.match(html,/Protocol catalog unavailable/);
});

test('recovered, valid source renders public Issues and PRs after pending startup',()=>{
  const site=makeProjection({issues:[{number:42,title:'Public sample Issue',state:'open',updated_at:now}],
    pulls:[{number:43,title:'Public sample PR',state:'open',updated_at:now}],
    registry:null,workflowRuns:[],meta:{generated_at:now,main_sha:sha}});
  const html=render('#/work',resources({site:{status:'available',data:site}}));
  assert.match(html,/Public sample Issue/);
  assert.match(html,/Public sample PR/);
  assert.doesNotMatch(html,/could not be rendered/);
});

test('missing or failed Knowledge data cannot prevent independent site initialization',()=>{
  const site=makeProjection({issues:[{number:55,title:'Visible public issue',state:'open',updated_at:now}],
    pulls:[],workflowRuns:[],meta:{generated_at:now,main_sha:sha}});
  const html=render('#/work',resources({site:{status:'available',data:site},
    knowledge:{status:'unavailable',data:null}}));
  assert.match(html,/Visible public issue/);
  assert.doesNotMatch(html,/could not be rendered/);
});

test('Knowledge loads separately even if the public site source is unavailable',()=>{
  const html=render('#/knowledge',resources({
    site:{status:'unavailable',data:null},
    knowledge:{status:'available',data:knowledge},
  }));
  assert.match(html,/What we’ve learned, kept\./);
  assert.match(html,/Source-bound decisions/);
});

test('source fetches remain bounded and every independent loader schedules a rerender',async()=>{
  const loaders=await readFile(new URL('../src/data/load.ts',import.meta.url),'utf8');
  assert.match(loaders,/AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(loaders,/, 15000, 'no-cache'/);
  assert.match(loaders,/data\/site\.json/);
  assert.match(loaders,/data\/knowledge\.json/);
  assert.match(loaders,/data\/documents\.json/);
  assert.match(loaders,/data\/mcp\.json/);
  assert.match(loaders,/prototypes\/manifest\.json/);
  const resources=await readFile(new URL('../src/app/resources.tsx',import.meta.url),'utf8');
  assert.match(resources,/setResources/);
  const app=await readFile(new URL('../src/app/App.tsx',import.meta.url),'utf8');
  assert.match(app,/window\.addEventListener\('hashchange', sync\)/);
  assert.match(app,/route\.needsSite && !snapshot/);
  const data=await readFile(new URL('../scripts/build-data.mjs',import.meta.url),'utf8');
  assert.match(data,/data\/site\.json/);
  assert.match(data,/data\/knowledge\.json/);
});

test('Agent roster and deep links render source-only outcome and Run/Attempt details',()=>{
  const sample={schema_version:1,coverage:'observed',unattributed:1,truncated:false,
    items:[{id:'dev-qwen-01',role:'developer',total:3,success:1,failure:1,
      cancelled:1,timed_out:0,unknown:0,recent:[
        {run_id:41750275349,attempt:2,workflow:'issue-audit',issue:2710,
          outcome:'failure',provider:'claude-code',observed_at:now,duration_ms:2500,url:'https://github.com/BestNathan/nession/actions/runs/41750275349'},
        {run_id:41750275349,attempt:1,workflow:'issue-audit',issue:2710,
          outcome:'success',provider:'claude-code',observed_at:now,duration_ms:1900,url:'https://github.com/BestNathan/nession/actions/runs/41750275349'},
      ]}]};
  const site=makeProjection({meta:{generated_at:now,main_sha:sha,
      metrics_sha:'b'.repeat(40)},
    registry:{instances:{'dev-qwen-01':{role:'developer',provider:'claude-code'},
      'review-01':{role:'reviewer',provider:'cursor'}}},
    agent:{schema_version:1,kind:'agent_metrics_aggregate',generated_at:now,
      windows:{'7d':{runs:{total:5},per_agent:sample},
        '30d':{runs:{total:9},per_agent:sample}}}});
  const res=resources({site:{status:'available',data:site}});
  let html=render('#/agents',res);
  assert.match(html,/Execution by Agent/);
  assert.match(html,/3 runs · 1 succeeded · 1 failed/);
  assert.match(html,/review-01/);
  assert.match(html,/Not observed/);
  assert.match(html,/unattributed executions: 1/);
  html=render('#/agents/developer/dev-qwen-01?window=30d&outcome=failure',res);
  assert.match(html,/Recent executions/);
  assert.match(html,/Run 41750275349 \/ attempt 2/);
  assert.doesNotMatch(html,/Run 41750275349 \/ attempt 1/);
  assert.match(html,/Success rate/);
  assert.doesNotMatch(html,/could not be rendered/);
  html=render('#/agents/developer/invalid-source',res);
  assert.match(html,/Agent identity not observed/);
  assert.equal(readyTitle(parseRoute('#/agents')),'Agents — Nession');
});
