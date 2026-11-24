#!/usr/bin/env node
/**
 * Prove that the canonical WebSocket route inventory in
 * `docs/architecture/websocket-runtime.md` covers exactly the wires each
 * runtime's route declaration actually serves.
 *
 * The source of truth for dispatch is the `server_routes!`, `core_routes!`
 * and `p2p_routes!` invocations. A markdown inventory that can drift from
 * them is worse than none, so this checker compares the two by parsing the
 * declarations themselves and the documented table. It does not re-derive a
 * semantic classification: the class column is provider-owned and reviewed
 * in the document; this script proves the inventory is *complete and exact*.
 *
 * Exit codes follow the Gate contract:
 *   0  inventory and declarations agree
 *   1  they disagree (a served wire is undocumented or a documented wire is
 *      not served, or a documented policy differs from the declaration)
 *   2  the inputs could not be read or parsed
 *
 * Usage:
 *   node scripts/websocket-route-inventory.mjs
 *   node scripts/websocket-route-inventory.mjs --self-test
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three declarations that own a served HTTP/WebSocket route table. */
export const SOURCES = {
  server: "crates/nession-server/src/server/handler/routes.rs",
  "agent-central": "crates/nession-agent/src/connection/server_client.rs",
  "agent-p2p": "crates/nession-agent/src/server/websocket.rs",
};

/**
 * How many `=>`-separated fields precede the execution policy.
 *
 * `server_routes!` and `core_routes!` are
 *   id => wire => version => policy => body
 * while `p2p_routes!` adds the access-scope column:
 *   id => wire => version => scope => policy => body
 */
const POLICY_FIELD = {
  server: 3,
  "agent-central": 3,
  "agent-p2p": 4,
};

const ARM = /^\s*"([a-z][a-z0-9.-]+)"\s*=>\s*"([a-z][a-z0-9.-]+)"\s*=>\s*(\d+)\s*=>/;

/** Extract `wire -> policy` arms from one runtime's declaration source. */
export function armsFromSource(runtime, text) {
  const field = POLICY_FIELD[runtime];
  if (field === undefined) throw new Error(`unknown runtime: ${runtime}`);
  const arms = new Map();
  const duplicates = [];
  for (const line of text.split("\n")) {
    const match = line.match(ARM);
    if (!match) continue;
    const [, id, wire] = match;
    // The synthetic versioned-routing fixture is a test-only table, not a
    // served route; the real declarations never use the `test.` namespace.
    if (wire.startsWith("test.")) continue;
    if (id !== wire) {
      throw new Error(
        `route arm names id '${id}' but wire '${wire}'; one wire is one id`,
      );
    }
    const parts = line.split("=>").map((part) => part.trim());
    const policy = parts[field];
    if (!policy) throw new Error(`no policy column for wire '${wire}'`);
    if (arms.has(wire)) duplicates.push(wire);
    arms.set(wire, policy);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `duplicate wire declaration(s): ${duplicates.join(", ")}`,
    );
  }
  return arms;
}

/** Extract the documented `wire -> policy` table for one runtime. */
export function armsFromDocument(runtime, text) {
  const begin = `<!-- websocket-route-inventory:${runtime} -->`;
  const end = `<!-- /websocket-route-inventory:${runtime} -->`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    throw new Error(`document has no inventory block for '${runtime}'`);
  }
  const rows = new Map();
  const duplicates = [];
  for (const raw of text.slice(start + begin.length, stop).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    // Skip the header and its separator.
    if (cells[0] === "wire" || /^-+$/.test(cells[0].replace(/:/g, ""))) continue;
    const wire = cells[0].replace(/`/g, "");
    const policy = cells[1].replace(/`/g, "");
    if (rows.has(wire)) duplicates.push(wire);
    rows.set(wire, policy);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `document repeats wire(s) for '${runtime}': ${duplicates.join(", ")}`,
    );
  }
  return rows;
}

/**
 * Compare one runtime's declaration with its documented inventory.
 *
 * Returns human-readable findings; an empty list is a pass.
 */
export function compare(runtime, declared, documented) {
  const findings = [];
  for (const [wire, policy] of declared) {
    if (!documented.has(wire)) {
      findings.push(`${runtime}: '${wire}' is served but not inventoried`);
    } else if (documented.get(wire) !== policy) {
      findings.push(
        `${runtime}: '${wire}' declares policy '${policy}' but the inventory says '${documented.get(wire)}'`,
      );
    }
  }
  for (const wire of documented.keys()) {
    if (!declared.has(wire)) {
      findings.push(
        `${runtime}: '${wire}' is inventoried but no route declaration serves it`,
      );
    }
  }
  return findings;
}

/**
 * Render one documented inventory block from the declaration it describes.
 *
 * `--write` uses this so the table is a projection of the route declaration
 * rather than a hand-transcribed copy. The checker still verifies the committed
 * document, so a stale table cannot pass.
 */
