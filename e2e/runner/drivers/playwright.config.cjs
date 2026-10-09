const path = require('node:path');
const { defineConfig } = require('../../node_modules/@playwright/test');

module.exports = defineConfig({
  testDir: path.resolve(__dirname, '../../acceptance/cases'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: process.env.NESSION_ACCEPTANCE_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
