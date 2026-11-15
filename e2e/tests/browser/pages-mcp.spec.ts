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
