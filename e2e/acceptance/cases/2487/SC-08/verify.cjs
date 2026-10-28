'use strict';
// #2487 SC-08: the release-selected terminal configuration travels from one
// parameter source through the image/Compose/GitOps deployment pipeline into
// the **running Server process environment**, and the Server validates and
// reads the effective values at startup without drifting from the Web bundle.
//
// This Case executes the real projection and the real reader:
//   deploy/render-server-config.sh  ->  config.toml  ->  `nession-server
//   --print-config` (same parser, environment precedence and validation the
//   runtime uses)  ->  JSON the Case compares with the Web build's emitted
//   configuration. It also asserts the wiring exists in both image paths, the
//   Compose file and the two release workflows; it never claims a staging pod
//   was inspected (that needs a deployed environment binding).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  root,
  targetSha,
  TERMINAL_COLS_ENV,
  TERMINAL_WEB_FONT_SIZE_ENV,
  VITE_TERMINAL_COLS_ENV,
  VITE_TERMINAL_WEB_FONT_SIZE_ENV,
  webBuild,
  buildConfig,
  renderServerConfig,
  printServerConfig,
  expectFailure,
  requireText,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run } = require('../../../shared/control-mode-cases.cjs');

function temp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2487-sc08-'));
  return path.join(dir, name);
}

