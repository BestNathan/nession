/**
 * ESLint rule: no-deep-capability-imports
 *
 * A capability's public API is its `index.ts`. Code outside the capability
 * reaches it through `@/capabilities/<name>`, never through
 * `@/capabilities/<name>/components/FileViewer`.
 *
 * ── Why this is a boundary and not a style preference ───────────────────────
 *
 * #801 defines a capability as a **vertical slice**: one directory owning its
 * transport, the state it derives, and how it draws itself. That definition is
 * only true if the slice can move its own files. A deep import makes every
 * internal path a public one — the capability can no longer split a component,
 * rename a `model/` module, or move `hooks/` without editing call sites in
 * `app/`, `product/` and `platform/`. The "vertical slice" then describes the
 * folder, not the ownership.
 *
 * Measured before this rule existed: 13 such imports, from `app/experiences/*`
 * (files, env), `product/session/components/*` (env) and
 * `product/terminal/capsule/*` (commands) — every one of them reaching past the
 * capability's own index into `components/` or `hooks/`. All 13 now go through
 * the index, and the three indexes grew the exports that made that possible.
 * This rule is what keeps the count at zero; without it the next feature that
 * needs a capability component reaches for the deep path again, because nothing
 * says no.
 *
 * ── What is in scope ────────────────────────────────────────────────────────
 *
 * Both spellings, for the reason `no-reverse-imports` records: `@/capabilities/
 * files/components/FileViewer` and a relative `../../capabilities/files/
 * components/FileViewer` are the same edge, and covering only the alias leaves
 * the same hole with a different spelling.
 *
 * Importing the capability **root** (`@/capabilities/files`) is the point of the
 * rule and is always allowed. So is anything from inside the capability itself —
 * `capabilities/env/components/EnvManager.tsx` importing
 * `@/capabilities/env/model/envRef` is an internal detail, not a cross-import.
 *
 * Test files are exempt, matching `no-reverse-imports` and
 * `no-capsule-magic-metrics`: a test wiring a capability's internals to assert
 * on them is doing its job, and tests are not shipped.
 *
 * ── Why type imports are in scope here but not in `no-reverse-imports` ───────
 *
 * That rule polices **runtime edges**, so an erased `import type` is none of
 * its business. This one polices a capability's **public surface**, and a type
 * is part of that surface: if `app/` reads `FileEntry` from
 * `@/capabilities/files/types`, the capability cannot move or split
 * `types.ts` — which is the whole property being protected. It is not a
 * hypothetical: 2 of the 13 imports this rule was written for were exactly that
 * shape, in the root `types.ts` barrel. Do not "fix" the asymmetry by exempting
 * types here.
 */

const CAPABILITIES = '/capabilities/';

/** `src/…`-relative form, so both a resolved relative path and an alias agree. */
function fromSrc(filename) {
  const parts = filename.replace(/\\/g, '/').split('/');
  const i = parts.lastIndexOf('src');
  return i === -1 ? parts.join('/') : parts.slice(i).join('/');
}

function isTestFile(normalized) {
  return (
    normalized.includes('/__tests__/') ||
    /\.(test|spec)\.[tj]sx?$/.test(normalized)
  );
}

/** The capability a file lives in, or null — `capabilities/<name>/…` -> `<name>`. */
function ownerOf(normalized) {
  const m = normalized.match(/^src\/capabilities\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Resolve a specifier to a `src/…` path, or null when it is not this rule's
 * business. Handles the `@/` alias and relative specifiers; bare package names
 * are left alone.
 */
function resolveSpecifier(spec, filename) {
  if (spec.startsWith('@/')) {
    return 'src/' + spec.slice(2);
  }
  if (!spec.startsWith('.')) {
    return null;
  }
  const base = filename.replace(/\\/g, '/').split('/').slice(0, -1);
  const out = [...base];
  for (const segment of spec.split('/')) {
    if (segment === '.' || segment === '') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  const i = joined.indexOf('src/');
  return i === -1 ? null : joined.slice(i);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A capability is reached through its index, not through its internals",
    },
    schema: [],
    messages: {
      violation: [
        "`{{source}}` reaches past the {{capability}} capability's public API.",
        '',
        'A capability is a vertical slice, so its internals are its own — reaching',
        'in makes every internal path public and it can no longer move its own files.',
        '',
        'Repair, in `web/src/capabilities/{{capability}}/index.ts`:',
        '',
        '    export { {{symbol}} } from \'./…\';',
        '',
        'then import `{{symbol}}` from `@/capabilities/{{capability}}` here.',
        'The index owns what the capability exposes; this rule owns that nothing',
        'else is reachable.',
        '',
        'nession/no-deep-capability-imports',
      ].join('\n'),
    },
  },
  create(context) {
    const filename = (context.filename ?? '').replace(/\\/g, '/');
    const normalized = fromSrc(filename);
    if (isTestFile(normalized)) {
      return {};
    }
    const self = ownerOf(normalized);

    function check(node) {
      const spec = node.source?.value;
      if (typeof spec !== 'string') {
        return;
      }
      const resolved = resolveSpecifier(spec, filename);
      if (resolved == null) {
        return;
      }
      const at = resolved.indexOf(CAPABILITIES);
      if (at === -1) {
        return;
      }
      const rest = resolved.slice(at + CAPABILITIES.length).split('/');
      const capability = rest.shift();
      // The capability root itself is the public API — that is the allowed form.
      if (!capability || rest.length === 0) {
        return;
      }
      // A capability's own files importing each other is an internal detail.
      if (self === capability) {
        return;
      }
      context.report({
        node,
        messageId: 'violation',
        data: {
          source: spec,
          capability,
          symbol: rest[rest.length - 1],
        },
      });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};
