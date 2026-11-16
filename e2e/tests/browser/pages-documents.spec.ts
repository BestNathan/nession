import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test.describe('standalone Pages Documents and Protocol Reference',()=>{
  let site:Awaited<ReturnType<typeof startPagesFixture>>;
  test.beforeAll(async()=>{site=await startPagesFixture();});
  test.afterAll(async()=>{await site.close();});

  test('index opens each category, Protocol keeps versions and historical deep links',async({page})=>{
    await page.setViewportSize({width:1365,height:900});
    await page.goto(site.origin+'/#/documents');
    await expect(page.getByRole('heading',{name:'Documents',exact:true})).toBeVisible();
    await expect(page.locator('.documents-index-card')).toHaveCount(2);
    await page.getByRole('link',{name:/Explore Protocol/}).click();
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
    await expect(page.getByRole('link',{name:'Documents',exact:true}).first()).toHaveAttribute('aria-current','page');
    // Historical Protocol URLs still select the originally addressed contract.
    await page.goto(site.origin+'/#/documents?protocol=git.status&v=2');
    await expect(page.locator('.documents-reader > h2')).toHaveText('git.status');
    await expect(page.locator('.documents-version.active')).toHaveText('v2');
    await page.getByRole('navigation',{name:'Documents breadcrumb'}).getByRole('link',{name:'Documents'}).click();
    await expect(page.getByRole('heading',{name:'Documents',exact:true})).toBeVisible();
    await page.getByRole('link',{name:/Explore MCP/}).click();
    await expect(page.getByRole('heading',{name:'MCP Tools'})).toBeVisible();
  });

  test('desktop keeps Protocol list/search and detail independently scrollable',async({page})=>{
    await page.setViewportSize({width:1365,height:740});
    await page.route('**/data/documents.json',async route=>{
      const response=await route.fetch();
      const data=await response.json();
      const base=data.protocols[0];
      for(const version of base.versions)for(const half of ['request','response'] as const){
        const payload=version[half];
        if(payload)payload.fields.push(...Array.from({length:50},(_,i)=>({
          path:'fixture.extra_field_'+i,type:'string',required:false,description:'Fixture field '+i,
          variant:'',since:null,since_status:'unknown'
        })));
      }
      for(let i=0;i<35;i++)data.protocols.push({
        ...structuredClone(base),id:'fixture.protocol.'+String(i).padStart(2,'0')
      });
      await route.fulfill({response,json:data});
    });
    await page.goto(site.origin+'/#/documents/protocol');
    const list=page.locator('.documents-list-scroll');
    const detail=page.locator('.documents-reader-slot');
    await expect(page.locator('.documents-browser-controls')).toBeVisible();
    await expect(page.locator('.documents-reader > h2')).toHaveText('git.status');
    expect(await list.evaluate(el=>getComputedStyle(el).overflowY)).toBe('auto');
    expect(await detail.evaluate(el=>getComputedStyle(el).overflowY)).toBe('auto');
    await page.locator('.documents-entry').filter({hasText:'fixture.protocol.24'}).scrollIntoViewIfNeeded();
    const previousListTop=await list.evaluate(el=>el.scrollTop);
    expect(previousListTop).toBeGreaterThan(0);
    await page.locator('.documents-entry').filter({hasText:'fixture.protocol.24'}).click();
    await expect(page.locator('.documents-reader > h2')).toHaveText('fixture.protocol.24');
    expect(await list.evaluate(el=>el.scrollTop)).toBeGreaterThanOrEqual(previousListTop-4);
    await detail.evaluate(el=>{el.scrollTop=250;});
    expect(await detail.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    expect(await list.evaluate(el=>el.scrollTop)).toBeGreaterThanOrEqual(previousListTop-4);
    await expect(page.locator('.documents-search')).toBeVisible();
  });

  test('mobile uses list/detail/back states without horizontal overflow',async({page})=>{
    await page.setViewportSize({width:390,height:844});
    await page.goto(site.origin+'/#/documents');
    await page.getByRole('link',{name:/Explore Protocol/}).click();
    await expect(page.locator('.documents-browser-pane')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
    await page.locator('.documents-entry').filter({hasText:'server.session.create'}).click();
    await expect(page.locator('.documents-reader-slot')).toBeVisible();
    await expect(page.locator('.documents-browser-pane')).toBeHidden();
    await expect(page.getByRole('link',{name:'← All protocols'})).toBeVisible();
    await expect.poll(async()=>page.evaluate(()=>
      document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.getByRole('link',{name:'← All protocols'}).click();
    await expect(page.locator('.documents-browser-pane')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
  });

  test('unavailable projection does not imply an empty catalog or corrupt the index',async({page})=>{
    await page.route('**/data/documents.json',route=>route.fulfill({
      status:200,contentType:'application/json',
      body:JSON.stringify({schema_version:3,status:'unavailable',source:null,
        definitions:{},releases:[],protocols:[]})
    }));
    await page.goto(site.origin+'/#/documents');
    await expect(page.getByText('Catalog unavailable')).toBeVisible();
    await page.getByRole('link',{name:/Explore Protocol/}).click();
    await expect(page.getByRole('heading',{name:'Protocol catalog unavailable'})).toBeVisible();
    await expect(page.getByText('This is not an empty protocol catalog.',{exact:false})).toBeVisible();
  });
});
