import type { Element, ElementContent } from 'hast';
import type { Literal } from 'mdast';

/**
 * TOML frontmatter node.
 *
 * `@types/mdast` registers `yaml` but leaves `toml` to the consumer — its own
 * docs show this augmentation as the intended way to declare it. Without it,
 * `toml` is not a valid key in the to-hast handler record.
 */
export interface Toml extends Literal {
  type: 'toml';
}

declare module 'mdast' {
  interface FrontmatterContentMap {
    toml: Toml;
  }
  interface RootContentMap {
    toml: Toml;
  }
}

/**
 * Renders a YAML/TOML frontmatter block as a key/value table in the preview.
 *
 * `mdast-util-to-hast` maps `yaml` and `toml` nodes to its `ignore` handler, so
 * frontmatter never reaches the rendered output on its own. `ignore` returns
 * before `applyData` runs, which rules out the usual `data.hName` escape hatch —
 * the only way to render these nodes is to replace the handler, which
 * react-markdown allows through `remarkRehypeOptions.handlers`.
 *
 * The parser here is deliberately line-based rather than a real YAML/TOML
 * implementation: this table is for *display*, and pulling in a full parser to
 * show a few metadata keys would be a poor trade. It reads top-level keys and,
 * for a key whose value continues on indented lines, shows those lines verbatim
 * rather than inventing a structure it did not parse.
 */

/** One row of the frontmatter table. */
export interface FrontmatterEntry {
  key: string;
  value: string;
}

export type FrontmatterFlavor = 'yaml' | 'toml';

/** `key: value` (YAML) — the key must be unindented to count as top-level. */
const YAML_ENTRY = /^([A-Za-z0-9_.$-]+)[ \t]*:[ \t]*(.*)$/;

/** `key = value` (TOML). */
const TOML_ENTRY = /^([A-Za-z0-9_.$-]+)[ \t]*=[ \t]*(.*)$/;

/** `[section]` / `[[array]]` (TOML) — scopes the keys that follow. */
const TOML_SECTION = /^\[{1,2}([^\]]+)\]{1,2}[ \t]*$/;

/** A continuation line belonging to the previous key (indented, or a `- ` item). */
function isContinuation(line: string): boolean {
  return /^[ \t]+\S/.test(line);
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

/**
 * Extract display rows from a raw frontmatter block.
 *
 * Returns an empty array when nothing recognisable is found, which callers treat
 * as "render nothing" rather than "render an empty table".
 */
export function parseFrontmatterEntries(
  source: string,
  flavor: FrontmatterFlavor,
): FrontmatterEntry[] {
  const entryPattern = flavor === 'toml' ? TOML_ENTRY : YAML_ENTRY;
  const lines = source.split(/\r?\n/);
  const entries: FrontmatterEntry[] = [];
  let section = '';

  for (const line of lines) {
    if (isSkippable(line)) {
      continue;
    }

    // Indented content belongs to the key above it. Append it verbatim so a
    // nested list or map is shown as written instead of silently dropped.
    if (isContinuation(line)) {
      const last = entries[entries.length - 1];
      if (last) {
        const piece = line.trim();
        last.value = last.value.length > 0 ? `${last.value} ${piece}` : piece;
      }
      continue;
    }

    if (flavor === 'toml') {
      const sectionMatch = TOML_SECTION.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1].trim();
        continue;
      }
    }

    const match = entryPattern.exec(line);
    if (match) {
      const key = section ? `${section}.${match[1]}` : match[1];
      entries.push({ key, value: match[2].trim() });
    }
  }

  return entries;
}

function textCell(tagName: 'th' | 'td', value: string, isKey: boolean): Element {
  const children: ElementContent[] = value.length > 0
    ? [{ type: 'text', value }]
    : [];
  return {
    type: 'element',
    tagName,
    properties: isKey ? { scope: 'row' } : {},
    children,
  };
}

/**
 * Class that styles the frontmatter panel, defined in `index.css`.
 *
 * The sanitize schema allows `className` on `<table>` only when it is exactly
 * this string, so a document cannot borrow the styling — or any other class —
 * by writing raw `<table class="...">`. See `markdownSanitizeSchema`.
 */
export const FRONTMATTER_TABLE_CLASS = 'nession-frontmatter';

/** Label shown above the keys, so the block reads as metadata rather than content. */
const FRONTMATTER_CAPTION = 'Frontmatter';

/**
 * Build the hast table for a frontmatter block.
 *
 * Keys become `<th scope="row">` so screen readers announce each row's key as
 * its header, and a `<caption>` names the block. Styling comes from
 * FRONTMATTER_TABLE_CLASS rather than the prose table rules — metadata should
 * not look like one of the document's own tables.
 *
 * Returns `undefined` when there is nothing to show, which
 * `mdast-util-to-hast` treats the same way it treated `ignore`.
 */
export function frontmatterToHast(
  source: string,
  flavor: FrontmatterFlavor,
): Element | undefined {
  const entries = parseFrontmatterEntries(source, flavor);
  if (entries.length === 0) {
    return undefined;
  }

  const rows: ElementContent[] = entries.map((entry) => ({
    type: 'element',
    tagName: 'tr',
    properties: {},
    children: [
      textCell('th', entry.key, true),
      textCell('td', entry.value, false),
    ],
  }));

  return {
    type: 'element',
    tagName: 'table',
    properties: { className: [FRONTMATTER_TABLE_CLASS] },
    children: [
      {
        type: 'element',
        tagName: 'caption',
        properties: {},
        children: [{ type: 'text', value: FRONTMATTER_CAPTION }],
      },
      {
        type: 'element',
        tagName: 'tbody',
        properties: {},
        children: rows,
      },
    ],
  };
}
