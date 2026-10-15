import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';
test.describe('standalone Pages overview',()=>{
 let site:Awaited<ReturnType<typeof startPagesFixture>>;
 test.beforeAll(async()=>{site=await startPagesFixture();});
 test.afterAll(async()=>{await site.close();});
 test('shows project and independently registered Agent observations',async({page})=>{
  await page.goto(site.origin+'/#/');
  await expect(page.getByRole('heading',{name:/An open space/})).toBeVisible();
  await page.getByRole('link',{name:'AI Agents',exact:true}).click();
  await expect(page.getByRole('heading',{name:'The agents behind the work.'})).toBeVisible();
  await expect(page.getByText('dev-qwen-01')).toBeVisible();
  await expect(page.getByText('Unobserved',{exact:true})).toBeVisible();
  await expect(page.getByText('Not observed')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Who ran the work'})).toBeVisible();
  await expect(page.getByText('cursor', {exact:true})).toBeVisible();
  await expect(page.getByText('issue-audit', {exact:true})).toBeVisible();
  await expect(page.getByText('14', {exact:true})).toBeVisible();
 });
 test('mobile direct deep link and untrusted Issue text do not execute markup',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(site.origin+'/#/work');
  await expect(page.getByRole('heading',{name:'Work in progress.'})).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.getByText('observed Agent runs (7d): 2', {exact:false})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Work in progress.'})).toBeVisible();
 });
});
