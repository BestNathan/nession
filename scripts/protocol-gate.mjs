#!/usr/bin/env node
//
// Static check: the protocols a call site names must be the protocols some
// runtime answers, and every protocol must have a caller.
//
// Why this is a gate rather than a code review habit: an unrecognised wire is
// *ignored*, not rejected. A sender that misspells one, or names one that was
// renamed and not carried through, gets no error and no reply — it waits. That
// is not a hypothetical: `agent.env.resource` had a sender and no receiver for
// however long it took a forced env write to be diagnosed as "the re-source
// reported a failure and the session kept the old values" (#913). The failure
// surfaces a long way from the typo, so the typo has to be caught here.
//
// Rules enforced:
//
//   1. Every wire a call site names is well formed, and some runtime answers
//      it. Two failure modes, reported apart because the fixes differ:
//        a. malformed — it does not satisfy `ProtocolId`'s grammar, so no
//           spelling of a real wire will match it (`extension.claude_code.read`
//           is the historical one: `_` is not a segment character).
//        b. unknown — well formed, but nothing in the advertised set matches.
//   2. Every advertised protocol is named by at least one call site. A unit
//      with no caller is a protocol this workspace maintains and cannot use.
//   3. The transitional `nession_common::protocol` alias path stays gone, and
//      the module that carried it does not come back.
//
// Scope is the *call sites*, not the tree. A scan over every dotted string
// literal was measured first and is unusable: it returns 378 distinct values,
// of which the overwhelming majority are filenames (`settings.json`), versions
// (`0.1.0`), addresses (`127.0.0.1`) and test names. Restricting to the
// arguments of the four functions that put a message on a wire keeps the check
// exact and needs no allowlist for ordinary strings.
//
// The advertised set is read from two places, and neither of them is a list
// kept here:
//
//   * `web/src/generated/protocol/**` — the generated bindings, which state
//     each unit's `PROTOCOL` and `WIRES`. `just check-codegen` is the gate that
//     keeps this tree equal to the contracts, so reading it is reading the
//     contracts.
//   * `pub const X: &str = "…"` in a file that also dispatches (`*_routes!`) —
//     the notification wires. Nothing answers them, so no route table lists
//     them, and the file that sends them declares them.
//
// There used to be a third source: `<wire>.response` for every wire, derived
// here because that was the spelling every reply carried. One wire per
// operation removed it (#953, Rule 1) — a reply now carries its request's own
// wire name and is correlated by the envelope's `id` — so there is nothing left
// to derive and deriving it would advertise names no runtime can answer.
//
// Usage:
//   ./scripts/protocol-gate.mjs          # check the tree
//   ./scripts/protocol-gate.mjs --list   # print the advertised set

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const GENERATED = 'web/src/generated/protocol';
const SKIP_DIRS = new Set(['.git', 'target', 'node_modules', '.claude', 'dist', '.playwright-mcp']);

const RED = '\u001b[0;31m';
const GREEN = '\u001b[0;32m';
const YELLOW = '\u001b[1;33m';
const NC = '\u001b[0m';

function fail(message) {
  console.error(`${RED}✗${NC} ${message}`);
  process.exit(1);
}

// ── The advertised set ──────────────────────────────────────────────────────

/** Every `web/src/generated/protocol/<owner>/<unit>/vN.ts`. */
function generatedFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) generatedFiles(p, out);
    else if (/^v\d+\.ts$/.test(name)) out.push(p);
  }
  return out;
}

function readGenerated() {
  const files = generatedFiles(join(ROOT, GENERATED));
  if (files.length === 0) {
    fail(
      `${GENERATED} has no bindings to read.\n` +
        `    The gate reads the generated tree as the list of what exists; run \`just codegen\`.`,
    );
  }
  const ids = new Set();
  const wires = new Set();
  // Where each unit's binding lives, so a consumer can be recognised as an
  // *import of the binding* rather than only as a hand-written wire.
  const bindingOf = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const id = /export const PROTOCOL = '([^']+)'/.exec(text);
    if (id) {
      ids.add(id[1]);
      // Relative to `web/src`, because an import reads `@/generated/…` and
      // carries neither the `web/src/` prefix nor the `vN.ts` suffix.
      bindingOf.set(
        id[1],
        relative(ROOT, file)
          .replace(/^web\/src\//, '')
          .replace(/\/v\d+\.ts$/, ''),
      );
    }
    const list = /export const WIRES = \[([^\]]*)\]/.exec(text);
    if (list) for (const w of list[1].matchAll(/'([^']+)'/g)) wires.add(w[1]);
  }
  return { ids, wires, bindingOf };
}

