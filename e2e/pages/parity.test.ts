import {test,expect,type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startPagesFixture,pagesFixtureData,startPagesServer} from '../helpers/pagesStandalone';

const e2eRoot=process.cwd().endsWith('/e2e')?process.cwd():resolve(process.cwd(),'e2e');
const repoRoot=resolve(e2eRoot,'..');

// Immutable pre-migration renderer frozen at migration start (Issues #4448,
// #4442/#4441). Both the baseline source tree and the candidate compiled
// artifact run against the exact same deterministic public fixtures.
export const BASELINE_SHA='6fb8fe59cfa32d795fcc930bee4297184810cc84';
const BASELINE_FILES=['index.html','app.js','knowledge.js','documents.js',
 'mcp-documents.js','workflows.js','navigation.js','workflows.html',
 'styles.css','workflows.css','favicon.svg'];

// Deterministic tolerance declared before the route matrix is compared.
// Identical markup/CSS normally produces byte-identical screenshots; the
// bounded allowance only absorbs same-browser text glyph antialiasing noise
// that does not move any element (geometry, text and links are independently
// exact). It is far below the coverage of any real content, color or layout
// regression, so it cannot mask one.
export const PARITY_TOLERANCE=Object.freeze({
 maxDifferentPixelRatio:0.001,
 maxChannelDelta:2,
 maxGeometryDeltaPx:0.05,
});

const VIEWPORTS=[
 {width:320,height:568},{width:390,height:844},{width:844,height:390},
 {width:768,height:1024},{width:1365,height:740},{width:1440,height:900},
 {width:1920,height:1080},
];
const SCHEMES=['light','dark'] as const;
const FIRST_ARTICLE='topics/engineering/knowledge-provenance.md';
const ROUTES=[
 {name:'overview',path:'#/',ready:'An open space'},
 {name:'agents',path:'#/agents',ready:'The agents behind the work.'},
 {name:'agent-detail',path:'#/agents/developer/dev-qwen-01',ready:'Recent executions'},
 {name:'collaboration',path:'#/work',ready:'Work in progress.'},
 {name:'work-issue',path:'#/work/issue/1782',ready:'PR mentions only'},
 {name:'work-pr',path:'#/work/pr/1787',ready:'Observed HEAD:'},
 {name:'prototypes',path:'#/prototypes',ready:'Prototype catalog unavailable'},
 {name:'knowledge',path:'#/knowledge',ready:'What we’ve learned, kept.'},
 {name:'knowledge-article',path:'#/knowledge?article='+encodeURIComponent(FIRST_ARTICLE),
  ready:'Source-bound decisions'},
 {name:'knowledge-changes',path:'#/knowledge?view=changes',ready:'Changes over time.'},
 {name:'documents',path:'#/documents',ready:'Documents'},
 {name:'protocol',path:'#/documents/protocol',ready:'Protocol reference'},
 {name:'protocol-v2',path:'#/documents/protocol?protocol=git.status&v=2',ready:'git.status'},
 {name:'mcp',path:'#/documents/mcp',ready:'MCP Tools'},
 {name:'mcp-tool',path:'#/documents/mcp?tool=nession_server_list_agents',
  ready:'nession_server_list_agents'},
 {name:'repository',path:'#/repository',ready:'Built in the open.'},
 {name:'evidence',path:'#/evidence',ready:'Evidence, not claims.'},
 {name:'missing',path:'#/not-a-listed-route',ready:'Route unavailable'},
 {name:'workflows',path:'/workflows.html',ready:'Inside the workflow.'},
];

// playwright-core bundles pngjs for its screenshot assertions; reuse the same
// decoder without adding a separate public Pages dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {PNG}=require('playwright-core/lib/utilsBundle') as {
 PNG:{sync:{read(buffer:Buffer):{width:number;height:number;data:Buffer};
  write(value:{width:number;height:number;data:Buffer}):Buffer}};
};

const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const normalized=(text:string)=>text.replace(/\s+/g,' ').trim();

