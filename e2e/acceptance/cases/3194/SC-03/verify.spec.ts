// #3194 SC-03: on the real production fixture, at Web 1180/1024 and App
// 390/375/844×390, the representative Workspace detail, configuration-form and
// master/detail flows keep one intended scroll owner, readable content, aligned
// control roles, one App page header/Back and no unintended horizontal
// overflow. The Experience is forced by the fixture route, not inferred from
// the browser width.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock, openFixtureFile } from '../../../../helpers/fixtureVisual';
import type { AssertOptions } from '../../../../helpers/ui-assert/assertions';
import {
  expectFormFieldAlignment,
  expectSingleAppHeader,
  expectSingleWorkspaceScrollOwner,
  expectWorkspaceMasterDetail,
  growUntilWorkspaceScrolls,
} from '../../../../helpers/ui-assert/layout';
import { expectNoPageOverflow } from '../../../../helpers/ui-assert/assertions';
import { loadContracts } from '../../../../helpers/ui-assert/contracts';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

function canonicalViewport(experience: 'web' | 'app', width: number) {
  const row = loadContracts().viewports.find(
    (item) => item.experience === experience && item.width === width,
  );
  if (row === undefined) {
    throw new Error(`canonical ${experience} viewport ${width} is missing from design/contracts/viewports.json`);
  }
  return row;
}

async function openAppWorkspace(page: Page): Promise<void> {
  await page.goto('/#/fixture/app');
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').first().click();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
}

test('SC-03: representative Workspace layouts keep one host, one header and one scroll owner', async ({
  page,
}) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-03');
  await freezeFixtureClock(page);

  // ── Web: master/detail, Workspace detail, configuration form ──
  for (const width of [1180, 1024]) {
    const viewport = canonicalViewport('web', width);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const opts: AssertOptions = {
      pattern: 'pattern.workspace-navigation',
      experience: 'web',
      viewport: viewport.id,
    };

    await page.goto('/#/fixture/workspace?capability=files');
    const files = page.getByTestId('file-workspace');
    await expect(files).toBeVisible();
    await expectWorkspaceMasterDetail(files, opts);
    await expectNoPageOverflow(page, opts);

    await page.goto('/#/fixture/workspace?capability=session');
    await expect(page.getByTestId('session-details-web')).toHaveAttribute(
      'data-workspace-scroll-owner',
      'true',
    );
    await expectNoPageOverflow(page, opts);

    await page.goto('/#/fixture/workspace?capability=sandbox');
    await page.getByTestId('sandbox-tab-filesystem').click();
    await growUntilWorkspaceScrolls(page, 'sandbox-fs-read-add');
    const sandboxForm = page.locator('[data-recipe="configuration-form"]').first();
    await expectFormFieldAlignment(sandboxForm, opts);
    await expectSingleWorkspaceScrollOwner(page.getByTestId('workspace-tool-content'), {
      ...opts,
      recipe: false,
    });
    await expectNoPageOverflow(page, opts);
  }

  // ── App: one header/Back at the root and a pushed depth; one host scroller ──
  for (const width of [390, 375, 844]) {
    const viewport = canonicalViewport('app', width);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const opts: AssertOptions = {
      pattern: 'pattern.workspace-navigation',
      experience: 'app',
      viewport: viewport.id,
    };

    await openAppWorkspace(page);
    await page.getByTestId('workspace-tool-sandbox').click();
    await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
    await expectSingleAppHeader(page, opts);

    await page.getByTestId('sandbox-tab-resource').click();
    await growUntilWorkspaceScrolls(page, 'sandbox-resource-add');
    await expectFormFieldAlignment(
      page.locator('[data-recipe="configuration-form"]').first(),
      opts,
    );
    await expectSingleWorkspaceScrollOwner(page.getByTestId('workspace-tool-content'), {
      ...opts,
      recipe: true,
    });
    await expectSingleAppHeader(page, opts);
    await expectNoPageOverflow(page, opts);

    // A pushed Files viewer is still one depth: one header and one leave.
    await openAppWorkspace(page);
    await expect(page.getByTestId('files-app-layout')).toBeVisible();
    await openFixtureFile(page);
    await expectSingleAppHeader(page, opts);
    await expectNoPageOverflow(page, opts);
  }
});
