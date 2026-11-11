import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test.describe('standalone Pages Protocol Reference',()=>{
  let site:Awaited<ReturnType<typeof startPagesFixture>>;
  test.beforeAll(async()=>{site=await startPagesFixture();});
  test.afterAll(async()=>{await site.close();});

  test('desktop shows generated protocol versions and a single since-Nession field',async({page})=>{
    await page.setViewportSize({width:1365,height:900});
    await page.goto(site.origin+'/#/documents');
    await expect(page.getByRole('heading',{name:'Protocol reference'})).toBeVisible();
    await expect(page.locator('.documents-entry')).toHaveCount(2);
    await expect(page.locator('.documents-reader > h2')).toHaveText('git.status');
    await expect(page.locator('.documents-field-table')).toHaveCount(2);
    await expect(page.getByRole('columnheader',{name:'Since Nession'}).first()).toBeVisible();
    await expect(page.getByRole('columnheader',{name:'0.35.0'})).toHaveCount(0);
    await expect(page.locator('.documents-since.verified').first()).toHaveText('0.36.0');
    await expect(page.locator('.documents-since.unknown').first()).toHaveText('Unknown');
    await expect(page.locator('.documents-version')).toHaveCount(2);
    await page.getByRole('link',{name:'v2',exact:true}).click();
    await expect(page.locator('.documents-version.active')).toHaveText('v2');
    await expect(page.locator('.documents-reader > h2')).toHaveText('git.status');
    await expect(page.locator('.documents-reader .documents-source')).toHaveAttribute('href',
      'https://github.com/BestNathan/nession/blob/'+'a'.repeat(40)+
      '/crates/nession-protocol-codegen/src/catalog.rs');
    await page.getByRole('searchbox',{name:'Search protocol units'}).fill('server.session');
    await expect(page.locator('.documents-entry')).toHaveCount(1);
    await page.locator('.documents-entry').click();
    await expect(page.locator('.documents-reader > h2')).toHaveText('server.session.create');
    await expect(page.getByText('This contract has no response payload.',{exact:false})).toBeVisible();
    await page.reload();
    await expect(page.locator('.documents-reader > h2')).toHaveText('server.session.create');
    await expect(page.getByRole('link',{name:'Documents',exact:true})).toHaveAttribute('aria-current','page');
  });

  test('mobile switches between protocol list and details without horizontal overflow',async({page})=>{
    await page.setViewportSize({width:390,height:844});
    await page.goto(site.origin+'/#/documents');
    await expect(page.locator('.documents-listbox')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
    await page.locator('.documents-entry').filter({hasText:'server.session.create'}).click();
    await expect(page.locator('.documents-reader-slot')).toBeVisible();
    await expect(page.locator('.documents-listbox')).toBeHidden();
    await expect(page.getByRole('link',{name:'← All protocols'})).toBeVisible();
    await expect.poll(async()=>page.evaluate(()=>
      document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.getByRole('link',{name:'← All protocols'}).click();
    await expect(page.locator('.documents-listbox')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
  });

  test('unavailable projection does not imply an empty protocol catalog',async({page})=>{
    await page.route('**/data/documents.json',route=>route.fulfill({
      status:200,contentType:'application/json',
      body:JSON.stringify({schema_version:3,status:'unavailable',source:null,
        definitions:{},releases:[],protocols:[]})
    }));
    await page.goto(site.origin+'/#/documents');
    await expect(page.getByRole('heading',{name:'Protocol catalog unavailable'})).toBeVisible();
    await expect(page.getByText('This is not an empty protocol catalog.',{exact:false})).toBeVisible();
  });
});