async function materializeBaseline():Promise<string>{
 const directory=await mkdtemp(join(tmpdir(),'pages-baseline-'));
 for(const file of BASELINE_FILES){
  const content=execFileSync('git',['-C',repoRoot,'show',BASELINE_SHA+':pages/'+file],{
   maxBuffer:8*1024*1024,
  });
  await writeFile(join(directory,file),content);
 }
 return directory;
}

async function settle(page:Page,ready:string):Promise<void>{
 await page.waitForFunction(
  // innerText applies CSS text-transform; compare case-insensitively.
  text=>document.body.innerText.toLowerCase().includes(text.toLowerCase()),
  ready,
  {timeout:20_000},
 );
 await page.evaluate(async()=>{
  await document.fonts.ready;
  await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
 });
}

type Observation={
 title:string;
 text:string;
 links:Array<[string,string]>;
 elements:Array<{
  path:string;tag:string;id:string;className:string;
  x:number;y:number;width:number;height:number;
  display:string;visibility:string;position:string;opacity:string;
  fontSize:string;fontWeight:string;lineHeight:string;fontFamily:string;
  color:string;backgroundColor:string;overflowX:string;overflowY:string;
 }>;
};

async function observe(page:Page):Promise<Observation>{
 return page.evaluate(()=>{
  const round=(value:number)=>Math.round(value*100)/100;
  // Head-only build tags (script/link/modulepreload) differ by construction
  // and cannot affect layout; compare the rendered body tree instead.
  const elements=[...document.querySelectorAll('body *')].map(element=>{
   const rect=element.getBoundingClientRect();
   const style=getComputedStyle(element);
   return {
    path:element.tagName.toLowerCase()+'['+
      [...(element.parentElement?.children||[])].indexOf(element)+']',
    tag:element.tagName.toLowerCase(),
    id:element.id,
    className:typeof element.className==='string'?element.className:
      (element.className as SVGAnimatedString).baseVal||'',
    x:round(rect.x),y:round(rect.y),width:round(rect.width),height:round(rect.height),
    display:style.display,visibility:style.visibility,position:style.position,
    opacity:style.opacity,fontSize:style.fontSize,fontWeight:style.fontWeight,
    lineHeight:style.lineHeight,fontFamily:style.fontFamily,color:style.color,
    backgroundColor:style.backgroundColor,overflowX:style.overflowX,
    overflowY:style.overflowY,
   };
  });
  return {
   title:document.title,
   text:document.body.innerText,
   links:[...document.querySelectorAll('a[href]')].map(link=>
     [link.textContent||'',link.getAttribute('href')||''] as [string,string]),
   elements,
  };
 });
}

async function screenshot(page:Page):Promise<Buffer>{
 return page.screenshot({animations:'disabled',caret:'hide',scale:'css'});
}

function compareElements(
 baseline:Observation['elements'],
 candidate:Observation['elements'],
):{equal:boolean;differences:string[]}{
 const differences:string[]=[];
 const length=Math.max(baseline.length,candidate.length);
 for(let index=0;index<length;index+=1){
  const left=baseline[index],right=candidate[index];
  if(!left||!right){
   differences.push('element count/order differs at index '+index);
   if(differences.length>=8)break;
   continue;
  }
  const numeric=['x','y','width','height'] as const;
  let mismatch=false;
  for(const key of numeric){
   if(!(Math.abs(left[key]-right[key])<=PARITY_TOLERANCE.maxGeometryDeltaPx)) mismatch=true;
  }
  for(const key of Object.keys(left) as Array<keyof typeof left>){
   if(numeric.includes(key as 'x'))continue;
   if(left[key]!==right[key])mismatch=true;
  }
  if(mismatch){
   differences.push(left.path+' '+JSON.stringify(left)+' != '+JSON.stringify(right));
   if(differences.length>=8)break;
  }
 }
 return {equal:differences.length===0,differences};
}

function compareLinks(
 baseline:Observation['links'],
 candidate:Observation['links'],
):{equal:boolean;differences:string[]}{
 if(JSON.stringify(baseline)===JSON.stringify(candidate))return {equal:true,differences:[]};
 const differences:string[]=[];
 const length=Math.max(baseline.length,candidate.length);
 for(let index=0;index<length;index+=1){
  const left=baseline[index],right=candidate[index];
  if(!left||!right){
   differences.push('link count differs at '+index+' (baseline='+baseline.length+
     ', candidate='+candidate.length+')');
   if(differences.length>=6)break;
   continue;
  }
  if(normalized(left[0])!==normalized(right[0])||left[1]!==right[1]){
   differences.push('link['+index+'] '+JSON.stringify(left)+' != '+JSON.stringify(right));
   if(differences.length>=6)break;
  }
 }
 return {equal:differences.length===0,differences};
}