// Matched by prefix, not whole line: the macro is invoked as `p2p_routes! {`,
// and requiring the line to end after the `!` found no dispatcher at all — so
// every notification wire was read as undeclared.
const ROUTES = /^(core|p2p|server)_routes!/m;

/** Files that dispatch, and so own the wires they cannot be told about. */
function dispatchFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) dispatchFiles(p, out);
    else if (name.endsWith('.rs') && ROUTES.test(readFileSync(p, 'utf8'))) out.push(p);
  }
  return out;
}

/** The notification wires, declared next to the dispatcher that sends them. */
function notificationWires() {
  const found = new Map();
  for (const file of dispatchFiles(join(ROOT, 'crates'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/pub const ([A-Z_0-9]+): &str = "([^"]+)";/g)) {
      const [, name, wire] = m;
      if (wire.includes('.')) found.set(wire, `${relative(ROOT, file)}:${name}`);
    }
  }
  return found;
}

/**
 * Every `pub const NAME: &str = "wire";` in the tree, by const name.
 *
 * A call site naming `msg_types::AGENT_HEARTBEAT` is not a wire this gate can
 * read, but it is not a risk either — it is a *declared* wire, and the const is
 * the declaration. The first version of this gate treated every non-literal as
 * suspect and reported eighty of them, nearly all of this shape. Resolving the
 * name is what turns that noise back into a check: the name is looked up, and
 * the wire it resolves to has to be one a runtime answers.
 */
function declaredWireConsts() {
  const found = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.rs')) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/pub const ([A-Za-z_0-9]+): &str = "([^"]+)";/g)) {
          found.set(m[1], m[2]);
        }
      }
    }
  };
  walk(join(ROOT, 'crates'));
  return found;
}

const { ids, wires, bindingOf } = readGenerated();
const notifications = notificationWires();

/** Every string a call site may legitimately name. */
const advertised = new Set([...ids, ...wires]);
for (const w of notifications.keys()) advertised.add(w);

if (process.argv.includes('--list')) {
  const rows = [...advertised].sort();
  console.log(`${rows.length} advertised names (${ids.size} units)`);
  for (const r of rows) {
    const note = notifications.has(r) ? `  ← ${notifications.get(r)}` : '';
    console.log(`  ${r}${note}`);
  }
  process.exit(0);
}

// ── The grammar, transcribed from `ProtocolId::new` ─────────────────────────
//
// `crates/nession-protocol/src/kernel/identity.rs` is the definition; this is a
// copy of it, and the copy is the point — a call site's literal never passes
// through `ProtocolId::new`, so nothing else checks it.
const MAX_ID_LEN = 128;
const isSegmentChar = (c) => /[a-z0-9-]/.test(c);

function grammarError(id) {
  if (id === '') return 'empty';
  if (Buffer.byteLength(id) > MAX_ID_LEN) return `${Buffer.byteLength(id)} bytes, over the ${MAX_ID_LEN} ceiling`;
  const segments = id.split('.');
  for (const segment of segments) {
    if (segment === '') return `empty segment in \`${id}\``;
    if (segment.startsWith('-') || segment.endsWith('-')) return `segment \`${segment}\` starts or ends with \`-\``;
    for (const c of segment) {
      if (!isSegmentChar(c)) return `segment \`${segment}\` contains \`${c}\` (lowercase, digits and \`-\` only)`;
    }
  }
  if (segments.length < 2) return `\`${id}\` needs at least two segments`;
  return null;
}