export function renderBlock(runtime, declared) {
  const rows = [...declared.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    `<!-- websocket-route-inventory:${runtime} -->`,
    "| wire | policy |",
    "| --- | --- |",
    ...rows.map(([wire, policy]) => `| \`${wire}\` | \`${policy}\` |`),
    `<!-- /websocket-route-inventory:${runtime} -->`,
  ];
  return lines.join("\n");
}

/** Rewrite the marked inventory blocks in the document from source. */
export function writeInventory(root = ROOT) {
  const docPath = resolve(root, "docs/architecture/websocket-runtime.md");
  let doc = readFileSync(docPath, "utf8");
  for (const [runtime, path] of Object.entries(SOURCES)) {
    const declared = armsFromSource(
      runtime,
      readFileSync(resolve(root, path), "utf8"),
    );
    const begin = `<!-- websocket-route-inventory:${runtime} -->`;
    const end = `<!-- /websocket-route-inventory:${runtime} -->`;
    const start = doc.indexOf(begin);
    const stop = doc.indexOf(end);
    if (start === -1 || stop === -1 || stop < start) {
      throw new Error(`document has no inventory block for '${runtime}'`);
    }
    doc =
      doc.slice(0, start) +
      renderBlock(runtime, declared) +
      doc.slice(stop + end.length);
  }
  writeFileSync(docPath, doc);
}

/** Run the checker against the repository inputs. */
export function check(root = ROOT) {
  const doc = readFileSync(
    resolve(root, "docs/architecture/websocket-runtime.md"),
    "utf8",
  );
  const findings = [];
  for (const [runtime, path] of Object.entries(SOURCES)) {
    const source = readFileSync(resolve(root, path), "utf8");
    findings.push(
      ...compare(
        runtime,
        armsFromSource(runtime, source),
        armsFromDocument(runtime, doc),
      ),
    );
  }
  return findings;
}

function selfTest() {
  const declared = new Map([
    ["a.one", "Query"],
    ["a.two", "Key(k)"],
  ]);
  const cases = [
    {
      name: "an undocumented served wire is a finding",
      documented: new Map([["a.one", "Query"]]),
      expect: 1,
    },
    {
      name: "an inventoried wire nobody serves is a finding",
      documented: new Map([
        ["a.one", "Query"],
        ["a.two", "Key(k)"],
        ["a.three", "Inline"],
      ]),
      expect: 1,
    },
    {
      name: "a policy disagreement is a finding",
      documented: new Map([
        ["a.one", "Inline"],
        ["a.two", "Key(k)"],
      ]),
      expect: 1,
    },
    {
      name: "an exact inventory passes",
      documented: new Map([
        ["a.one", "Query"],
        ["a.two", "Key(k)"],
      ]),
      expect: 0,
    },
  ];
  let failed = 0;
  for (const test of cases) {
    const findings = compare("fixture", declared, test.documented);
    const got = findings.length === 0 ? 0 : 1;
    if (got !== test.expect) {
      console.error(`FAIL self-test: ${test.name} (expected ${test.expect}, got ${got})`);
      failed += 1;
    } else {
      console.log(`ok self-test: ${test.name}`);
    }
  }

  // A synthetic declaration with a repeated wire must be refused rather than
  // silently keeping the last arm.
  const duplicate = `    "a.one" => "a.one" => 1 => Query => body\n    "a.one" => "a.one" => 1 => Inline => body\n`;
  try {
    armsFromSource("server", duplicate);
    console.error("FAIL self-test: a duplicate wire is refused");
    failed += 1;
  } catch {
    console.log("ok self-test: a duplicate wire is refused");
  }

  // A document with no inventory block must be an error, not an empty pass.
  try {
    armsFromDocument("server", "# no inventory here");
    console.error("FAIL self-test: a missing inventory block is refused");
    failed += 1;
  } catch {
    console.log("ok self-test: a missing inventory block is refused");
  }

  if (failed > 0) process.exit(1);
  console.log("websocket-route-inventory self-test: PASS");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else if (process.argv.includes("--write")) {
  try {
    writeInventory();
    console.log("websocket-route-inventory: wrote documented tables");
  } catch (error) {
    console.error(`websocket-route-inventory: ERROR ${error.message}`);
    process.exit(2);
  }
} else {
  try {
    const findings = check();
    if (findings.length > 0) {
      for (const finding of findings) console.error(`- ${finding}`);
      console.error(
        `websocket-route-inventory: FAIL (${findings.length} finding(s))`,
      );
      process.exit(1);
    }
    console.log("websocket-route-inventory: PASS");
  } catch (error) {
    console.error(`websocket-route-inventory: ERROR ${error.message}`);
    process.exit(2);
  }
}