run(({ evidence }) => {
  const sha = targetSha();

  // 1. A selected release parameter -> generated config -> the Server's own
  //    parser and validation, including the environment override precedence.
  const generated = temp('config.toml');
  const rendered = renderServerConfig(generated, {
    [TERMINAL_COLS_ENV]: '96',
    [TERMINAL_WEB_FONT_SIZE_ENV]: '13.5',
  });
  if (!rendered.includes('terminal_cols = 96') ||
      !rendered.includes('terminal_web_font_size = 13.5')) {
    throw new Error('the entrypoint renderer did not project the selected values:\n' + rendered);
  }
  const effective = printServerConfig(generated, {
    [TERMINAL_COLS_ENV]: '96',
    [TERMINAL_WEB_FONT_SIZE_ENV]: '13.5',
  });
  if (effective.terminal_cols !== 96 || effective.terminal_web_font_size !== 13.5) {
    throw new Error('the Server parser read ' + JSON.stringify(effective));
  }

  // 2. The Web artifact built from the same selected values agrees.
  const web = buildConfig(webBuild(temp('dist'), {
    [VITE_TERMINAL_COLS_ENV]: '96',
    [VITE_TERMINAL_WEB_FONT_SIZE_ENV]: '13.5',
  }));
  if (web.cols !== 96 || web.web_max_font_size !== 13.5) {
    throw new Error('the Web build emitted ' + JSON.stringify(web));
  }

  // 3. Missing values fall back deterministically in both halves.
  const defaultConfig = temp('default.toml');
  const defaultToml = renderServerConfig(defaultConfig);
  if (!defaultToml.includes('terminal_cols = 96') ||
      !defaultToml.includes('terminal_web_font_size = 14')) {
    throw new Error('the renderer has no deterministic default:\n' + defaultToml);
  }
  const defaultEffective = printServerConfig(defaultConfig);
  if (defaultEffective.terminal_cols !== 96 || defaultEffective.terminal_web_font_size !== 14) {
    throw new Error('the Server default read ' + JSON.stringify(defaultEffective));
  }

  // 4. Invalid runtime values fail startup instead of serving a different grid.
  const invalidToml = temp('invalid.toml');
  renderServerConfig(invalidToml, { [TERMINAL_COLS_ENV]: '0' });
  expectFailure(
    () => printServerConfig(invalidToml),
    TERMINAL_COLS_ENV + ' must be in [20, 400]',
  );
  // The environment wins over a valid file, and is validated the same way.
  expectFailure(
    () => printServerConfig(defaultConfig, { [TERMINAL_COLS_ENV]: 'eighty' }),
    TERMINAL_COLS_ENV + ' must be a positive integer',
  );
  expectFailure(
    () => printServerConfig(defaultConfig, { [TERMINAL_WEB_FONT_SIZE_ENV]: '32.1' }),
    TERMINAL_WEB_FONT_SIZE_ENV + ' must be a number',
  );

  // 5. Both image paths carry the runtime ENV, both entrypoints project it,
  //    Compose states it, and both release workflows pass the build inputs to
  //    the Web build and the image builds. The image ENV (set from a build
  //    ARG) is what reaches the running container; GitOps advances the image
  //    identity rather than hand-editing a manifest.
  for (const dockerfile of [
    'Dockerfile.server', 'Dockerfile.server.prebuilt',
    'Dockerfile.agent', 'Dockerfile.agent.prebuilt',
  ]) {
    requireText(dockerfile, [
      `ARG ${TERMINAL_COLS_ENV}=96`,
      `ENV ${TERMINAL_COLS_ENV}=\${${TERMINAL_COLS_ENV}}`,
    ]);
  }
  requireText('Dockerfile.server.prebuilt', [
    `ARG ${TERMINAL_WEB_FONT_SIZE_ENV}=14`,
    `ENV ${TERMINAL_WEB_FONT_SIZE_ENV}=\${${TERMINAL_WEB_FONT_SIZE_ENV}}`,
  ]);
  requireText('Dockerfile.server', [
    `ARG ${VITE_TERMINAL_COLS_ENV}=96`,
    `ENV ${VITE_TERMINAL_COLS_ENV}=\${${VITE_TERMINAL_COLS_ENV}}`,
  ]);
  requireText('deploy/docker-compose.yml', [
    `${TERMINAL_COLS_ENV}: "\${${TERMINAL_COLS_ENV}:-96}"`,
    `${TERMINAL_WEB_FONT_SIZE_ENV}: "\${${TERMINAL_WEB_FONT_SIZE_ENV}:-14}"`,
  ]);
  requireText('deploy/entrypoint-server.sh', ['render-server-config.sh']);
  requireText('deploy/entrypoint-agent.sh', ['terminal_cols = ${AGENT_TERMINAL_COLS}']);
  for (const workflow of [
    '.github/workflows/release-staging.yml',
    '.github/workflows/release-production.yml',
  ]) {
    requireText(workflow, [
      VITE_TERMINAL_COLS_ENV,
      VITE_TERMINAL_WEB_FONT_SIZE_ENV,
      'vars.' + TERMINAL_COLS_ENV,
      TERMINAL_COLS_ENV + '=${{',
      'RELEASE_TERMINAL_COLS: ${{ vars.' + TERMINAL_COLS_ENV + " || '96' }}",
      'RELEASE_TERMINAL_WEB_FONT_SIZE: ${{ vars.' + TERMINAL_WEB_FONT_SIZE_ENV + " || '14' }}",
    ]);
    const text = fs.readFileSync(path.join(root, workflow), 'utf8');
    if (/vars\.(?:STAGING|PRODUCTION)_TERMINAL_(?:COLS|WEB_FONT_SIZE)/.test(text)) {
      throw new Error(workflow + ' retains obsolete environment-specific terminal variable precedence');
    }
    const serverBuildArgs = (text.match(/build-args:/g) || []).length;
    if (serverBuildArgs < 2) {
      throw new Error(workflow + ' does not pass build args to both image paths');
    }
  }

  evidence.push(
    {
      type: 'config',
      value: 'exact SHA ' + sha + ': render-server-config.sh projected cols=96/font=13.5 into ' +
        'config.toml and `nession-server --print-config` read back 96/13.5 through its canonical ' +
        'parser and validation',
    },
    {
      type: 'build',
      value: 'the Web bundle built from the same 96/13.5 parameters emitted 96/13.5; omitted inputs ' +
        'read back as 96/14 in both the renderer and the Server parser',
    },
    {
      type: 'config',
      value: 'cols=0, cols=eighty and font=32.1 each failed the Server reader visibly; the entrypoint ' +
        'writes the values and the runtime environment overrides and validates them',
    },
    {
      type: 'static',
      value: 'both Server/Agent image paths carry ARG+ENV, Compose states both variables, and both ' +
        'release workflows pass the Web build inputs and the image build args from one parameter source',
    },
  );
  return 'One release parameter reaches the Web bundle and the Server process configuration, agrees on cols, defaults deterministically and fails fast on invalid values';
});
