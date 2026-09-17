/**
 * ESLint rule: no-reverse-imports
 *
 * Enforces the dependency direction: app → features → core → shared
 * Prevents reverse imports that would violate the layered architecture.
 *
 * ── What this rule is about, and what it is not ─────────────────────────────
 *
 * It protects the **runtime** dependency graph: which module can pull which
 * into the bundle. Two things are therefore out of scope, and both are exempt
 * below rather than left to accumulate:
 *
 *   - `import type` is erased at build time. It creates no runtime edge and
 *     cannot form a bundle cycle, so forcing type declarations to move down the
 *     layers would be churn that buys nothing. `import { type X }` is a *value*
 *     import statement and stays in scope.
 *   - test files are not shipped and are not part of that graph. A test wiring
 *     several layers together to exercise something is doing its job; the
 *     shipped graph is what this rule is for. (`no-capsule-magic-metrics` treats
 *     test files the same way.)
 *
 * ── The bug this rule shipped with (#783) ───────────────────────────────────
 *
 * `getSourceLayer` accepted the import path and checked it *first* — the same
 * input `getTargetLayer` reads. For any `@/` alias both therefore returned the
 * layer of the import *target*, the mismatch check short-circuited, and the rule
 * reported nothing at all. Every cross-layer import in this repo uses `@/`, so
 * it never fired once in its life. A source layer is a property of where the
 * code lives and must never be read from what the code imports.
 *
 * ── What counts as an edge (#788, #791) ─────────────────────────────────────
 *
 * A re-export is the same runtime edge as an import: `export { x } from '…'`
 * pulls the module into the bundle exactly as `import` does, so
 * `components/ui` re-exporting a feature is the same violation as importing it.
 * The rule had only an `ImportDeclaration` visitor, so that form passed. Then
 * `await import('…')` was uncovered for the same reason — a third syntax for
 * the identical edge.
 *
 * All four statements now share one `checkRuntimeEdge`. A local `export { x }`
 * with no `from` clause is skipped (it references no other module), as is a
 * non-literal dynamic import (`import(someVar)` names nothing statically
 * resolvable). The visit list is the whole taxonomy of runtime edges, so a
 * fifth form appearing should be a deliberate omission rather than an oversight.
 */

// Import direction map: which layers can import which
const ALLOWED_IMPORTS = {
  'app': ['features', 'extensions', 'core', 'shared'],
  'features': ['extensions', 'core', 'shared'],
  // `extensions/` is a rung of its own, not a feature. The mutual allowance
  // with `features` is deliberate and documented in docs/architecture/web.md:
  // the registry is consumed by app and feature code, and an extension composes
  // the feature it extends. It is a sanctioned cycle, not an oversight — do not
  // "fix" it by folding extensions into features, which would wrongly let
  // `core` reach it.
  'extensions': ['features', 'core', 'shared'],
  'core': ['shared'],
  'shared': [], // shared cannot import any business layer
};

// Physical directory -> layer. The legacy feature dirs (hooks/,
// session-first/, non-ui components/) were deleted in Phase 5 (#655);
// components/ now holds only the shared shadcn ui/ primitives.
//
// Verified against who *consumes* each directory, so these are not guesses:
// features import `atoms` (9 files) and `runtime` (8 files), so both must sit
// below features — which is where they already are. The reverse imports found
// by fixing this rule are real, not a mis-classification (#783).
//
// `markdown` is `shared`, decided by the same test rather than by its name: its
// consumers are `features/files` (3 edges) *and* `lib/languageId` (2 edges), and
// a `shared` module importing it forces it to `shared` — shared is the bottom.
// The `markdown ↔ lib` cycle that results is deliberate and both files say so:
// general language detection needs markdown's ranked signals, and markdown
// cannot host the general tables without importing them back. Same layer, so
// the rule permits it; this entry is what makes that a decision rather than an
// accident (#793).
const LEGACY_TO_LAYER = {
  'components': 'shared', // components/ui only
  'lib': 'shared',
  'atoms': 'shared', // atoms are shared state
  'markdown': 'shared', // markdown pipeline — rationale in the note above
  'services': 'core', // services/socket, attachPrefs, deepLinkAttach
  'runtime': 'core',
  'core': 'core',
  'shared': 'shared',
  'features': 'features',
  'app': 'app',
  // Outside the ladder proper; see ALLOWED_IMPORTS.extensions.
  'extensions': 'extensions',
};

