import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../../helpers/pagesStandalone';

test.describe('public source-backed GitHub Workflow topology',()=>{
 let site:Awaited<ReturnType<typeof startPagesFixture>>;
 test.beforeAll(async()=>{site=await startPagesFixture();});
 test.afterAll(async()=>{await site.close();});

 test('navigation, declared edge and source/trigger inspection',async({page})=>{
  await page.goto(site.origin+'/#/');
  await page.getByRole('link',{name:'Workflows',exact:true}).click();
  await expect(page).toHaveURL(/\/workflows\.html$/);
  await expect(page.getByRole('heading',{name:'Inside the workflow.'})).toBeVisible();
  await expect(page.getByText('3 / 3 core workflows · 1 / 1 declared connections')).toBeVisible();
  await expect(page.locator('path[data-edge-key="ci-quality>acceptance-orchestrator:workflow_run"]')).toHaveCount(1);
  await page.locator('#workflow-roster').getByRole('button',{name:/CI \/ Quality Gate/}).click();
  await expect(page.locator('#workflow-detail').getByText('Revision gates')).toBeVisible();
  await expect(page.locator('#workflow-detail').getByText('PR',{exact:true})).toBeVisible();
  await expect(page.locator('#workflow-detail').getByRole('link',{name:'Open pinned workflow source ↗'}))
   .toHaveAttribute('href','https://github.com/BestNathan/nession/blob/'+'a'.repeat(40)+'/.github/workflows/ci-quality.yml');
  await expect(page.locator('#workflow-detail').getByText('Acceptance / Orchestrator · workflow_run')).toBeVisible();
  await expect(page.locator('#workflow-detail').getByText('This source declaration is not evidence that a run executed',{exact:false})).toBeVisible();
 });

 test('mobile, search, stage filtering and no inferred agent dispatch relation',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(site.origin+'/workflows.html');
  await expect(page.getByRole('heading',{name:'Inside the workflow.'})).toBeVisible();
  await page.getByLabel('Find workflow').fill('issue audit');
  await expect(page.getByText('1 / 3 core workflows · 0 / 1 declared connections')).toBeVisible();
  await expect(page.locator('#workflow-roster').getByRole('button')).toHaveCount(1);
  await page.locator('#workflow-roster').getByRole('button').click();
  await expect(page.locator('#workflow-detail').getByText('Issue audit only, not direct Developer dispatch')).toBeVisible();
  await expect(page.locator('#workflow-detail').getByText('Manual/API dispatch')).toBeVisible();
  await page.getByLabel('Find workflow').fill('');
  await page.getByLabel('Focus on').selectOption('quality');
  await expect(page.locator('#workflow-roster').getByRole('button')).toHaveCount(1);
  await expect(page.getByText('1 / 3 core workflows · 0 / 1 declared connections')).toBeVisible();
  await page.reload();
  await expect(page.getByText('3 / 3 core workflows · 1 / 1 declared connections')).toBeVisible();
 });

 test('unavailable projection never shows invented workflow graph',async({page})=>{
  await page.route('**/data/workflows.json',route=>route.fulfill({status:503,body:'offline'}));
  await page.goto(site.origin+'/workflows.html');
  await expect(page.getByText('Source topology unavailable; no graph or success status can be inferred.')).toBeVisible();
  await expect(page.locator('[data-workflow-id]')).toHaveCount(0);
 });
});