function compareScreenshots(baseline:Buffer,candidate:Buffer):{
 equal:boolean;differentPixels:number;totalPixels:number;maxChannelDelta:number;
 baselineDimensions:string;candidateDimensions:string;
}{
 const left=PNG.sync.read(baseline),right=PNG.sync.read(candidate);
 if(left.width!==right.width||left.height!==right.height){
  return {equal:false,differentPixels:Number.MAX_SAFE_INTEGER,totalPixels:1,
   maxChannelDelta:255,baselineDimensions:left.width+'x'+left.height,
   candidateDimensions:right.width+'x'+right.height};
 }
 let differentPixels=0,maxChannelDelta=0;
 const totalPixels=left.width*left.height;
 for(let offset=0;offset<left.data.length;offset+=4){
  let pixelDifferent=false;
  for(let channel=0;channel<3;channel+=1){
   const delta=Math.abs(left.data[offset+channel]-right.data[offset+channel]);
   if(delta>PARITY_TOLERANCE.maxChannelDelta)pixelDifferent=true;
   if(delta>maxChannelDelta)maxChannelDelta=delta;
  }
  if(pixelDifferent)differentPixels+=1;
 }
 return {equal:differentPixels/totalPixels<=PARITY_TOLERANCE.maxDifferentPixelRatio,
  differentPixels,totalPixels,maxChannelDelta,
  baselineDimensions:left.width+'x'+left.height,
  candidateDimensions:right.width+'x'+right.height};
}

const reportDirectory=join(e2eRoot,'test-results-pages/parity');

async function record(entry:Record<string,unknown>,worker:string):Promise<void>{
 await mkdir(reportDirectory,{recursive:true});
 // JSON Lines evidence: one fully self-describing observation per line.
 await writeFile(join(reportDirectory,'parity-'+worker+'.jsonl'),
  JSON.stringify(entry)+'\n',{flag:'a'});
}

