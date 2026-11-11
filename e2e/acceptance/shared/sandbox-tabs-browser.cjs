'use strict';
// Shared browser helpers for the #3143 Sandbox peer-tab Cases.
const { expect } = require('@playwright/test');

const TABS = ['overview', 'filesystem', 'network', 'process', 'resource', 'syscall'];

async function openWebSandbox(page, query = '') {
  await page.goto(`/#/fixture/workspace?capability=sandbox${query}`);
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
}

async function openAppSandbox(page, query = '') {
  await page.goto(`/#/fixture/app${query}`);
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
}

async function selectTab(page, tab) {
  await page.getByTestId(`sandbox-tab-${tab}`).click();
  await expect(page.getByTestId(`sandbox-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
}

module.exports = { TABS, openWebSandbox, openAppSandbox, selectTab };
