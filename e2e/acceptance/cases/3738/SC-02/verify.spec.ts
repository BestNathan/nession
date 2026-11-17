// #3738 SC-02: a search scan that stops at the file budget reports itself as
// incomplete, and App Search never presents it as an exhaustive absence. A
// complete scan with no match keeps the plain "No files match" message.
//
// The controlled FileOps fixture is seeded with 2,000 filler files before
// `late/needle.txt`, so the late match is beyond the scan's file budget; the
// canonical fixture tree is the complete-scan control.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';
import {
  leaveSearch,
  openAppFiles,
  openSearch,
  searchInput,
  seedSearchForest,
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

test('SC-02: a capped scan never reads as an exhaustive negative result', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppFiles(page);

  // A complete scan with no match keeps the normal empty message.
  await openSearch(page);
  await searchInput(page).fill('zzz-no-such-file');
  await expect(page.getByTestId('files-search-empty')).toHaveText(
    'No files match "zzz-no-such-file".',
  );
  await expect(page.getByTestId('files-search-incomplete')).toHaveCount(0);
  await leaveSearch(page);

  // The match exists but sits beyond the 2,000-file budget: the scan must say
  // it is partial and must not claim the file does not exist.
  await seedSearchForest(page, { filesBeforeMatch: 2_000 });
  await openSearch(page);
  await searchInput(page).fill('needle');
  await expect(page.getByTestId('files-search-incomplete')).toBeVisible();
  const empty = page.getByTestId('files-search-empty');
  await expect(empty).toHaveText(
    'No files match "needle" in the scanned part of this Workspace.',
  );
  await expect(empty).not.toHaveText('No files match "needle".');
  await expect(page.getByTestId('files-search-result-late/needle.txt')).toHaveCount(0);

  expect(sha).toMatch(/^[0-9a-f]{40}$/);
});
