import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test.describe('standalone Pages technical Documents',()=>{
  let site:Awaited<ReturnType<typeof startPagesFixture>>;
  test.beforeAll(async()=>{site=await startPagesFixture();});
  test.afterAll(async()=>{await site.close();});

  test('desktop reads source-pinned technical references and filters the catalog',async({page})=>{
    await page.setViewportSize({width:1365,height:900});
    await page.goto(site.origin+'/#/documents');
    await expect(page.getByRole('heading',{name:'Technical documents'})).toBeVisible();
    await expect(page.locator('.documents-entry')).toHaveCount(2);
    await expect(page.locator('.documents-reader > h2')).toHaveText('Protocol Architecture');
    await expect(page.locator('.documents-prose table')).toHaveCount(1);
    await expect(page.locator('.documents-prose pre')).toHaveCount(1);
    await expect(page.locator('.documents-reader .documents-source')).toHaveAttribute('href',
      'https://github.com/BestNathan/nession/blob/'+'a'.repeat(40)+'/docs/architecture/protocol.md');
    await page.getByRole('searchbox',{name:'Search technical documents'}).fill('authentication');
    await expect(page.locator('.documents-entry')).toHaveCount(1);
    await page.locator('.documents-entry').click();
    await expect(page.locator('.documents-reader > h2')).toHaveText('MCP Access Layer');
    await expect(page.locator('.documents-reader img')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.documents-reader > h2')).toHaveText('MCP Access Layer');
    await expect(page.getByRole('link',{name:'Documents',exact:true})).toHaveAttribute('aria-current','page');
  });

  test('mobile uses list then reader, back navigation and never overflows',async({page})=>{
    await page.setViewportSize({width:390,height:844});
    await page.goto(site.origin+'/#/documents');
    await expect(page.locator('.documents-listbox')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
    await page.locator('.documents-entry').filter({hasText:'MCP Access Layer'}).click();
    await expect(page.locator('.documents-reader-slot')).toBeVisible();
    await expect(page.locator('.documents-listbox')).toBeHidden();
    await expect(page.getByRole('link',{name:'← All documents'})).toBeVisible();
    await expect(page.locator('.documents-reader img')).toHaveCount(0);
    await expect.poll(async()=>page.evaluate(()=>
      document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.getByRole('link',{name:'← All documents'}).click();
    await expect(page.locator('.documents-listbox')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
  });

  test('unavailable projection has explicit missing source semantics',async({page})=>{
    await page.route('**/data/documents.json',route=>route.fulfill({
      status:200,contentType:'application/json',
      body:JSON.stringify({schema_version:1,status:'unavailable',source:null,documents:[]})
    }));
    await page.goto(site.origin+'/#/documents');
    await expect(page.getByRole('heading',{name:'Documents unavailable'})).toBeVisible();
    await expect(page.getByText('this does not mean there are no technical documents',{exact:false})).toBeVisible();
  });
});
