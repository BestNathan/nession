import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test('MCP Documents renders the pinned Rust registry and returns to Documents index',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.goto(site.origin+'/#/documents/mcp');
    await expect(page.getByRole('heading',{name:'MCP Tools'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await expect(page.locator('.documents-count')).toContainText('1 / 1 REGISTERED TOOLS');
    await page.getByText('Input JSON Schema').click();
    await expect(page.locator('.documents-mcp-contract').first()
      .locator('.documents-raw code')).toContainText('"type": "object"');
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
    await expect(page.locator('.documents-mcp-spec > summary')).toContainText('MCP 2026-07-28');
    await expect(page.locator('.documents-mcp-spec')).not.toHaveAttribute('open');
    await page.locator('.documents-mcp-spec > summary').click();
    await expect(page.getByText('previous 2025-11-25',{exact:false})).toBeVisible();
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

test('MCP detail prioritizes Tool identity, named input/output fields and compact optional protocol provenance',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.setViewportSize({width:1365,height:820});
    await page.route('**/data/mcp.json',async route=>{
      const response=await route.fetch();
      const data=await response.json();
      data.tools[0].name='nession_server_list_agents';
      data.tools[0].description='List actual registered Nession Agents.';
      data.tools[0].inputSchema={type:'object',required:['scope'],properties:{
        scope:{type:'string',description:'Server-scoped query'},
        filters:{$ref:'#/$defs/Filters'}
      },$defs:{Filters:{type:'object',properties:{
        agent_id:{type:'string',description:'Only the requested Agent identity'}
      }}}};
      data.tools[0].outputSchema={type:'object',required:['agents'],properties:{
        agents:{type:'array',description:'Registered Agent records',items:{type:'object',
          properties:{id:{type:'string',description:'Canonical Agent ID'}}}},
        cursor:{anyOf:[{type:'string'},{type:'null'}],description:'Next result cursor'}
      }};
      await route.fulfill({response,json:data});
    });
    await page.goto(site.origin+'/#/documents/mcp?tool=nession_server_list_agents');
    const tool=page.locator('.documents-mcp-tool-detail');
    await expect(tool.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await expect(tool.getByText('List actual registered Nession Agents.')).toBeVisible();
    const heads=await page.locator('.documents-mcp-reader h2, .documents-mcp-reader h3').allTextContents();
    expect(heads[0]).toBe('nession_server_list_agents');
    await expect(page.getByRole('heading',{name:'Input fields'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Output fields'})).toBeVisible();
    await expect(tool.locator('.documents-mcp-field-name')).toContainText([
      'scope','filters','filters.agent_id','agents','agents[].id','cursor']);
    await expect(tool.getByText('Server-scoped query',{exact:true})).toBeVisible();
    await expect(tool.getByText('Only the requested Agent identity',{exact:true})).toBeVisible();
    await expect(tool.getByText('Registered Agent records',{exact:true})).toBeVisible();
    await expect(tool.getByText('Canonical Agent ID',{exact:true})).toBeVisible();
    await expect(page.locator('.documents-mcp-reader > .documents-mcp-spec')).not.toHaveAttribute('open');
    await tool.getByText('Output JSON Schema').click();
    await expect(tool.locator('.documents-mcp-contract').nth(1).locator('.documents-mcp-raw code')).toContainText('agents');
  }finally{await site.close();}
});

test('MCP output fields expose requiredness from the declared schema',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.goto(site.origin+'/#/documents/mcp?tool=nession_server_list_agents');
    await expect(page.getByRole('heading',{name:'Output fields'})).toBeVisible();
    const output=page.locator('.documents-mcp-contract').nth(1);
    await expect(output.locator('.documents-mcp-field-name')).toContainText([
      'agents','agents[].agent_id']);
    await expect(output.locator('.documents-mcp-field').first()).toContainText('Required');
    await expect(page.locator('.documents-mcp-spec')).not.toHaveAttribute('open');
  }finally{await site.close();}
});

test('MCP catalog without a real output schema fails closed instead of inventing fields',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.route('**/data/mcp.json',async route=>{
      const response=await route.fetch();
      const data=await response.json();
      delete data.tools[0].outputSchema;
      await route.fulfill({response,json:data});
    });
    await page.goto(site.origin+'/#/documents/mcp?tool=nession_server_list_agents');
    await expect(page.getByText('MCP catalog unavailable or unverified.'))
      .toBeVisible();
    await expect(page.getByRole('heading',{name:'Output fields'})).toHaveCount(0);
  }finally{await site.close();}
});
