'use strict';
// Source-aligned App Search browser helpers for #3738.
//
// The route is the production App fixture; the file tree behind it is the
// fixture's controlled FileOps (`window.fixtureFiles`), so a Case can create a
// Search-scale Workspace without a real remote agent.

async function openAppFiles(page) {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('files-app-layout').waitFor();
}

async function openSearch(page) {
  await page.getByRole('button', { name: 'Search files' }).click();
  await page.getByTestId('files-app-search').waitFor();
}

async function leaveSearch(page) {
  await page.getByTestId('app-page-back').click();
  await page.getByTestId('files-app-layout').waitFor();
}

async function seedSearchForest(page, options) {
  await page.evaluate((value) => {
    window.fixtureFiles?.seedSearchForest(value);
  }, options);
}

async function setListDirDelay(page, milliseconds) {
  await page.evaluate((value) => {
    window.fixtureFiles?.setListDirDelay(value);
  }, milliseconds);
}

function searchInput(page) {
  return page.getByPlaceholder('Search files');
}

module.exports = {
  openAppFiles,
  openSearch,
  leaveSearch,
  seedSearchForest,
  setListDirDelay,
  searchInput,
};
