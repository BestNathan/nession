import {test,expect} from '@playwright/test';
import {startPagesFixture} from '../helpers/pagesStandalone';

// Pages-only browser proof. This is deliberately outside the product Web/
// Server/Agent/tmux E2E catalog and uses the same isolated public fixture as
// other standalone Pages tests.
test.describe('public Pages shared navigation',()=>{
 let site:Awaited<ReturnType<typeof startPagesFixture>>;
 test.beforeAll(async()=>{site=await startPagesFixture();});
 test.afterAll(async()=>{await site.close();});

 test('all routes keep the same header across index and Workflows',async({page})=>{
  await page.goto(site.origin+'/#/knowledge');
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  const labels=['Overview','AI Agents','Collaboration','Workflows',
   'Knowledge','Prototypes','Repository','Evidence'];
  await expect(nav.getByRole('link')).toHaveCount(labels.length);
  await expect(nav.getByRole('link')).toHaveText(labels);
  await expect(nav.getByRole('link',{name:'Knowledge'})).toHaveAttribute('aria-current','page');

  await nav.getByRole('link',{name:'Workflows'}).click();
  await expect(page).toHaveURL(/\/workflows\.html$/);
  await expect(page.getByRole('heading',{name:'Inside the workflow.'})).toBeVisible();
  await expect(nav.getByRole('link')).toHaveText(labels);
  await expect(nav.getByRole('link',{name:'Workflows'})).toHaveAttribute('aria-current','page');
  await expect(nav.getByRole('link',{name:'Knowledge'})).toHaveAttribute('href','index.html#/knowledge');
  await expect(nav.getByRole('link',{name:'Prototypes'})).toHaveAttribute('href','index.html#/prototypes');

  await nav.getByRole('link',{name:'Prototypes'}).click();
  await expect(page).toHaveURL(/\/index\.html#\/prototypes$/);
  await expect(nav.getByRole('link')).toHaveText(labels);
  await expect(nav.getByRole('link',{name:'Prototypes'})).toHaveAttribute('aria-current','page');

  await nav.getByRole('link',{name:'Collaboration'}).click();
  await expect(nav.getByRole('link',{name:'Collaboration'})).toHaveAttribute('aria-current','page');
  await nav.getByRole('link',{name:'Workflows'}).click();
  await expect(nav.getByRole('link')).toHaveCount(labels.length);
 });

 test('mobile retains all destinations and usable workflow-to-knowledge navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(site.origin+'/workflows.html');
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  await expect(nav.getByRole('link')).toHaveCount(8);
  await nav.getByRole('link',{name:'Knowledge'}).click();
  await expect(page).toHaveURL(/\/index\.html#\/knowledge$/);
  await expect(page.getByRole('heading',{name:'What we’ve learned, kept.'})).toBeVisible();
  await expect(nav.getByRole('link',{name:'Knowledge'})).toHaveAttribute('aria-current','page');
  await nav.getByRole('link',{name:'Workflows'}).click();
  await expect(page.getByRole('heading',{name:'Inside the workflow.'})).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(8);
 });
});
