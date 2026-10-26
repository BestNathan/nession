'use strict';
// #2469 SC-01: nession-tmux is a standalone, Nession-independent Rust library.
//
// This Case proves the slice-1 part of the criterion at the exact merged
// staging SHA: the crate's own dependency graph, source and manifest name no
// Nession crate, and its tests run without Agent initialization — the
// in-memory wire tests, a self-contained fake process, and a real isolated tmux
// server on a private socket. It also packages the crate and builds a consumer
// outside the workspace against the packaged copy, so "standalone library" is
// proven by a build rather than by reading the manifest.
const fs = require('node:fs');
const os = require('node:os');
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

  // Package the crate and build a consumer outside the workspace. The consumer
  // depends on the extracted `.crate`, not on the workspace path, so a
  // dependency or path that only resolves inside the repo fails here.
  checked('cargo', ['package', '-p', 'nession-tmux', '--allow-dirty', '--no-verify'], 300000);
  const packed = path.join(root, 'target/package/nession-tmux-0.1.0.crate');
  if (!fs.existsSync(packed)) {
    throw new Error('cargo package produced no nession-tmux crate');
  }
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-tmux-consumer.'));
  const unpacked = path.join(consumer, 'unpacked');
  fs.mkdirSync(unpacked);
  checked('tar', ['-xzf', packed, '-C', unpacked], 60000);
  const manifest = path.join(consumer, 'consumer', 'Cargo.toml');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.mkdirSync(path.join(consumer, 'consumer', 'src'), { recursive: true });
  fs.writeFileSync(manifest, [
    '[package]',
    'name = "nession-tmux-consumer"',
    'version = "0.0.0"',
    'edition = "2021"',
    '',
    '[dependencies]',
    'nession-tmux = { path = "' + path.join(unpacked, 'nession-tmux-0.1.0') + '" }',
    '',
  ].join('\n'));
  fs.writeFileSync(
    path.join(consumer, 'consumer', 'src', 'main.rs'),
    'fn main() {\n' +
    '    // A consumer supplies its own binary and absolute socket; the crate\n' +
    '    // has no default for either.\n' +
    '    let command = nession_tmux::TmuxCommand::new("tmux", "/tmp/consumer.sock");\n' +
    '    let _ops = nession_tmux::TmuxOps::new(command);\n' +
    '}\n',
  );
  checked(
    'cargo',
    ['check', '--manifest-path', manifest],
    300000,
    { CARGO_TARGET_DIR: path.join(consumer, 'target') },
  );

  // The public API documentation must build with warnings denied; broken
  // intra-doc links to Agent-only items are exactly the stale-owner failure
  // this catches.
  checked(
    'cargo',
    ['doc', '-p', 'nession-tmux', '--no-deps'],
    300000,
    { RUSTDOCFLAGS: '-D warnings' },
  );

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
    {
      type: 'build',
      value:
        'cargo package produced nession-tmux-0.1.0.crate and a consumer crate outside the workspace, depending on the extracted package, built TmuxCommand + TmuxOps with its own binary and absolute socket',
    },
    {
      type: 'static',
      value:
        'the public API documentation built with RUSTDOCFLAGS=-D warnings, so no intra-doc link points at an Agent-only or private owner',
    },
  );
  return 'nession-tmux packages and builds for an external consumer, with no Nession crate, DTO or Agent initialization in its graph or source';
});
