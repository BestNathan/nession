'use strict';
// #2598 SC-01: a real private-socket tmux comparison proves the OSC 52/5522
// directions Nession relies on, for both attach transports, with the exact
// server settings this release ships. The terminal-emulator half (DECRQM/DECRPM,
// mode enable, MIME events, replies) is proven by the browser Cases; this one
// isolates what tmux itself carries.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const CONFIG_SETTINGS = [
  'set -g set-clipboard external',
  "set -as terminal-features ',*:clipboard'",
];

function shell(script, timeout = 40000) {
  const result = spawnSync('sh', ['-c', script], {
    timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) { throw result.error; }
  return {
    status: result.status,
    output: String(result.stdout || '') + '\n' + String(result.stderr || ''),
  };
}

/** tmux control mode escapes bytes as octal `\NNN` and `\\`. */
function unescapeControlMode(value) {
  return value.replace(/\\([0-7]{3}|\\)/g, (match, code) => (
    code === '\\' ? '\\' : String.fromCharCode(Number.parseInt(code, 8))
  ));
}

const PRINT_BOTH =
  "printf '\\033]52;c;Zm9vYmFy\\033\\\\'; printf '\\033]5522;type=read;Lg==\\033\\\\'";

function serverScript(dir, name, body) {
  const socket = path.join(dir, name + '.sock');
  const config = path.join(dir, name + '.conf');
  fs.writeFileSync(config, 'set -g history-limit 5000\n' + CONFIG_SETTINGS.join('\n') + '\n');
  return `set -e
# The product pins the tmux client's terminal (crates/nession-tmux/src/process.rs):
# a CI runner inherits TERM=dumb or nothing, and the client then dies with
# "terminal does not support clear" before any protocol byte can be observed.
export TERM=xterm-256color
sock=${JSON.stringify(socket)}
conf=${JSON.stringify(config)}
${body}
tmux -S "$sock" kill-server 2>/dev/null || true`;
}

function probeControlOutput(dir, evidence) {
  const out = path.join(dir, 'control.out');
  const fifo = path.join(dir, 'control.in');
  const script = serverScript(dir, 'control', `
rm -f ${JSON.stringify(out)} ${JSON.stringify(fifo)}
mkfifo ${JSON.stringify(fifo)}
tmux -S "$sock" -f "$conf" new-session -d -s probe sh
tmux -S "$sock" -C attach -t probe < ${JSON.stringify(fifo)} > ${JSON.stringify(out)} 2>&1 &
attach_pid=$!
exec 3> ${JSON.stringify(fifo)}
sleep 1
tmux -S "$sock" send-keys -t probe ${JSON.stringify(PRINT_BOTH)} Enter
sleep 2
exec 3>&-
wait "$attach_pid" || true
`);
  const { status, output } = shell(script);
  if (status !== 0) { throw new Error('control-mode probe failed: ' + output.slice(-2000)); }
  const captured = unescapeControlMode(fs.readFileSync(out, 'utf8'));
  if (!captured.includes('\x1b]52;c;Zm9vYmFy\x1b\\')) {
    throw new Error('tmux -C did not carry OSC 52 byte-exactly: ' + JSON.stringify(captured.slice(-600)));
  }
  if (!captured.includes('\x1b]5522;type=read;Lg==\x1b\\')) {
    throw new Error('tmux -C did not carry OSC 5522 byte-exactly: ' + JSON.stringify(captured.slice(-600)));
  }
  evidence.push({
    type: 'tmux',
    value: 'tmux -C %output carried OSC 52 and OSC 5522 byte-exactly ' +
      '(ESC ]52;c;Zm9vYmFy ESC \\ and ESC ]5522;type=read;Lg== ESC \\)',
  });
}

function probeControlInput(dir, evidence) {
  const reader = path.join(dir, 'reader.js');
  fs.writeFileSync(reader, [
    'process.stdin.setRawMode(true);',
    'const seen = [];',
    "process.stdin.on('data', (chunk) => { for (const byte of chunk) seen.push(byte); });",
    'setTimeout(() => {',
    "  process.stdout.write('READER:' + Buffer.from(seen).toString('hex') + '\\n');",
    '  process.exit(0);',
    '}, 4000);',
  ].join('\n'));
  const out = path.join(dir, 'input.out');
  const fifo = path.join(dir, 'input.in');
  const script = serverScript(dir, 'input', `
rm -f ${JSON.stringify(out)} ${JSON.stringify(fifo)}
mkfifo ${JSON.stringify(fifo)}
tmux -S "$sock" -f "$conf" new-session -d -s probe sh
tmux -S "$sock" -C attach -t probe < ${JSON.stringify(fifo)} > ${JSON.stringify(out)} 2>&1 &
attach_pid=$!
exec 3> ${JSON.stringify(fifo)}
sleep 1
tmux -S "$sock" send-keys -t probe "node ${reader}" Enter
sleep 1
tmux -S "$sock" send-keys -t probe -H 1b 5d 35 35 32 32 3b 74 79 70 65 3d 72 65 61 64 3b 51 51 3d 3d
sleep 5
exec 3>&-
wait "$attach_pid" || true
`);
  const { status, output } = shell(script);
  if (status !== 0) { throw new Error('control-mode input probe failed: ' + output.slice(-2000)); }
  const captured = unescapeControlMode(fs.readFileSync(out, 'utf8'));
  const match = /READER:([0-9a-f]+)/.exec(captured);
  const expected = Buffer.from('\x1b]5522;type=read;QQ==', 'utf8').toString('hex');
  if (!match || !match[1].startsWith(expected)) {
    throw new Error('the pane did not receive the OSC 5522 reply bytes byte-exactly: ' +
      JSON.stringify(captured.slice(-500)));
  }
  evidence.push({
    type: 'tmux',
    value: 'tmux -C send-keys -H delivered OSC 5522 reply bytes to a raw pane reader: ' +
      match[1].slice(0, 40),
  });
}

function probePlainAttach(dir, evidence) {
  const out = path.join(dir, 'plain.out');
  const platform = process.platform;
  const attach = platform === 'darwin'
    ? `script -q /dev/null tmux -S "$sock" attach -t probe`
    : `script -q -c "tmux -S $SOCK_PLACEHOLDER attach -t probe" /dev/null`;
  const script = serverScript(dir, 'plain', `
rm -f ${JSON.stringify(out)}
tmux -S "$sock" -f "$conf" new-session -d -s probe sh
(
  sleep 2
  tmux -S "$sock" send-keys -t probe ${JSON.stringify(PRINT_BOTH)} Enter
  sleep 3
) | perl -e 'alarm 9; exec @ARGV' ${attach.replace('$SOCK_PLACEHOLDER', '$sock')} > ${JSON.stringify(out)} 2>&1 || true
`);
  const { output } = shell(script);
  const captured = fs.readFileSync(out, 'utf8');
  if (!captured.includes(']52;c;Zm9vYmFy')) {
    throw new Error('plain attach did not forward OSC 52 to the outer terminal; ' +
      'probe output: ' + output.slice(-600) + '; outer terminal: ' + captured.slice(-600));
  }
  if (!captured.includes(']5522;type=read;Lg==')) {
    throw new Error('plain attach did not forward OSC 5522 to the outer terminal: ' +
      JSON.stringify(captured.slice(-600)));
  }
  evidence.push({
    type: 'tmux',
    value: 'plain tmux attach (script PTY, TERM pinned as process.rs does) forwarded OSC 52 and ' +
      'OSC 5522 to the outer terminal with the shipped set-clipboard external + clipboard ' +
      'terminal feature',
  });
}

run(({ evidence }) => {
  const sha = targetSha();
  const source = fs.readFileSync(
    path.join(__dirname, '../../../../../crates/nession-agent/src/tmux/cmd.rs'),
    'utf8',
  );
  for (const setting of CONFIG_SETTINGS) {
    if (!source.includes(setting)) {
      throw new Error('the shipped tmux server config is missing ' + setting);
    }
  }
  const processSource = fs.readFileSync(
    path.join(__dirname, '../../../../../crates/nession-tmux/src/process.rs'),
    'utf8',
  );
  if (!processSource.includes('cmd.env("TERM", "xterm-256color")')) {
    throw new Error('the tmux client no longer pins TERM for plain PTY attach');
  }
  const version = String(spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-clipboard-'));
  probeControlOutput(dir, evidence);
  probeControlInput(dir, evidence);
  probePlainAttach(dir, evidence);
  evidence.push({
    type: 'source',
    value: 'exact SHA ' + sha + ': server config sets set-clipboard external and ' +
      "terminal-features ',*:clipboard'; " + version,
  });
  return 'tmux control mode carries OSC 52/5522 in both directions and plain attach ' +
    'forwards both with the shipped clipboard settings';
});
