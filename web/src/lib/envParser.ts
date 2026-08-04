export interface ParsedEnv {
  vars: [string, string][];
  warnings: string[];
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

// Resolve a backslash escape in a double-quoted value. `next` is the
// character following the backslash; an unknown escape is kept literally and
// a trailing backslash is preserved.
function resolveEscape(next: string | undefined): string {
  if (next === undefined) {
    return '\\';
  }
  switch (next) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '\\': return '\\';
    case '"': return '"';
    default: return `\\${next}`;
  }
}

// Parse a quoted value (everything after the opening quote). Returns null
// when the quote is unterminated so the caller can fall back to unquoted
// handling rather than silently dropping data.
function parseQuoted(trimmed: string): string | null {
  const quote = trimmed.charAt(0);
  let out = '';
  for (let i = 1; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (quote === '"' && c === '\\') {
      out += resolveEscape(trimmed[i + 1]);
      i++;
      continue;
    }
    if (c === quote) {
      return out;
    }
    out += c;
  }
  return null;
}

function parseValue(raw: string): string {
  const trimmed = raw.trimStart();
  const first = trimmed.charAt(0);

  if (first === '"' || first === "'") {
    const quoted = parseQuoted(trimmed);
    if (quoted !== null) {
      return quoted;
    }
  }

  // Unquoted: strip trailing comment after whitespace-prefixed #.
  let end = trimmed.length;
  let prevWs = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '#' && prevWs) {
      end = i;
      break;
    }
    prevWs = c === ' ' || c === '\t';
  }
  return trimmed.slice(0, end).trimEnd();
}

export function parseEnv(content: string): ParsedEnv {
  const vars: [string, string][] = [];
  const index = new Map<string, number>();
  const warnings: string[] = [];

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      warnings.push(`line ${i + 1}: missing '=', skipped: ${trimmed}`);
      continue;
    }

    const keyPart = line.slice(0, eqIdx);
    const valuePart = line.slice(eqIdx + 1);

    let key = keyPart.trim();
    if (key.startsWith('export ')) {
      key = key.slice(7).trim();
    }

    if (!isValidKey(key)) {
      warnings.push(`line ${i + 1}: invalid key '${key}', skipped`);
      continue;
    }

    const value = parseValue(valuePart);
    const existing = index.get(key);
    if (existing !== undefined) {
      vars[existing][1] = value;
    } else {
      index.set(key, vars.length);
      vars.push([key, value]);
    }
  }

  return { vars, warnings };
}
