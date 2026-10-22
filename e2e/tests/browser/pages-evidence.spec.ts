import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';
test.describe('standalone Pages evidence',()=>{
 let site:Awaited<ReturnType<typeof startPagesFixture>>;
 test.beforeAll(async()=>{site=await startPagesFixture();});
 test.afterAll(async()=>{await site.close();});
 test('repository figures have source revision and measured coverage',async({page})=>{
  await page.goto(site.origin+'/#/repository');
  await expect(page.getByRole('heading',{name:'Built in the open.'})).toBeVisible();
  await expect(page.getByText('Repository metrics source: stale',{exact:false})).toBeVisible();
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
 test('independently attested per-ID E2E never becomes an SC verdict or PR linkage',async({page})=>{
   await page.setViewportSize({width:390,height:844});
   await page.goto(site.origin+'/#/work/issue/1782');
   await expect(page.getByRole('heading',{name:'Source-bound per-ID E2E receipts'})).toBeVisible();
   await expect(page.getByText('Canonical test source: available · pinned ref cccccccccccc')).toBeVisible();
   await expect(page.getByRole('link',{name:/pages-overview · Pass · Run 42 \/ attempt 1/}))
     .toHaveAttribute('href','https://github.com/BestNathan/nession/actions/runs/42');
   await expect(page.getByRole('link',{name:/pages-evidence · Fail · Run 42 \/ attempt 1/})).toBeVisible();
   await expect(page.getByText('Agent Store source readiness: empty',{exact:false})).toBeVisible();
   await expect(page.getByRole('link',{name:/Pinned Agent Store source dddddddddddd/})).toHaveAttribute('href',
     'https://github.com/BestNathan/nession/tree/agent-store');
   await expect(page.getByText('Trusted Acceptance SC: Unknown / Not independently observed.')).toBeVisible();
   await expect(page.getByText('Implementing PR / logical Slice: Unknown / Unlinked')).toBeVisible();
   await page.reload();
   await expect(page.getByText('Trusted Acceptance SC: Unknown / Not independently observed.')).toBeVisible();
   await page.goto(site.origin+'/#/work/pr/1787');
   await expect(page.getByText('Trusted Acceptance SC: Unknown / Not independently observed.')).toBeVisible();
   await expect(page.getByText('Issue implementation/Agent Slice: Unknown / Unlinked')).toBeVisible();
 });

});
