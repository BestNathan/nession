// Migration compatibility alias. Lifecycle lives ONLY in e2e/runner/runtime.
// Remove after workflow, Case and Gate parity is verified (refs #1497).
module.exports = require('../../e2e/runner/runtime/full-stack.js');
if (require.main === module) {
  if (process.argv[2] === 'self-test') {
    const { spawnSync } = require('node:child_process');
    const { resolve } = require('node:path');
    const child = spawnSync(process.execPath,
      [resolve(__dirname, '../../e2e/runner/runtime/full-stack.js'), 'self-test'], { stdio: 'inherit' });
    process.exitCode = child.status ?? 2;
  } else {
    console.error('usage: node acceptance/runtime/full-stack.js self-test');
    process.exitCode = 2;
  }
}
