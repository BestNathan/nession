import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../helpers/pagesStandalone';

// This Pages-only smoke suite is NOT a canonical product E2E ID. It runs
// under playwright.pages.config.ts, outside the product runtime testDir.
// Standalone public Pages. These tests never start Nession Server, Agent, tmux
// or the product Web; the browser reads only the deterministic public fixture.
const first='topics/engineering/knowledge-provenance.md';
const second='topics/terminal/terminal-routing.md';

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
  await page.locator('.knowledge-categories').getByRole('button',{name:'provenance',exact:true}).click();
  await expect(page.locator('.knowledge-entry')).toHaveCount(1);
  await expect(page.locator('.knowledge-entry')).toContainText('Knowledge provenance');
  await page.locator('.knowledge-categories').getByRole('button',{name:'All tags'}).click();
  await search.fill('missing from every article');
  await expect(page.locator('.knowledge-entry')).toHaveCount(0);
  await expect(page.getByText('No matching articles. Try another topic, category or search term.')).toBeVisible();
  expect(errors).toEqual([]);
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
