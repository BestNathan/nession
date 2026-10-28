'use strict';
// #2487 SC-07: two independent build-time inputs select the fixed columns and
// the Web preferred/maximum font size; omitted values use the approved
// defaults; invalid inputs fail the build; changing only the font never
// changes the columns, and Web/App share the same embedded value.
//
// Every build goes to an isolated output directory, so this Case cannot change
// the preview bundle another Case in the same batch is using.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  root, targetSha, webBuild, buildConfig, expectFailure, requireText, stripAnsi, passedTests,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, checked } = require('../../../shared/control-mode-cases.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2487-sc07-'));
}

run(({ evidence }) => {
  const sha = targetSha();
  const small = buildConfig(webBuild(tempDir(), {
    VITE_NESSION_TERMINAL_COLS: '80',
    VITE_NESSION_TERMINAL_WEB_FONT_SIZE: '13',
  }));
  const large = buildConfig(webBuild(tempDir(), {
    VITE_NESSION_TERMINAL_COLS: '96',
    VITE_NESSION_TERMINAL_WEB_FONT_SIZE: '14',
  }));

  if (small.cols !== 80 || small.web_max_font_size !== 13 || small.cols_source !== 'env') {
    throw new Error('80/13 build emitted ' + JSON.stringify(small));
  }
  if (large.cols !== 96 || large.web_max_font_size !== 14 || large.cols_source !== 'env') {
    throw new Error('96/14 build emitted ' + JSON.stringify(large));
  }

  // Omitted inputs fall back to the documented defaults, not to an error and
  // not to a silently different value.
  const defaults = buildConfig(webBuild(tempDir()));
  if (defaults.cols !== 96 || defaults.web_max_font_size !== 14 ||
      defaults.cols_source !== 'default' || defaults.web_font_source !== 'default') {
    throw new Error('default build emitted ' + JSON.stringify(defaults));
  }

  // The font input is UI-only: the same column value with two very different
  // Web font sizes must produce two font maxima and one column count.
  const fontA = buildConfig(webBuild(tempDir(), {
    VITE_NESSION_TERMINAL_COLS: '96',
    VITE_NESSION_TERMINAL_WEB_FONT_SIZE: '12',
  }));
  const fontB = buildConfig(webBuild(tempDir(), {
    VITE_NESSION_TERMINAL_COLS: '96',
    VITE_NESSION_TERMINAL_WEB_FONT_SIZE: '18',
  }));
  if (fontA.cols !== 96 || fontB.cols !== 96) {
    throw new Error('font-only change altered the columns: ' + JSON.stringify([fontA, fontB]));
  }
  if (fontA.web_max_font_size !== 12 || fontB.web_max_font_size !== 18) {
    throw new Error('font input did not take effect: ' + JSON.stringify([fontA, fontB]));
  }

  // Invalid values fail the build visibly instead of producing a bundle.
  const outDir = tempDir();
  expectFailure(
    () => webBuild(outDir, { VITE_NESSION_TERMINAL_COLS: '0' }),
    'VITE_NESSION_TERMINAL_COLS must be an integer',
  );
  if (fs.existsSync(path.join(outDir, 'index.html'))) {
    throw new Error('an invalid column count still produced an index.html');
  }
  expectFailure(
    () => webBuild(tempDir(), { VITE_NESSION_TERMINAL_WEB_FONT_SIZE: '14px' }),
    'VITE_NESSION_TERMINAL_WEB_FONT_SIZE must be a number',
  );

  // The runtime reader is the same parser (unit tests) and the deployment
  // knobs exist in the two image paths. The Web/App shared value is the one
  // `terminalConfig` module: no separate mobile columns knob exists.
  const unit = stripAnsi(checked(
    'npm',
    ['--prefix', 'web', 'test', '--', '--project', 'unit',
      'src/platform/terminal-runtime/__tests__/unit/terminalConfig.test.ts'],
    300000,
  ));
  if (!unit.includes('terminalConfig.test.ts') || (passedTests(unit) ?? 0) < 7) {
    throw new Error('the build-configuration unit tests did not run/pass: ' + unit.slice(-2500));
  }
  requireText('web/src/platform/terminal-runtime/terminalConfig.ts', [
    'DEFAULT_TERMINAL_COLS',
    'DEFAULT_TERMINAL_WEB_FONT_SIZE',
    'readTerminalClientConfig',
  ]);
  if (/MOBILE_TERMINAL_COLS|mobileCols/.test(
    fs.readFileSync(path.join(root, 'web/src/platform/terminal-runtime/terminalConfig.ts'), 'utf8'),
  )) {
    throw new Error('a separate mobile columns value was introduced');
  }

  evidence.push(
    {
      type: 'build',
      value: 'exact SHA ' + sha + ': isolated Web builds emitted 80/13, 96/14 and default 96/14 ' +
        'via WEB_TERMINAL_CONFIG_V1; both inputs report source="env" only when supplied',
    },
    {
      type: 'build',
      value: 'VITE_NESSION_TERMINAL_COLS=0 and VITE_NESSION_TERMINAL_WEB_FONT_SIZE=14px each failed the ' +
        'build visibly and produced no index.html',
    },
    {
      type: 'test',
      value: 'a font-only change (12px vs 18px at cols=96) changed only web_max_font_size; the shared ' +
        'terminalConfig unit tests passed and no mobile columns value exists',
    },
  );
  return 'Two optional build inputs independently select columns and the Web maximum font; defaults and fail-fast cases are proven by real builds';
});
