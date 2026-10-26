'use strict';
// #2469 SC-01: nession-tmux is a standalone, Nession-independent Rust library.
//
// This Case proves the slice-1 part of the criterion at the exact merged
// staging SHA: the crate's own dependency graph, source and manifest name no
// Nession crate, and its tests run without Agent initialization — the
// in-memory wire tests, a self-contained fake process, and a real isolated tmux
// server on a private socket. The packaged/external-consumer fixture is the
// final slice's hardening step and is not claimed here.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, targetSha, checked, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');
const crate = path.join(root, 'crates/nession-tmux');

function standaloneTree() {
  const output = checked(
    'cargo',
    ['tree', '-p', 'nession-tmux', '--edges', 'normal,build,dev', '--prefix', 'none'],
    180000,
  );
  const foreign = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^nession[-_]/.test(line))
    .filter((line) => !/^nession-tmux v0\.1\.0/.test(line));
  if (foreign.length > 0) {
    throw new Error('nession-tmux depends on a Nession crate:\n' + foreign.join('\n'));
  }
  return output;
}

run(({ evidence }) => {
  const sha = targetSha();

  // The crate's own tests, including the static independence checks.
  const tests = checked('cargo', ['test', '-p', 'nession-tmux'], 300000);
  assertRan(tests, [
    'the_manifest_has_no_nession_dependency',
    'the_source_and_tests_name_no_nession_crate',
    'a_real_pty_cc_attach_handshakes_and_answers_a_command',
    'real_isolated_tmux_supports_pipe_and_pty_control_attachments',
  ]);

  // The dependency graph is the executable statement; the static test checks
  // the manifest and source text.
  const tree = standaloneTree();

  // Documentation and a runnable example are part of "standalone library"
  // rather than an afterthought.
  for (const required of ['README.md', 'examples/attach_watch.rs']) {
    if (!fs.existsSync(path.join(crate, required))) {
      throw new Error('nession-tmux is missing ' + required);
    }
  }

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha +
        ': `cargo test -p nession-tmux` passed its in-memory wire, fake-process and real isolated-tmux tests with no Agent initialization',
    },
    {
      type: 'dependency',
      value:
        'the packaged dependency graph for nession-tmux names no nession-* crate; the manifest/source independence checks ran in the same test binary',
    },
    {
      type: 'test',
      value:
        'README.md and examples/attach_watch.rs are present and the example compiles as part of `cargo test -p nession-tmux`',
    },
  );
  return 'nession-tmux builds and tests as a standalone tmux library with no Nession crate, DTO or Agent initialization in its graph or source';
});
