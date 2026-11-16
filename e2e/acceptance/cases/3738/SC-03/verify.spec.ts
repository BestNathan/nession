// #3738 SC-03: at the canonical mobile App viewport, Search's loading state,
// partial-results disclosure, complete empty result and Search -> Viewer
// selection stay distinguishable and usable.
//
// The controlled FileOps fixture holds one match before the file budget
// (`early/needle.txt`) and one beyond it (`late/needle.txt`), so the partial
// scan is both disclosed and still useful.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';
import {
  openAppFiles,
  openSearch,
  searchInput,
  seedSearchForest,
  setListDirDelay,
} from '../../../shared/app-search-3738-browser.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      seedSearchForest: (options?: {
        emptyDirectories?: number;
        filesBeforeMatch?: number;
        matchBeforeBudget?: boolean;
      }) => void;
      setListDirDelay: (milliseconds: number) => void;
    };
  }
}

test('SC-03: App Search states and Viewer selection stay usable', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppFiles(page);

  // Loading is observable while the remote index is still being read.
  await seedSearchForest(page, { filesBeforeMatch: 2_000, matchBeforeBudget: true });
  await setListDirDelay(page, 400);
  await openSearch(page);
  await expect(page.getByTestId('files-search-loading')).toBeVisible();

  // The scan stops at the file budget and says so; the early match is usable.
  await expect(page.getByTestId('files-search-incomplete')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('files-search-loading')).toHaveCount(0);
  await searchInput(page).fill('needle');
  const early = page.getByTestId('files-search-result-early/needle.txt');
  await expect(early).toBeVisible();
  await expect(page.getByTestId('files-search-result-late/needle.txt')).toHaveCount(0);
  await early.click();
  await expect(page.locator('.cm-content')).toContainText('fixture early needle');

  // Choosing a result leaves Search and opens the viewer; Back returns to the
  // Files directory the selection came from.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await seedSearchForest(page, { filesBeforeMatch: 0 });
  await openSearch(page);
  await searchInput(page).fill('zzz-no-such-file');
  await expect(page.getByTestId('files-search-empty')).toHaveText(
    'No files match "zzz-no-such-file".',
  );
  await expect(page.getByTestId('files-search-incomplete')).toHaveCount(0);
});
