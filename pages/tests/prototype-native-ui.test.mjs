import { test } from 'node:test';
import assert from 'node:assert/strict';
import {NAV_ITEMS} from '../src/app/navigation.ts';
import {validPrototypeCatalog} from '../src/data/validation.ts';
import { readFile } from 'node:fs/promises';
import { approvedExternalWorkflowRunSource } from '../../scripts/workflow-conventions.mjs';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const overview = await readFile(new URL('../src/features/overview/OverviewPage.tsx', import.meta.url), 'utf8');
const prototypes = await readFile(new URL('../src/features/prototypes/PrototypesPage.tsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const publisher = await readFile(new URL('../scripts/publish-prototypes.mjs', import.meta.url), 'utf8');
const SHA='a'.repeat(40);
const item=(slug)=>({
  slug, preview:'prototypes/'+slug+'/index.html',
  source:'https://github.com/BestNathan/nession/blob/'+SHA+'/'+slug+'/index.html',
  assets:3,
});
const catalog=(entries)=>({
  schema_version:1,source:{branch:'prototype',sha:SHA},entries,
});

test('native Pages navigation owns the Prototypes route and homepage discovery',()=>{
  assert.match(index, /<script type="module" src="\/src\/app\/main\.tsx"><\/script>/);
  assert.ok(NAV_ITEMS.some(item=>item.route==='/prototypes'));
  assert.doesNotMatch(index,/href="prototypes\/"/);
  assert.match(app,/case '\/prototypes':/);
  assert.match(app,/<PrototypesPage catalog=\{resources\.prototypes\} \/>/);
  assert.match(overview,/Browse interactive prototypes/);
  assert.match(prototypes,/kicker="PRODUCT \/ INTERACTIVE LAB"/);
  assert.match(styles,/\.prototype-card\{/);
  assert.match(styles,/\.prototype-teaser\{/);
  assert.match(publisher,/function integratedGalleryRedirect\(/);
  assert.match(publisher,/http-equiv="refresh" content="0;url=\.\.\/#\/prototypes"/);
});

test('catalog source and routes are exact, bounded and trusted',()=>{
  const items=[item('ai-workspace-2221'),item('terminal-fixed-cols-2487')];
  assert.equal(validPrototypeCatalog(catalog(items)),true);
  assert.equal(validPrototypeCatalog(catalog([items[0],items[0]])),false);
  assert.equal(validPrototypeCatalog(catalog([{...items[0],preview:'https://evil.example/'}])),false);
  assert.equal(validPrototypeCatalog(catalog([{...items[0],source:'https://github.com/BestNathan/nession/blob/other/file'}])),false);
  assert.equal(validPrototypeCatalog(catalog([{...items[0],slug:'../bad-1'}])),false);
  assert.equal(validPrototypeCatalog({...catalog(items),source:{branch:'main',sha:SHA}}),false);
  assert.equal(validPrototypeCatalog({...catalog(items),source:{branch:'prototype',sha:'prototype'}}),false);
  assert.equal(validPrototypeCatalog(catalog(Array.from({length:101},(_,i)=>item('example-'+i)))),false);
});

test('published mocks remain discoverable and source is secondary',()=>{
  assert.match(prototypes,/Open interactive HTML/);
  assert.match(prototypes,/new URL\(preview, document\.baseURI\)\.href/);
  assert.match(prototypes,/target="_blank"/);
  assert.match(prototypes,/rel="noopener noreferrer"/);
  assert.match(prototypes,/Open ' \+ info\.title \+ ' interactive HTML in a new tab/);
  assert.match(prototypes,/View source/);
  assert.match(publisher,/Back to Nession prototype gallery/);
  assert.match(publisher,/View source ↗/);
  assert.doesNotMatch(prototypes,/innerHTML|dangerouslySetInnerHTML/);
});

test('Prototype and Knowledge push signals reach only the trusted main Pages publisher',async()=>{
  const workflow=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes("workflows: ['Prototype / Change Signal', 'Knowledge / Change Signal']"));
  assert.ok(workflow.includes('types: [completed]'));
  assert.ok(workflow.includes('branches: [prototype, knowledge]'));
  // One canonical guard owns the exact workflow-name/branch and provenance
  // pairing. Pages tests exercise integration rather than copying its policy.
  for (const name of ['Prototype / Change Signal','Knowledge / Change Signal']) {
    assert.equal(approvedExternalWorkflowRunSource('deploy-pages.yml',workflow,name),true);
  }
  assert.equal(approvedExternalWorkflowRunSource('ci-quality.yml',workflow,'Knowledge / Change Signal'),false);
  assert.ok(!workflow.includes("cron: '*/15 * * * *'"));
});
