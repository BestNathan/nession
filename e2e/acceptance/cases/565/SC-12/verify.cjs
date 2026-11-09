'use strict';
// #565 SC-12: the repository Rust checks pass at the exact SHA, and the three
// hosting modes have current documentation with configuration examples.
const { run, targetSha, checked, crateTests, assertRan, read } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('cargo', ['fmt', '--all', '--check'], 300000);
  checked('./gates/run', ['rust-clippy'], 1800000);
  const lib = crateTests('nession-mcp', ['--lib'], 600000);
  assertRan(lib, [
    'service::tests::initialize_creates_a_session_and_tools_list_uses_it',
    'http::tests::a_websocket_upgrade_replays_the_head',
  ]);

  const doc = read('docs/architecture/mcp.md');
  for (const needle of [
    '### Standalone',
    '### Server embedded',
    '### Agent embedded',
    '[backend.server]',
    '[backend.agent]',
    'server_auth_token = "<server-token>"',
    'agent_token = "<agent-token>"',
    'listen_address = "127.0.0.1:9090"',
  ]) {
    if (!doc.includes(needle)) throw new Error('docs/architecture/mcp.md is missing ' + needle);
  }
  evidence.push(
    { type: 'runtime', value: 'rustfmt --check and the rust-clippy Gate passed at ' + sha },
    {
      type: 'runtime',
      value: 'docs/architecture/mcp.md documents Standalone, Server embedded and Agent embedded with configuration examples',
    },
  );
  return 'Repository Rust checks/tests pass and the three hosting modes are documented with configuration examples';
});
