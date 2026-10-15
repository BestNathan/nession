import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';
test.describe('standalone Pages evidence',()=>{
 let site:Awaited<ReturnType<typeof startPagesFixture>>;
 test.beforeAll(async()=>{site=await startPagesFixture();});
 test.afterAll(async()=>{await site.close();});
 test('repository figures have source revision and measured coverage',async({page})=>{
  await page.goto(site.origin+'/#/repository');
  await expect(page.getByRole('heading',{name:'Built in the open.'})).toBeVisible();
  await expect(page.getByText('85%',{exact:true})).toBeVisible();
  await expect(page.getByText('90%',{exact:true})).toBeVisible();
  await expect(page.getByText('Current measured main revision · aaaaaaaaaaaa', {exact:true})).toBeVisible();
 });
 test('orphan ref presence never claims independent audit',async({page})=>{
  await page.goto(site.origin+'/#/evidence');
  await expect(page.getByRole('heading',{name:'Evidence, not claims.'})).toBeVisible();
  await expect(page.getByText('Integrity: not independently verified by this public site')).toHaveCount(2);
  await expect(page.getByText('Ref not verified / unavailable')).toBeVisible();
  await expect(page.getByRole('link',{name:'View public branch',exact:false})).toHaveCount(1);
 });
});