test.describe('frozen-baseline parity',()=>{
 let baselineOrigin:string,baselineClose:()=>Promise<void>;
 let candidateOrigin:string,candidateClose:()=>Promise<void>;
 let baselineDirectory:string;
 test.beforeAll(async()=>{
  baselineDirectory=await materializeBaseline();
  const data=pagesFixtureData();
  const baseline=await startPagesServer({filesRoot:baselineDirectory,data});
  baselineOrigin=baseline.origin;baselineClose=baseline.close;
  const candidate=await startPagesFixture();
  candidateOrigin=candidate.origin;candidateClose=candidate.close;
 });
 test.afterAll(async()=>{
  await baselineClose?.();
  await candidateClose?.();
  if(baselineDirectory)await rm(baselineDirectory,{recursive:true,force:true});
 });

 for(const route of ROUTES){
  test('visual, text, link and computed-style parity · '+route.name,async({browser},testInfo)=>{
   test.setTimeout(120_000);
   const worker=String(testInfo.workerIndex);
   for(const viewport of VIEWPORTS){
    for(const colorScheme of SCHEMES){
     // One context for both origins shares font cache and rasterization, so a
     // screenshot difference reflects markup/CSS rather than environment noise.
     const context=await browser.newContext({viewport,colorScheme});
     const baselinePage=await context.newPage();
     const candidatePage=await context.newPage();
     try{
      await baselinePage.goto(baselineOrigin+route.path);
      await candidatePage.goto(candidateOrigin+route.path);
      await settle(baselinePage,route.ready);
      await settle(candidatePage,route.ready);
      const baselineObservation=await observe(baselinePage);
      const candidateObservation=await observe(candidatePage);
      const baselineImage=await screenshot(baselinePage);
      const candidateImage=await screenshot(candidatePage);
      const textEqual=normalized(baselineObservation.text)===normalized(candidateObservation.text);
      const titleEqual=baselineObservation.title===candidateObservation.title;
      const links=compareLinks(baselineObservation.links,candidateObservation.links);
      const linksEqual=links.equal;
      const geometry=compareElements(baselineObservation.elements,candidateObservation.elements);
      const screenshotResult=compareScreenshots(baselineImage,candidateImage);
      await record({
       baseline_sha:BASELINE_SHA,route:route.name,path:route.path,
       viewport,color_scheme:colorScheme,
       title:{equal:titleEqual,baseline:baselineObservation.title,
        candidate:candidateObservation.title},
       text:{equal:textEqual,baseline_sha256:digest(normalized(baselineObservation.text)),
        candidate_sha256:digest(normalized(candidateObservation.text))},
       links:{equal:linksEqual,count:baselineObservation.links.length,
        candidate_count:candidateObservation.links.length,differences:links.differences},
       geometry:{equal:geometry.equal,elements:baselineObservation.elements.length,
        differences:geometry.differences},
       screenshot:{equal:screenshotResult.equal,
        baseline_sha256:digest(baselineImage),candidate_sha256:digest(candidateImage),
        different_pixels:screenshotResult.differentPixels,
        total_pixels:screenshotResult.totalPixels,
        max_channel_delta:screenshotResult.maxChannelDelta,
        baseline_dimensions:screenshotResult.baselineDimensions,
        candidate_dimensions:screenshotResult.candidateDimensions},
       tolerance:PARITY_TOLERANCE,
      },worker);
      if(!titleEqual||!textEqual||!linksEqual||!geometry.equal||!screenshotResult.equal){
       await mkdir(reportDirectory,{recursive:true});
       const stem=join(reportDirectory,route.name+'-'+viewport.width+'x'+viewport.height+'-'+colorScheme);
       await writeFile(stem+'-baseline.png',baselineImage);
       await writeFile(stem+'-candidate.png',candidateImage);
       expect.soft({title:titleEqual,text:textEqual,links:linksEqual,
        geometry:geometry.equal,screenshot:screenshotResult.equal,
        link_differences:links.differences,
        geometry_differences:geometry.differences,
        screenshot_different_pixels:screenshotResult.differentPixels,
        screenshot_tolerance:PARITY_TOLERANCE.maxDifferentPixelRatio},
        'parity for '+route.name+' '+viewport.width+'x'+viewport.height+' '+colorScheme)
        .toEqual({title:true,text:true,links:true,geometry:true,screenshot:true,
         link_differences:[],geometry_differences:[],screenshot_different_pixels:0,
         screenshot_tolerance:PARITY_TOLERANCE.maxDifferentPixelRatio});
      }
     }finally{
      await context.close();
     }
    }
   }
  });
 }

 test('interaction parity: search, filter, selection and back navigation',async({browser},testInfo)=>{
  test.setTimeout(120_000);
  const worker=String(testInfo.workerIndex);
  const cases=[
   {name:'knowledge-search',path:'#/knowledge',ready:'What we’ve learned, kept.',after:'provenance',
    act:async(page:Page)=>{await page.getByRole('searchbox',{name:'Search Knowledge articles'}).fill('provenance');},
    verify:(page:Page)=>page.waitForFunction(()=>document.querySelectorAll('.knowledge-entry').length===1)},
   {name:'knowledge-category',path:'#/knowledge',ready:'What we’ve learned, kept.',after:'provenance',
    act:async(page:Page)=>{await page.getByLabel('CATEGORIES',{exact:true}).selectOption('provenance');},
    verify:(page:Page)=>page.waitForFunction(()=>document.querySelectorAll('.knowledge-entry').length===1)},
   {name:'knowledge-article-navigation',path:'#/knowledge',
    ready:'What we’ve learned, kept.',after:'Terminal routing',
    act:async(page:Page)=>{await page.getByRole('link',{name:'Terminal routing'}).first().click();},
    verify:(page:Page)=>page.waitForFunction(()=>location.hash.includes('terminal-routing'))},
   {name:'documents-search',path:'#/documents/protocol',ready:'Protocol reference',
    after:'server.session.create',
    act:async(page:Page)=>{await page.getByRole('searchbox',{name:'Search protocol units'}).fill('server.session');},
    verify:(page:Page)=>page.waitForFunction(()=>document.querySelectorAll('.documents-entry').length===1)},
   {name:'mcp-search',path:'#/documents/mcp',ready:'MCP Tools',after:'1 / 1 REGISTERED TOOLS',
    act:async(page:Page)=>{await page.getByRole('searchbox',{name:'Search MCP Tools'}).fill('list_agents');},
    verify:(page:Page)=>page.waitForFunction(()=>document.body.innerText.includes('1 / 1 REGISTERED TOOLS'))},
   {name:'agent-outcome-filter',path:'#/agents/developer/dev-qwen-01',ready:'Recent executions',
    after:'Run 12345 / attempt 2',
    act:async(page:Page)=>{await page.getByRole('link',{name:'failure',exact:true}).click();},
    verify:(page:Page)=>page.waitForFunction(()=>location.hash.includes('outcome=failure'))},
   {name:'workflows-select',path:'/workflows.html',ready:'Inside the workflow.',after:'Revision gates',
    act:async(page:Page)=>{await page.locator('#workflow-roster').getByRole('button',{name:/CI \/ Quality Gate/}).click();},
    verify:(page:Page)=>page.waitForFunction(()=>document.body.innerText.includes('Revision gates'))},
  ];
  for(const interaction of cases){
   const context=await browser.newContext({viewport:{width:1365,height:740},colorScheme:'light'});
   const baselinePage=await context.newPage();
   const candidatePage=await context.newPage();
   try{
    await baselinePage.goto(baselineOrigin+interaction.path);
    await candidatePage.goto(candidateOrigin+interaction.path);
    await settle(baselinePage,interaction.ready);
    await settle(candidatePage,interaction.ready);
    await interaction.act(baselinePage);
    await interaction.act(candidatePage);
    await interaction.verify(baselinePage);
    await interaction.verify(candidatePage);
    await settle(baselinePage,interaction.after);
    await settle(candidatePage,interaction.after);
    const baselineObservation=await observe(baselinePage);
    const candidateObservation=await observe(candidatePage);
    const baselineImage=await screenshot(baselinePage);
    const candidateImage=await screenshot(candidatePage);
    const geometry=compareElements(baselineObservation.elements,candidateObservation.elements);
    const screenshotResult=compareScreenshots(baselineImage,candidateImage);
    const textEqual=normalized(baselineObservation.text)===normalized(candidateObservation.text);
    const links=compareLinks(baselineObservation.links,candidateObservation.links);
    const linksEqual=links.equal;
    await record({interaction:interaction.name,path:interaction.path,
     text:{equal:textEqual,baseline_sha256:digest(normalized(baselineObservation.text)),
      candidate_sha256:digest(normalized(candidateObservation.text))},
     links:{equal:linksEqual,count:baselineObservation.links.length,differences:links.differences},
     geometry:{equal:geometry.equal,differences:geometry.differences},
     screenshot:{equal:screenshotResult.equal,baseline_sha256:digest(baselineImage),
      candidate_sha256:digest(candidateImage),
      different_pixels:screenshotResult.differentPixels,total_pixels:screenshotResult.totalPixels,
      max_channel_delta:screenshotResult.maxChannelDelta},
     tolerance:PARITY_TOLERANCE,
    },worker);
    if(!textEqual||!linksEqual||!geometry.equal||!screenshotResult.equal){
     const stem=join(reportDirectory,interaction.name);
     await mkdir(reportDirectory,{recursive:true});
     await writeFile(stem+'-baseline.png',baselineImage);
     await writeFile(stem+'-candidate.png',candidateImage);
     expect.soft({text:textEqual,links:linksEqual,geometry:geometry.equal,
      screenshot:screenshotResult.equal,link_differences:links.differences,
      geometry_differences:geometry.differences,
      screenshot_different_pixels:screenshotResult.differentPixels},
      'interaction parity for '+interaction.name)
      .toEqual({text:true,links:true,geometry:true,screenshot:true,
       link_differences:[],geometry_differences:[],screenshot_different_pixels:0});
    }
   }finally{
    await context.close();
   }
  }
 });
});
