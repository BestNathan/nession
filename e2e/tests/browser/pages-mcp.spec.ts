import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test('MCP Documents renders the pinned Rust registry and returns to Documents index',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.goto(site.origin+'/#/documents/mcp');
    await expect(page.getByRole('heading',{name:'MCP Tools'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await expect(page.getByText('1 registered Tools',{exact:true})).toBeVisible();
    await page.getByText('Input JSON Schema').click();
    await expect(page.locator('.documents-raw code')).toContainText('"type": "object"');
    await expect(page.getByRole('link',{name:'Documents',exact:true}).first()).toHaveAttribute('aria-current','page');
    await page.getByRole('navigation',{name:'Documents breadcrumb'}).getByRole('link',{name:'Documents'}).click();
    await expect(page.getByRole('heading',{name:'Documents',exact:true})).toBeVisible();
  }finally{await site.close();}
});

test('MCP desktop list and Tool detail scroll independently without losing selection position',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.setViewportSize({width:1365,height:740});
    await page.route('**/data/mcp.json',async route=>{
      const response=await route.fetch();
      const data=await response.json();
      const tool=data.tools[0];
      data.tools.push(...Array.from({length:35},(_,i)=>({
        ...structuredClone(tool),name:'nession_fixture_tool_'+String(i).padStart(2,'0'),
        description:'Source-pinned fixture Tool with long readable contract',
        inputSchema:{type:'object',properties:Object.fromEntries(
          Array.from({length:80},(_,j)=>['field_'+j,{type:'string',description:'Fixture field '+j}]))}
      })));
      await route.fulfill({response,json:data});
    });
    await page.goto(site.origin+'/#/documents/mcp');
    const list=page.locator('.documents-list-scroll');
    const detail=page.locator('.documents-reader-slot');
    expect(await list.evaluate(el=>getComputedStyle(el).overflowY)).toBe('auto');
    expect(await detail.evaluate(el=>getComputedStyle(el).overflowY)).toBe('auto');
    const chosen=page.locator('.documents-entry').filter({hasText:'nession_fixture_tool_24'});
    await chosen.scrollIntoViewIfNeeded();
    const before=await list.evaluate(el=>el.scrollTop);
    expect(before).toBeGreaterThan(0);
    await chosen.click();
    await expect(page.getByRole('heading',{name:'nession_fixture_tool_24'})).toBeVisible();
    expect(await list.evaluate(el=>el.scrollTop)).toBeGreaterThanOrEqual(before-4);
    await page.getByText('Input JSON Schema').click();
    await detail.evaluate(el=>{el.scrollTop=250;});
    expect(await detail.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    expect(await list.evaluate(el=>el.scrollTop)).toBeGreaterThanOrEqual(before-4);
    await expect(page.getByRole('searchbox',{name:'Search MCP Tools'})).toBeVisible();
  }finally{await site.close();}
});

test('MCP mobile deep link, list/back, search and unknown state stay readable',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.setViewportSize({width:390,height:844});
    await page.goto(site.origin+'/#/documents/mcp?tool=nession_server_list_agents');
    await expect(page.getByRole('heading',{name:'MCP 2026-07-28'})).toBeVisible();
    await expect(page.getByText('Previous revision: 2025-11-25',{exact:false})).toBeVisible();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await expect(page.locator('.documents-browser-pane')).toBeHidden();
    await page.reload();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await page.getByRole('link',{name:'← All MCP Tools'}).click();
    await expect(page.locator('.documents-browser-pane')).toBeVisible();
    await expect(page.locator('.documents-reader-slot')).toBeHidden();
    await page.getByRole('searchbox',{name:'Search MCP Tools'}).fill('does-not-exist');
    await expect(page.getByText('No matching MCP Tools.')).toBeVisible();
    expect(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth+2)).toBe(true);
    await page.goto(site.origin+'/#/documents/mcp?tool=unknown_tool');
    await expect(page.getByRole('heading',{name:'Unknown MCP Tool'})).toBeVisible();
    await expect(page.getByRole('link',{name:'← All MCP Tools'})).toBeVisible();
  }finally{await site.close();}
});
