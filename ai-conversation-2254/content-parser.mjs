// Text-only content parser for the #2254 design prototype.
// No provider wire types, DOM, network, or business mutations.
const TICK = String.fromCharCode(96);
export const KNOWN_COMPONENTS = new Set(["agent.list", "agent.detail", "session.list", "session.detail", "session.create.form", "git.changes", "git.diff"]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, allowed) { return Object.keys(value).every(key => allowed.includes(key)); }

export function validateEnvelope(value) {
  if (!object(value)) return "Directive must be a JSON object";
  if (value.v !== 1) return "Unsupported protocol version (expected v: 1)";
  if (value.op === "render") {
    if (!exactKeys(value, ["v", "op", "component", "input"])) return "Unexpected render field";
    if (value.input !== undefined && !object(value.input)) return "input must be an object";
  } else if (value.op === "reference") {
    if (!exactKeys(value, ["v", "op", "component", "ref", "context"])) return "Unexpected reference field";
    if (typeof value.ref !== "string" || !value.ref.trim() || value.ref.length > 128) return "Invalid instance ref";
    if (value.context !== undefined && !object(value.context)) return "context must be an object";
  } else return "Unsupported operation";
  if (typeof value.component !== "string" || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(value.component)) return "Invalid component ID";
  return null;
}

function fence(line) {
  const value = line.replace(/\r?\n$/, "");
  const indentation = /^ */.exec(value)[0].length;
  if (indentation > 3) return null;
  const s = value.slice(indentation);
  const mark = s[0];
  if (mark !== TICK && mark !== "~") return null;
  let i = 0;
  while (s[i] === mark) i++;
  if (i < 3) return null;
  return {mark, length: i, info: s.slice(i).trim()};
}
function closing(line, opened) {
  const f = fence(line);
  return f && f.mark === opened.mark && f.length >= opened.length && f.info === "";
}
function linesOf(source) {
  const result = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") { result.push({start, end: i + 1, line: source.slice(start, i + 1)}); start = i + 1; }
  }
  if (start < source.length) result.push({start, end: source.length, line: source.slice(start)});
  return result;
}
export function parseText(source, settled = true) {
  const chunks = linesOf(source);
  const segments = [];
  let plainStart = 0;
  let code = null;
  let directive = null;
  function flush(end) { if (end > plainStart) segments.push({kind: "text", key: "text:" + plainStart, text: source.slice(plainStart, end)}); }
  for (const row of chunks) {
    if (directive) {
      if (!closing(row.line, directive.fence)) continue;
      const raw = source.slice(directive.start, row.end);
      const jsonText = source.slice(directive.bodyStart, row.start).trim();
      let parsed = null, error = null;
      if (jsonText.length > 8192) error = "Directive exceeds the 8 KB limit";
      else {
        try { parsed = JSON.parse(jsonText); } catch (_) { error = "Invalid JSON"; }
        if (!error) error = validateEnvelope(parsed);
      }
      segments.push(error
        ? {kind: "error", key: "ui:" + directive.start, raw, error}
        : {kind: "component", key: "ui:" + directive.start, raw, value: parsed});
      directive = null;
      plainStart = row.end;
      continue;
    }
    const f = fence(row.line);
    if (code) {
      if (closing(row.line, code)) code = null;
      continue;
    }
    if (!f) continue;
    if (f.info === "nession-ui") {
      flush(row.start);
      directive = {start: row.start, bodyStart: row.end, fence: f};
      continue;
    }
    code = f;
  }
  if (directive) {
    const raw = source.slice(directive.start);
    if (settled) segments.push({kind: "error", key: "ui:" + directive.start, raw, error: "Unclosed nession-ui fence"});
    else segments.push({kind: "pending", key: "ui:" + directive.start, raw});
    plainStart = source.length;
  }
  flush(source.length);
  return segments;
}
export function directiveText(value) {
  const error = validateEnvelope(value);
  if (error) throw new Error(error);
  const fence = TICK.repeat(3);
  return fence + "nession-ui\n" + JSON.stringify(value, null, 2) + "\n" + fence;
}
export function referenceText(instance, context) {
  return directiveText({v: 1, op: "reference", component: instance.component, ref: instance.ref, context});
}
