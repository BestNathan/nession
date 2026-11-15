import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test('MCP Documents renders the pinned Rust registry catalog',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.goto(site.origin+'/#/documents/mcp');
    await expect(page.getByRole('heading',{name:'MCP Tools'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await expect(page.getByText('1 registered Tools')).toBeVisible();
    await page.getByText('Input JSON Schema').click();
    await expect(page.locator('.documents-raw code')).toContainText('"type": "object"');
    await page.getByRole('link',{name:'← Protocol reference'}).click();
    await expect(page.getByRole('heading',{name:'Protocol reference'})).toBeVisible();
  }finally{await site.close();}
});

test('MCP source-pinned upstream context, deep links and mobile search stay readable',async({page})=>{
  const site=await startPagesFixture();
  try{
    await page.setViewportSize({width:390,height:844});
    await page.goto(site.origin+'/#/documents/mcp?tool=nession_server_list_agents');
    await expect(page.getByRole('heading',{name:'MCP 2026-07-28'})).toBeVisible();
    await expect(page.getByText('Previous revision: 2025-11-25',{exact:false})).toBeVisible();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading',{name:'nession_server_list_agents'})).toBeVisible();
    await page.getByRole('searchbox',{name:'Search MCP Tools'}).fill('does-not-exist');
    await expect(page.getByText('No matching MCP Tools.')).toBeVisible();
    await expect(page.locator('body')).toEvaluate(el=>el.scrollWidth<=window.innerWidth+2);
    await page.goto(site.origin+'/#/documents/mcp?tool=unknown_tool');
    await expect(page.getByRole('heading',{name:'Unknown MCP Tool'})).toBeVisible();
  }finally{await site.close();}
});
