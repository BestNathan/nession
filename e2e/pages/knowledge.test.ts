import {test,expect,type Route} from '@playwright/test';
import {startPagesFixture} from '../helpers/pagesStandalone';

// This Pages-only smoke suite is NOT a canonical product E2E ID. It runs
// under playwright.pages.config.ts, outside the product runtime testDir.
// Standalone public Pages. These tests never start Nession Server, Agent, tmux
// or the product Web; the browser reads only the deterministic public fixture.
const first='topics/engineering/knowledge-provenance.md';
const second='topics/terminal/terminal-routing.md';

// Expand the same safe public projection to expose real nested-scroll behavior.
async function serveLongKnowledgeCatalog(route:Route){
 const response=await route.fetch();
 const data=await response.json();
 data.articles=Array.from({length:40},(_,i)=>({
  ...data.articles[0],
  path:'topics/engineering/catalog-entry-'+String(i+1).padStart(2,'0')+'.md',
  title:'Catalog entry '+String(i+1).padStart(2,'0'),
  description:'Independent scroll fixture '+String(i+1),
  body:Array.from({length:48},(_,j)=>'## Section '+(j+1)+'\n\nLong source-grounded reading content.').join('\n\n')
 }));
 await route.fulfill({json:data});
}

test.describe('standalone Pages Knowledge Explorer',()=>{
 let site:Awaited<ReturnType<typeof startPagesFixture>>;
 test.beforeAll(async()=>{site=await startPagesFixture();});
 test.afterAll(async()=>{await site.close();});

 test('desktop discovery, text/topic/category filters and honest no-results state',async({page})=>{
  await page.setViewportSize({width:1365,height:900});
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(site.origin+'/#/knowledge');
  await expect(page.getByRole('heading',{name:'What we’ve learned, kept.'})).toBeVisible();
  await expect(page.getByText('knowledge @ '+'c'.repeat(12))).toBeVisible();
  await expect(page.locator('.knowledge-entry')).toHaveCount(2);
  await expect(page.locator('.knowledge-reader')).toBeVisible();

  const search=page.getByRole('searchbox',{name:'Search Knowledge articles'});
  await search.fill('provenance');
  await expect(page.locator('.knowledge-entry')).toHaveCount(1);
  await expect(page.locator('.knowledge-entry').first()).toContainText('Knowledge provenance');
  await search.fill('');
  await page.locator('.knowledge-topic-group').getByRole('button',{name:/terminal\s+1/i}).click();
  await expect(page.locator('.knowledge-entry')).toHaveCount(1);
  await expect(page.locator('.knowledge-entry')).toContainText('Terminal routing');

  await page.locator('.knowledge-topic-group').getByRole('button',{name:/All topics/i}).click();
  await page.getByLabel('CATEGORIES',{exact:true}).selectOption('provenance');
  await expect(page.locator('.knowledge-entry')).toHaveCount(1);
  await expect(page.locator('.knowledge-entry')).toContainText('Knowledge provenance');
  await page.getByLabel('CATEGORIES',{exact:true}).selectOption('all');
  await search.fill('missing from every article');
  await expect(page.locator('.knowledge-entry')).toHaveCount(0);
  await expect(page.getByText('No matching articles. Try another topic, category or search term.')).toBeVisible();
  expect(errors).toEqual([]);
 });

 test('desktop long catalog and article reader scroll separately without moving the search header',async({page})=>{
  await page.setViewportSize({width:1365,height:740});
  await page.route('**/data/knowledge.json',serveLongKnowledgeCatalog);
  await page.goto(site.origin+'/#/knowledge');
  const entries=page.getByRole('region',{name:'Knowledge article list'});
  const reader=page.getByRole('region',{name:'Knowledge article reader'});
  const search=page.getByRole('searchbox',{name:'Search Knowledge articles'});
  const count=page.locator('.knowledge-result-count');
  await expect(page.locator('.knowledge-entry')).toHaveCount(40);
  await expect(entries).toHaveCSS('overflow-y','auto');
  await expect(reader).toHaveCSS('overflow-y','auto');
  expect(await entries.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  expect(await reader.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);

  await entries.hover();
  const headerTop=(await search.boundingBox())!.y;
  const countTop=(await count.boundingBox())!.y;
  const pageTop=await page.evaluate(()=>window.scrollY);
  await page.mouse.wheel(0,700);
  await expect.poll(()=>entries.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  const catalogScroll=await entries.evaluate(el=>el.scrollTop);
  expect((await search.boundingBox())!.y).toBeCloseTo(headerTop,0);
  expect((await count.boundingBox())!.y).toBeCloseTo(countTop,0);
  expect(await page.evaluate(()=>window.scrollY)).toBe(pageTop);
  expect(await reader.evaluate(el=>el.scrollTop)).toBe(0);

  await reader.hover();
  await page.mouse.wheel(0,700);
  await expect.poll(()=>reader.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  expect(await entries.evaluate(el=>el.scrollTop)).toBe(catalogScroll);
  const target=page.locator('.knowledge-entry').nth(23);
  await target.scrollIntoViewIfNeeded();
  const before=await entries.evaluate(el=>el.scrollTop);
  await target.click();
  await expect(reader.getByRole('heading',{name:'Catalog entry 24'})).toBeVisible();
  expect(await entries.evaluate(el=>el.scrollTop)).toBeCloseTo(before,0);
  expect(await reader.evaluate(el=>el.scrollTop)).toBe(0);
 });

 for(const viewport of [{width:1365,height:740},{width:1440,height:900},{width:900,height:740}]){
  test('bounded desktop workspace with 200 articles and 100 tags at '+viewport.width,async({page})=>{
   await page.setViewportSize(viewport);
   await page.route('**/data/knowledge.json',async route=>{
    const response=await route.fetch();const data=await response.json();
    data.categories=Array.from({length:100},(_,i)=>'tag-'+String(i+1).padStart(3,'0'));
    data.articles=Array.from({length:200},(_,i)=>({
     ...data.articles[0],path:'topics/engineering/stress-'+i+'.md',
     title:'Article '+i,description:'A long description '.repeat(20),
     categories:[data.categories[i%100]],body:'## Section\n\n'+('Long source-grounded content.\n\n').repeat(150)
    }));
    await route.fulfill({json:data});
   });
   await page.goto(site.origin+'/#/knowledge');
   const layout=page.locator('.knowledge-layout');
   const entries=page.getByRole('region',{name:'Knowledge article list'});
   const reader=page.getByRole('region',{name:'Knowledge article reader'});
   await expect(page.locator('.knowledge-entry')).toHaveCount(200);
   const geometry=await layout.evaluate(el=>{
    const rect=el.getBoundingClientRect();
    return {top:rect.top,bottom:rect.bottom,panes:[...el.children].map(p=>{
     const r=p.getBoundingClientRect();return {top:r.top,bottom:r.bottom};
    }),pageHeight:document.documentElement.scrollHeight,viewport:innerHeight};
   });
   for(const pane of geometry.panes){
    expect(pane.top).toBeCloseTo(geometry.top,0);
    expect(pane.bottom).toBeCloseTo(geometry.bottom,0);
   }
   expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport);
   expect(geometry.pageHeight).toBeLessThanOrEqual(geometry.viewport+1);
   const search=page.getByRole('searchbox',{name:'Search Knowledge articles'});
   const headerTop=(await search.boundingBox())!.y;
   await entries.evaluate(el=>{el.scrollTop=el.scrollHeight;});
   await expect(page.locator('.knowledge-entry').last()).toBeInViewport();
   expect((await search.boundingBox())!.y).toBeCloseTo(headerTop,0);
   expect(await reader.evaluate(el=>el.scrollTop)).toBe(0);
   const catalogTop=await entries.evaluate(el=>el.scrollTop);
   await reader.evaluate(el=>{el.scrollTop=el.scrollHeight;});
   expect(await reader.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
   expect(await entries.evaluate(el=>el.scrollTop)).toBe(catalogTop);
   const categorySearch=page.getByRole('searchbox',{name:'Search categories'});
   const category=page.getByLabel('CATEGORIES',{exact:true});
   await categorySearch.fill('tag-100');
   await expect(category.locator('option')).toHaveCount(2);
   await category.selectOption('tag-100');
   await expect(page.locator('.knowledge-entry')).toHaveCount(2);
   await category.selectOption('all');
   await expect(page.locator('.knowledge-entry')).toHaveCount(200);
   expect(await layout.evaluate(el=>el.getBoundingClientRect().bottom)).toBeCloseTo(geometry.bottom,0);
  });
 }

 test('compact Knowledge long list scrolls internally and still opens and returns from reader',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/data/knowledge.json',serveLongKnowledgeCatalog);
  await page.goto(site.origin+'/#/knowledge');
  const entries=page.getByRole('region',{name:'Knowledge article list'});
  await expect(entries).toHaveCSS('overflow-y','auto');
  expect(await entries.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await entries.focus();
  await expect(entries).toBeFocused();
  await entries.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect(page.locator('.knowledge-entry').last()).toBeInViewport();
  await page.locator('.knowledge-entry').last().click();
  await expect(page.getByRole('region',{name:'Knowledge article reader'})).toBeVisible();
  await expect(page.locator('.knowledge-reader').getByRole('heading',{name:'Catalog entry 40'})).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  expect(overflow).toBe(false);
  await page.getByRole('link',{name:'← All articles'}).click();
  await expect(entries).toBeVisible();
 });

 test('compact category search remains accessible with 100 tags',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/data/knowledge.json',async route=>{
   const response=await route.fetch();const data=await response.json();
   data.categories=Array.from({length:100},(_,i)=>'category-'+String(i+1).padStart(3,'0'));
   data.articles[0].categories=[data.categories[99]];
   await route.fulfill({json:data});
  });
  await page.goto(site.origin+'/#/knowledge');
  const search=page.getByRole('searchbox',{name:'Search categories'});
  const category=page.getByLabel('CATEGORIES',{exact:true});
  await search.fill('category-100');
  await expect(category.locator('option')).toHaveCount(2);
  await category.selectOption('category-100');
  await expect(page.locator('.knowledge-entry')).toHaveCount(1);
  await page.locator('.knowledge-entry').first().click();
  await expect(page.getByRole('region',{name:'Knowledge article reader'})).toBeVisible();
  await page.getByRole('link',{name:'← All articles'}).click();
  await expect(category).toHaveValue('category-100');
  await category.selectOption('all');
  await expect(page.locator('.knowledge-entry')).toHaveCount(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 });

 test('deep-link reader, relative article link, pinned sources, history and browser navigation',async({page})=>{
  await page.goto(site.origin+'/#/knowledge?article='+encodeURIComponent(first));
  const reader=page.locator('.knowledge-reader');
  await expect(reader.getByRole('heading',{name:'Knowledge provenance'})).toBeVisible();
  await expect(reader.getByRole('heading',{name:'Source-bound decisions'})).toBeVisible();
  await expect(reader.getByRole('heading',{name:'Evidence sources'})).toBeVisible();
  await expect(reader.getByRole('link',{name:/Original at pinned SHA/}))
    .toHaveAttribute('href','https://github.com/BestNathan/nession/blob/'+'c'.repeat(40)+'/'+first);
  await expect(reader.getByRole('link',{name:/Git history/}))
    .toHaveAttribute('href','https://github.com/BestNathan/nession/commits/knowledge/'+first);
  await expect(reader.getByRole('link',{name:/Source 1/}))
    .toHaveAttribute('href','https://github.com/BestNathan/nession/issues/2358');

  await reader.getByRole('link',{name:'Terminal routing'}).click();
  await expect(page).toHaveURL(/article=topics%2Fterminal%2Fterminal-routing\.md/);
  await expect(reader.getByRole('heading',{name:'Terminal routing'})).toBeVisible();
  await page.goBack();
  await expect(reader.getByRole('heading',{name:'Knowledge provenance'})).toBeVisible();
  await page.goForward();
  await expect(reader.getByRole('heading',{name:'Terminal routing'})).toBeVisible();
  await page.reload();
  await expect(reader.getByRole('heading',{name:'Terminal routing'})).toBeVisible();

  await page.goto(site.origin+'/#/knowledge?article=../private.md');
  await expect(page.locator('.knowledge-reader')).toBeVisible();
  await expect(page.locator('.knowledge-reader')).not.toContainText('private.md');
 });

 test('compact viewport switches list to reader and returns without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(site.origin+'/#/knowledge');
  await expect(page.locator('.knowledge-listbox')).toBeVisible();
  await expect(page.locator('.knowledge-reader-slot')).toBeHidden();
  // Compact layouts must keep both topic and category controls accessible.
  const mobileCategory=page.getByLabel('CATEGORIES',{exact:true});
  await expect(mobileCategory).toBeVisible();
  await mobileCategory.selectOption('terminal');
  await expect(page.locator('.knowledge-entry')).toHaveCount(1);
  await page.locator('.knowledge-entry').filter({hasText:'Terminal routing'}).click();
  await expect(page).toHaveURL(/article=topics%2Fterminal%2Fterminal-routing\.md/);
  await expect(page.locator('.knowledge-reader-slot')).toBeVisible();
  await expect(page.locator('.knowledge-listbox')).toBeHidden();
  await expect(page.locator('.knowledge-reader').getByRole('heading',{name:'Terminal routing'})).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  expect(overflow).toBe(false);
  await page.getByRole('link',{name:'← All articles'}).click();
  await expect(page.locator('.knowledge-listbox')).toBeVisible();
  await expect(page.locator('.knowledge-reader-slot')).toBeHidden();
 });

 test('keyboard activates the same deep-linkable article as pointer input',async({page})=>{
  await page.goto(site.origin+'/#/knowledge');
  const item=page.locator('.knowledge-entry').filter({hasText:'Terminal routing'});
  await item.focus();
  await expect(item).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/article=topics%2Fterminal%2Fterminal-routing\.md/);
  await expect(page.locator('.knowledge-reader').getByRole('heading',{name:'Terminal routing'})).toBeVisible();
 });

 test('global Changes uses one source log and links to current articles',async({page})=>{
  await page.goto(site.origin+'/#/knowledge?view=changes');
  await expect(page.getByRole('heading',{name:'Changes over time.'})).toBeVisible();
  await expect(page.locator('.knowledge-event')).toHaveCount(2);
  await expect(page.getByText('Clarify canonical evidence linkage.')).toBeVisible();
  await expect(page.locator('.knowledge-event').first().getByRole('link',{name:/Source issue \/ PR/}))
    .toHaveAttribute('href','https://github.com/BestNathan/nession/issues/2358');
  await page.locator('.knowledge-event').first().getByRole('link',{name:/Read current article/}).click();
  await expect(page).toHaveURL(/article=topics%2Fengineering%2Fknowledge-provenance\.md/);
  await expect(page.locator('.knowledge-reader').getByRole('heading',{name:'Knowledge provenance'})).toBeVisible();
 });

 test('missing Knowledge snapshot is unavailable, never an invented empty knowledge base',async({page})=>{
  await page.route('**/data/knowledge.json',route=>route.fulfill({status:503,body:'unavailable'}));
  await page.goto(site.origin+'/#/knowledge');
  await expect(page.getByRole('heading',{name:'Knowledge snapshot unavailable'})).toBeVisible();
  await expect(page.getByText('The pinned source could not be validated or loaded.',{exact:false})).toBeVisible();
  await expect(page.locator('.knowledge-entry')).toHaveCount(0);
  await page.getByRole('link',{name:'Collaboration',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Work in progress.'})).toBeVisible();
 });
});
