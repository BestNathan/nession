'use strict';
// Shared machinery for the #3023 Agent EROFS cache Cases.
const { crateTests } = require('./control-mode-cases.cjs');

/** Run one exact Agent-library test filter at the target checkout. */
function agentCacheTests(filter, timeout = 600000) {
  return crateTests('nession-agent', [filter], timeout);
}

module.exports = { agentCacheTests };
