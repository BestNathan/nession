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
 */

// Import direction map: which layers can import which
const ALLOWED_IMPORTS = {
  'app': ['features', 'core', 'shared'],
  'features': ['core', 'shared'],
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
const LEGACY_TO_LAYER = {
  'components': 'shared', // components/ui only
  'lib': 'shared',
  'atoms': 'shared', // atoms are shared state
  'services': 'core', // services/socket, attachPrefs, deepLinkAttach
  'runtime': 'core',
  'core': 'core',
  'shared': 'shared',
  'features': 'features',
  'app': 'app',
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
        const importPath = node.source.value;

        // Skip external packages (no @/ prefix and not relative)
        if (!importPath.startsWith('@/') && !importPath.startsWith('.')) {
          return;
        }

        // Erased at build time — no runtime edge, so no direction to enforce.
        if (node.importKind === 'type') {
          return;
        }

        const sourceLayer = getSourceLayer(currentFilePath);
        const targetLayer = getTargetLayer(importPath);

        // Skip if we can't determine layers
        if (sourceLayer === 'unknown' || targetLayer === 'unknown') {
          return;
        }

        // Check if import is allowed
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
      },
    };
  },
};