// ── Call sites ──────────────────────────────────────────────────────────────
//
// Four functions put a protocol on a wire, and where the wire sits among their
// arguments differs. Everything else about them differs too, so the position is
// written out per function rather than inferred.
const CALLS = [
  { fn: 'proto_msg', arg: 0, lang: 'rs' },
  { fn: 'agent_command', arg: 1, lang: 'rs' },
  { fn: 'agent_command_with_timeout', arg: 1, lang: 'rs' },
  // The agent's own sender, which the first version of this gate did not know
  // about — so `agent.keepalive.ping` and the rest of the agent's outbound
  // units were all reported as having no caller.
  { fn: 'new_message', arg: 0, lang: 'rs' },
  { fn: 'request', arg: 0, lang: 'ts' },
  // Fire-and-forget: `server.session.relay.end` and `agent.keepalive.ping` are
  // sent, never answered, so they never went through `request` and the first
  // version of this gate called both of them dead.
  //
  // `sentPositions` marks the one argument here that is *not* a protocol by
  // position. `send` carries raw frames too — `ConnectionManager.send('hello')`
  // and `send('\x04')` are PTY bytes — so only a dotted literal is read as a
  // protocol name. Everywhere else the argument is a wire whatever it says, and
  // a literal with no dot is a malformed one worth reporting.
  { fn: 'send', arg: 0, lang: 'ts', wireOnlyIfDotted: true },
];

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(rs|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Split a call's arguments at top level, honouring strings and nesting. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    }
    if (c === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') args.push(current);
  return args;
}

/**
 * Blank out comments, keeping every offset and newline where it was.
 *
 * Without this the scan reads prose: a comment in `product/agent/state/probe.ts`
 * saying "forced re-probe request (AttachDialog …)" matched as a call to
 * `request` and was reported as an unnameable wire. Offsets are preserved so
 * the line numbers still point at the real source.
 */
function maskComments(text, lang) {
  const rs = lang === 'rs';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || (rs && c === '`')) {
      const quote = c;
      out += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The index of the `)` matching the `(` at `open`, or -1. */
function closeParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * A declaration rather than a call.
 *
 * Rust is caught by the `fn` before the name. TypeScript is not: `request(type:
 * string, payload: Record<string, unknown>)` reads as a call whose first
 * argument is `type: string`, and five definitions were reported that way. What
 * distinguishes them is what follows the closing paren — a call continues with
 * `;`, `.` or `,`, while a declaration continues with a return type or a body.
 */
function isDeclaration(text, open) {
  const close = closeParen(text, open);
  if (close < 0) return true; // unbalanced: not something to read as a call
  return /^\s*[:{]/.test(text.slice(close + 1));
}

const findings = [];
function report(file, line, rule, text, fix) {
  findings.push({ file, line, rule, text: text.trim(), fix });
}

/**
 * `// not-protocol: <reason>` on the line or in the three above it.
 *
 * The lookahead matters: `not-protocol-file` *contains* `not-protocol`, so a
 * plain substring test also honoured the file marker as a line marker — and a
 * marker written six lines down silently excused the call it sat near. Found by
 * the selftest case that puts a file marker below the header.
 */
function excused(lines, line) {
  const from = Math.max(0, line - 4);
  return lines.slice(from, line).some((l) => /not-protocol(?!-file)/.test(l));
}

const callers = new Map(); // advertised name -> first call site
const importedBindings = new Set(); // binding paths a consumer imports
const exemptFiles = []; // files declaring `not-protocol-file` in their header
const constWires = declaredWireConsts();
/** The generated identifiers this file imports — rebuilt per file. */
let tsWireImports = new Map();

function scanFile(file) {
  const rel = relative(ROOT, file);
  const lang = file.endsWith('.rs') ? 'rs' : 'ts';
  const lines = readFileSync(file, 'utf8').split('\n');
  const whole = maskComments(lines.join('\n'), lang);

  // A file whose *subject* is the transport deals in placeholder wires on
  // purpose: WebSocketService's tests assert on correlation, timeouts and
  // disposal, and name `agents.list` because the identity of the wire is
  // irrelevant to what they prove. Declaring that in the header is honest;
  // marking eleven call sites individually would be noise for the same fact.
  //
  // The header is deliberately the only place it is read, and every run prints
  // the files that carry it. That is the difference between this and a silent
  // path exemption: an exemption nobody sees is how a gate stops being one.
  // Note this covers rule 1 only — a declared-nowhere wire is still reported.
  const exempt = lines.slice(0, 5).some((l) => l.includes('not-protocol-file'));
  if (exempt) exemptFiles.push(rel);

  // A unit is consumed either by naming its wire at a call site or by importing
  // its generated binding. The second is the better of the two and is how every
  // capability plugin does it — `import { WIRE as BRANCHES_WIRE }` cannot drift
  // from the contract, because it is the contract's own output.
  for (const binding of bindingOf.values()) {
    if (whole.includes(`${binding}/`)) importedBindings.add(binding);
  }

  // `import { WIRE as BRANCHES_WIRE } from '@/generated/protocol/git/status/v1'`
  // — the identifier carries the contract's own output, so a call using it
  // cannot name a wire that does not exist.
  tsWireImports = new Map();
  for (const m of whole.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, names, spec] = m;
    const unit = [...bindingOf.entries()].find(([, path]) => spec.includes(`${path}/`));
    if (!unit) continue;
    for (const part of names.split(',')) {
      // The imported name and the local one differ when aliased —
      // `WIRE as BRANCHES_WIRE` — and it is the *imported* name that says this
      // is a wire. Reading the local one instead is why every capability plugin
      // was first reported as naming no declared wire.
      const [imported, alias] = part.trim().split(/\s+as\s+/);
      if (imported === 'WIRE' || imported === 'PROTOCOL') {
        tsWireImports.set((alias ?? imported).trim(), unit[0]);
      }
    }
  }

  for (const { fn, arg, lang: wanted, wireOnlyIfDotted } of CALLS) {
    if (wanted !== lang) continue;
    // `.agent_command(` is how every call site is written and `xproto_msg(`
    // is not a call, so a leading dot must be allowed and a word character
    // must not: excluding `.` here hid all ten `agent_command` sites. The
    // optional `<…>` is a call's type argument — `this.request<T>('wire')` —
    // which hid three more.
    const pattern = new RegExp(`(^|[^\\w])${fn}\\s*(?:<[^<>()]*>)?\\s*\\(`, 'gm');
    for (const m of whole.matchAll(pattern)) {
      const open = m.index + m[0].length - 1;
      const nameStart = m.index + m[0].indexOf(fn);
      const before = whole.slice(Math.max(0, nameStart - 12), nameStart);
      if (/\bfn\s+$/.test(before)) continue; // a Rust definition, not a call
      if (isDeclaration(whole, open)) continue;
      const inner = splitArgs(whole.slice(open + 1));
      const target = inner[arg];
      if (target === undefined) continue;
      const line = whole.slice(0, m.index).split('\n').length;
      // Excused from being *checked*, not from being a caller. Skipping the
      // site outright — which is what this did first — made every unit a
      // `not-protocol-file` file called look like a protocol nobody calls,
      // so the exemption produced a false accusation under rule 2.
      const unchecked = exempt || excused(lines, line);
      const literal = /^\s*["']([^"']*)["']\s*$/.exec(target);
      if (!literal) {
        if (unchecked) continue; // excused, and there is nothing here to count
        // Not a literal, so resolve the name instead of giving up on it.
        //
        // The two patterns that dominate here are both good ones: Rust names
        // `msg_types::AGENT_HEARTBEAT`, and the Web imports `WIRE as
        // BRANCHES_WIRE`. Neither can drift from the contract, and a gate that
        // demands a literal would be asking for the *worse* style. What is
        // worth reporting is a name that resolves to nothing — that is where a
        // misspelling hides, and it is the same class of mistake as a bad
        // literal.
        if (wireOnlyIfDotted) continue; // a computed frame payload, not a protocol
        const shown = target.trim().split('\n')[0].slice(0, 40);
        const ident = /&?\s*(?:[\w]+::)*([A-Za-z_][\w]*)\s*$/.exec(shown);
        const resolved = ident && lang === 'rs' ? constWires.get(ident[1]) : undefined;
        const imported = ident && lang === 'ts' && tsWireImports.get(ident[1]);
        if (resolved) {
          if (!advertised.has(resolved)) {
            report(rel, line, `\`${ident[1]}\` is declared as \`${resolved}\`, which no runtime answers (rule 1b)`,
              lines[line - 1] ?? '', 'the constant names a wire that does not exist — check it against `just protocol-schema`');
            continue;
          }
          if (!callers.has(resolved)) callers.set(resolved, `${rel}:${line}`);
          continue;
        }
        if (imported) {
          const id = imported;
          if (!callers.has(id)) callers.set(id, `${rel}:${line}`);
          continue;
        }
        report(rel, line, `\`${fn}\` is given \`${shown}\`, which names no declared wire`,
          lines[line - 1] ?? '', 'use a literal, a `pub const`, or an imported binding — or mark the line // not-protocol: <reason>');
        continue;
      }
      const wire = literal[1];
      if (wireOnlyIfDotted && !wire.includes('.')) continue;
      if (unchecked) {
        // Still a caller — see above. Only the finding is suppressed.
        if (advertised.has(wire) && !callers.has(wire)) callers.set(wire, `${rel}:${line}`);
        continue;
      }
      const malformed = grammarError(wire);
      if (malformed) {
        report(rel, line, `malformed protocol name (rule 1a): ${malformed}`, lines[line - 1] ?? '',
          'spell it the way `ProtocolId` will accept it — lowercase, digits and `-` between dots');
        continue;
      }
      if (!advertised.has(wire)) {
        report(rel, line, `no runtime answers \`${wire}\` (rule 1b)`, lines[line - 1] ?? '',
          'check the wire against `just protocol-schema` — nothing will reply to this');
        continue;
      }
      if (!callers.has(wire)) callers.set(wire, `${rel}:${line}`);
    }
  }
}

for (const file of sourceFiles(join(ROOT, 'crates'))) scanFile(file);
for (const file of sourceFiles(join(ROOT, 'web', 'src'))) {
  if (relative(ROOT, file).startsWith(GENERATED)) continue;
  scanFile(file);
}

// ── Rule 2: a protocol nothing calls ────────────────────────────────────────
for (const id of [...ids].sort()) {
  if (callers.has(id)) continue;
  if (importedBindings.has(bindingOf.get(id))) continue;
  report(GENERATED, 0, `\`${id}\` has no caller (rule 2)`, '',
    'either something should be using it, or it is dead and should go');
}

// ── Rule 3: the transitional alias path stays gone ──────────────────────────
//
// `nession_common::protocol` was the #678 Phase 1 shim: it re-exported the
// kernel's contracts flatly, so a caller could not say which family or version
// it meant — the question the whole Protocol Unit model exists to answer. It is
// deleted, and `nession_protocol::contracts::<family>::vN` is the only spelling.
//
// Rust already refuses a use of it while the module is absent, which is the
// stronger guard. What the compiler cannot see is the module coming *back* —
// restore `pub mod protocol;` and the re-exports, and every old import compiles
// again. That is the regression this checks.
const SHIM = 'crates/nession-common/src/protocol.rs';
if (existsSync(join(ROOT, SHIM))) {
  report(SHIM, 0, 'the transitional alias module is back (rule 3)', '',
    'nession_protocol::contracts::<family>::vN is the only spelling — a flat re-export cannot say which version a caller resolved');
}
for (const file of sourceFiles(join(ROOT, 'crates'))) {
  if (!file.endsWith('.rs')) continue;
  const text = maskComments(readFileSync(file, 'utf8'), 'rs');
  for (const m of text.matchAll(/nession_common::protocol/g)) {
    report(relative(ROOT, file), text.slice(0, m.index).split('\n').length,
      'the transitional alias path (rule 3)', '',
      'name the family and version: nession_protocol::contracts::<family>::vN');
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
/** Printed either way: an exemption nobody sees is how a gate stops being one. */
function printExempt() {
  if (exemptFiles.length === 0) return;
  console.log(`${YELLOW}${exemptFiles.length} file(s) declare \`not-protocol-file\`:${NC}`);
  for (const f of exemptFiles.sort()) console.log(`  ${f}`);
  console.log('');
}

if (findings.length === 0) {
  console.log(`${GREEN}protocol gate OK ✓${NC}  ${ids.size} units, ${advertised.size} names`);
  printExempt();
  process.exit(0);
}
for (const f of findings) {
  console.log(`${RED}✗${NC} ${f.line ? `${f.file}:${f.line}` : f.file}`);
  console.log(`    ${YELLOW}${f.rule}${NC}`);
  if (f.text) console.log(`    ${f.text}`);
  console.log(`    ${GREEN}fix:${NC} ${f.fix}`);
  console.log('');
}
printExempt();
console.log(`${RED}${findings.length} protocol violation(s)${NC}`);
console.log(`${YELLOW}An unrecognised wire is ignored, not rejected — the sender waits forever.
See "Protocol identity" in docs/architecture/protocol.md.${NC}`);
process.exit(1);