// Directories under `src/` that are deliberately not layers. Everything else
// must appear in LEGACY_TO_LAYER. A fixture asserts that against the real
// directory listing, in both directions, so a new `src/` directory cannot
// repeat the mistake #793 records: falling into `unknown`, which
// `checkRuntimeEdge` skips — unchecked in both directions while looking mapped.
const NON_LAYER_DIRS = {
  '__tests__': 'test files — exempt from this rule entirely (see isTestFile)',
  'test': 'vitest setup + shared mocks; imported only by test files',
};

function isTestFile(filePath) {
  const normalized = (filePath ?? '').replace(/\\/g, '/');
  return (
    normalized.includes('/__tests__/') ||
    /\.(test|spec)\.[jt]sx?$/.test(normalized)
  );
}

/** The layer of the file *doing the importing*, from its own path. */
function getSourceLayer(currentFilePath) {
  const normalized = (currentFilePath ?? '').replace(/\\/g, '/');
  const match = normalized.match(/\/src\/([^/]+)\//);
  if (!match) {
    return 'unknown';
  }
  return LEGACY_TO_LAYER[match[1]] ?? 'unknown';
}

function getTargetLayer(importPath) {
  // Handle layer aliases
  if (importPath.startsWith('@app/')) return 'app';
  if (importPath.startsWith('@features/')) return 'features';
  if (importPath.startsWith('@core/')) return 'core';
  if (importPath.startsWith('@shared/')) return 'shared';

  // Handle @/ imports
  if (importPath.startsWith('@/')) {
    const match = importPath.match(/^@\/([^/]+)/);
    if (match) {
      const dir = match[1];
      return LEGACY_TO_LAYER[dir] || 'unknown';
    }
  }

  return 'unknown';
}

/**
 * Report `node` when the module edge from the current file to `importPath`
 * points back up the layer order.
 *
 * Shared by all three statement forms so their alias handling and skip
 * conditions cannot drift apart — the divergence between visitors is how the
 * coverage gap in #788 survived: one check, one place.
 */
function checkRuntimeEdge(context, node, importPath, currentFilePath) {
  // A non-literal or absent source names no module we can resolve: a computed
  // dynamic import, or a local `export { x }`.
  if (typeof importPath !== 'string') {
    return;
  }

  // Skip external packages (no @/ prefix and not relative)
  if (!importPath.startsWith('@/') && !importPath.startsWith('.')) {
    return;
  }

  const sourceLayer = getSourceLayer(currentFilePath);
  const targetLayer = getTargetLayer(importPath);

  // Skip if we can't determine layers
  if (sourceLayer === 'unknown' || targetLayer === 'unknown') {
    return;
  }

  // Check if the edge is allowed
  const allowedTargets = ALLOWED_IMPORTS[sourceLayer] || [];
  if (!allowedTargets.includes(targetLayer) && sourceLayer !== targetLayer) {
    context.report({
      node,
      messageId: 'reverseImport',
      data: {
        sourceLayer,
        targetLayer,
        allowed: allowedTargets.join(', '),
      },
    });
  }
}

// Exported for the fixture that asserts every `src/` directory is classified.
// The rule's own behaviour never reads them directly.
export { ALLOWED_IMPORTS, LEGACY_TO_LAYER, NON_LAYER_DIRS };

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce layered architecture import direction (app → features → core → shared)',
      category: 'Architecture',
      recommended: true,
    },
    schema: [],
    messages: {
      reverseImport: 'Reverse import detected: {{sourceLayer}} cannot import from {{targetLayer}}. Allowed: [{{allowed}}]',
    },
  },
  create(context) {
    const currentFilePath = context.getFilename();
    if (isTestFile(currentFilePath)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        // Erased at build time — no runtime edge, so no direction to enforce.
        if (node.importKind === 'type') {
          return;
        }
        checkRuntimeEdge(context, node, node.source?.value, currentFilePath);
      },

      // `export { x } from '…'` and `export { x }`. `source` is null in the
      // second form, which references no other module.
      ExportNamedDeclaration(node) {
        if (!node.source || node.exportKind === 'type') {
          return;
        }
        checkRuntimeEdge(context, node, node.source.value, currentFilePath);
      },

      // `export * from '…'` / `export * as ns from '…'` — always has a source.
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') {
          return;
        }
        checkRuntimeEdge(context, node, node.source?.value, currentFilePath);
      },

      // `await import('…')` — the same edge by a third syntax. Note `source` is
      // an *expression*, not a Literal: `import(someVar)` is not statically
      // resolvable, and checkRuntimeEdge's non-string guard leaves it alone
      // rather than guessing.
      ImportExpression(node) {
        checkRuntimeEdge(context, node, node.source?.value, currentFilePath);
      },
    };
  },
};
