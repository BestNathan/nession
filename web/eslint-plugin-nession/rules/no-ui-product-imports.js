import { dirname, join, normalize, relative, sep } from 'node:path';

/**
 * `components/ui` must not depend on anything above it.
 *
 * `components.md` draws the line: a generic primitive may not know Nession's
 * Session, Workspace, Agent, capability, or service state. `ConnectionStatusBadge`
 * violated it — it imported `ConnectionState` from `services/socket` and owned
 * the user-facing labels — and nothing objected, because the architecture rule
 * meant to catch that (`nession/no-reverse-imports`) reads the source layer from
 * the import path instead of the file path, so it cannot fire on any `@/` alias
 * (#774).
 *
 * This rule is deliberately the *enforceable subset* of that boundary rather
 * than a second architecture model: one directory, one allowed neighbour (the
 * shared layer), checked against the file's own path. The general rule needs a
 * decision about whether the layer map itself is right — fifteen production
 * files cross it today — so it is not fixed here.
 *
 * Allowed from `components/ui`:
 *   - anything inside `components/ui` (relative or `@/components/ui/`)
 *   - the shared layer: `@/lib/`, `@/shared/`
 *   - external packages
 * Everything else is a primitive reaching into product code.
 */

const UI_DIR = ['src', 'components', 'ui'];
const COMPONENTS_DIR = ['src', 'components'];
const ALLOWED_ALIASES = ['@/components/ui/', '@/lib/', '@/shared/'];

function isUnder(normalizedPath, segments) {
  const parts = normalizedPath.split('/').filter(Boolean);
  const rootIndex = parts.lastIndexOf('src');
  if (rootIndex === -1) {
    return false;
  }
  return parts.slice(rootIndex, rootIndex + segments.length).join('/') === segments.join('/');
}

/** The rule only polices primitives. */
function isInsideUi(normalizedPath) {
  return isUnder(normalizedPath, UI_DIR);
}

/**
 * Where a relative import may land. `components/` as a whole is the shared
 * layer, so a sibling like `../types` is fine; anything that climbs past it to
 * `src/services`, `src/features`, … is not.
 */
function isInsideComponents(normalizedPath) {
  return isUnder(normalizedPath, COMPONENTS_DIR);
}

/** The path as it looks from `src/`, so absolute and relative forms compare alike. */
function fromSrc(normalizedPath) {
  const marker = '/src/';
  const at = normalizedPath.lastIndexOf(marker);
  return at === -1 ? normalizedPath : normalizedPath.slice(at + 1);
}

function escapesUi(importPath, currentFilePath) {
  const normalizedFile = (currentFilePath ?? '').replace(/\\/g, '/');
  if (!normalizedFile.includes('/src/')) {
    return false;
  }
  const resolved = normalize(join(dirname(fromSrc(normalizedFile)), importPath))
    .split(sep)
    .join('/');
  return !isInsideComponents(resolved);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow components/ui primitives importing product, service, or feature code',
    },
    schema: [],
    messages: {
      violation: [
        'Generic primitive imports "{{source}}", which is product code.',
        '',
        'A primitive in components/ui must not know Session / Workspace / Agent /',
        'capability or service state. Own the meaning in a product pattern',
        '(app/patterns/ or features/<feature>/) and pass it down as presentation props.',
        '',
        'owner:  web/src/components/ui/',
        'repair: move the product knowledge up to a pattern; keep this component generic.',
        '',
        'nession/no-ui-product-imports',
      ].join('\n'),
    },
  },
  create(context) {
    const filename = (context.filename ?? '').replace(/\\/g, '/');
    if (!isInsideUi(fromSrc(filename))) {
      return {};
    }

    function check(node) {
      const importPath = node.source?.value;
      if (typeof importPath !== 'string') {
        return;
      }
      // External packages are not this rule's business.
      if (!importPath.startsWith('@/') && !importPath.startsWith('.')) {
        return;
      }
      const allowed =
        ALLOWED_ALIASES.some((alias) => importPath.startsWith(alias)) ||
        (importPath.startsWith('.') && !escapesUi(importPath, filename));
      if (!allowed) {
        context.report({ node, messageId: 'violation', data: { source: importPath } });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};
