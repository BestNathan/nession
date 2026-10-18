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
  await expect(page.getByText('Agent metrics source: unavailable',{exact:false})).toBeVisible();
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
  await expect(page.getByRole('link',{name:'PR #1787 · GitHub cross-reference'})).toBeVisible();
  await expect(page.getByText('Pinned Metrics · Issue Agent Runs · PR linkage: Unlinked')).toBeVisible();
  await expect(page.getByRole('link',{name:'Agent acceptor / review-cursor-01 · requirement-acceptance · run 81 / attempt 2'})).toHaveAttribute('href','https://github.com/BestNathan/nession/actions/runs/81');
  await expect(page.getByText('GitHub Run identity verified',{exact:false})).toBeVisible();
  await expect(page.getByText('GitHub Timeline · PR cross-references (not ownership or SC proof)')).toBeVisible();
  await expect(page.getByText('Quality · success · run 42 / attempt 1')).toBeVisible();
  await expect(page.getByText('E2E: Not observed')).toBeVisible();
  await expect(page.getByText('PR Review · observed exact-HEAD event, not overall approval')).toBeVisible();
  await expect(page.getByRole('link',{name:'Review · changes requested · review 89 · HEAD aaaaaaaaaaaa'})).toHaveAttribute('href','https://github.com/BestNathan/nession/pull/1787#pullrequestreview-89');
  await page.reload();
  await expect(page.getByRole('heading',{name:'Work in progress.'})).toBeVisible();
 });
 test('direct Issue and PR evidence routes render source-bound partial facts only',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(site.origin+'/#/work/issue/1782');
  await expect(page.getByText('PR mentions only')).toBeVisible();
  await expect(page.getByText('Implementation relationship: Unknown / Unlinked')).toBeVisible();
  await expect(page.getByText('Source truncated · more runs may exist beyond the sampled window.')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Run 81 / attempt 2 ↗'})).toHaveAttribute('href',
    'https://github.com/BestNathan/nession/actions/runs/81');
  await expect(page.getByText('PR linkage: Unlinked',{exact:false})).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Implementation relationship: Unknown / Unlinked')).toBeVisible();
  await page.getByRole('link',{name:'← All recent work'}).click();
  await page.getByRole('link',{name:'Inspect exact-HEAD PR evidence  ↗'}).click();
  await expect(page.getByText('Observed HEAD: '+'a'.repeat(40))).toBeVisible();
  await expect(page.getByRole('link',{name:/Quality · success · Run 42 \/ attempt 1/}))
    .toHaveAttribute('href','https://github.com/BestNathan/nession/actions/runs/42');
  await expect(page.getByText('Issue implementation/Agent Slice: Unknown / Unlinked')).toBeVisible();
  await expect(page.getByText('Acceptance SC verdict: Not independently observed here.')).toBeVisible();
  await expect(page.getByRole('link',{name:/Review event changes requested/})).toHaveAttribute('href',
    'https://github.com/BestNathan/nession/pull/1787#pullrequestreview-89');
 });
 test('unknown, malformed and unlisted evidence routes never show a forged source',async({page})=>{
  for(const route of [
    '/work/issue/99999','/work/pr/99999',
    '/work/issue/-1','/work/pr/01','/work/issue/1234567890',
    '/work/issue/6%2f7','/work/issue/6?secret=1',
  ]){
    await page.goto(site.origin+'/#'+route);
    await expect(page.getByText(/Evidence unavailable in this bounded snapshot|Invalid evidence reference/)).toBeVisible();
    await expect(page.getByText('Implementation relationship: Unknown / Unlinked')).toHaveCount(0);
  }
 });
});
