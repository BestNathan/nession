'use strict';
// Shared machinery for the #3023/#3303 EROFS cache Cases.
const { crateTests } = require('./control-mode-cases.cjs');

/** Run one exact cache-owner test filter at the target checkout. */
function agentCacheTests(filter, timeout = 600000) {
  return crateTests('nession-erofs', ['--features', 'cache', '--lib', filter], timeout);
}

module.exports = { agentCacheTests };
