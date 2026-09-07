/**
 * ESLint rule: no-reverse-imports
 *
 * Enforces the dependency direction: app → features → core → shared
 * Prevents reverse imports that would violate the layered architecture.
 */

// Import direction map: which layers can import which
// Note: Layer aliases (@app/*, @core/*, etc.) will be added in Phase 1 when directories exist
const ALLOWED_IMPORTS = {
  'app': ['features', 'core', 'shared'],
  'features': ['core', 'shared'],
  'core': ['shared'],
  'shared': [], // shared cannot import any business layer
};

// Legacy directory mappings (to be removed after migration)
const LEGACY_TO_LAYER = {
  'components': 'features',
  'hooks': 'features',
  'terminal': 'features',
  'explorer': 'features',
  'session-first': 'app',
  'services/websocket': 'core',
  'runtime': 'core',
  'lib': 'shared',
  'atoms': 'shared', // atoms are shared state
};

function getSourceLayer(importPath, currentFilePath) {
  // Handle alias imports (@/)
  if (importPath.startsWith('@/')) {
    // Extract directory from @/ path
    const match = importPath.match(/^@\/([^/]+)/);
    if (match) {
      const dir = match[1];
      return LEGACY_TO_LAYER[dir] || 'unknown';
    }
  }

  // Handle relative imports - determine layer from current file path
  for (const [dir, layer] of Object.entries(LEGACY_TO_LAYER)) {
    if (currentFilePath.includes(`/src/${dir}/`)) {
      return layer;
    }
  }

  // Check for new layer directories (will be used in Phase 1+)
  if (currentFilePath.includes('/src/app/')) return 'app';
  if (currentFilePath.includes('/src/features/')) return 'features';
  if (currentFilePath.includes('/src/core/')) return 'core';
  if (currentFilePath.includes('/src/shared/')) return 'shared';

  return 'unknown';
}

function getTargetLayer(importPath) {
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
    return {
      ImportDeclaration(node) {
        const importPath = node.source.value;

        // Skip external packages (no @/ prefix and not relative)
        // Note: Layer-specific aliases (@app/*, @core/*, etc.) will be added in Phase 1
        if (!importPath.startsWith('@/') && !importPath.startsWith('.')) {
          return;
        }

        const currentFilePath = context.getFilename();
        const sourceLayer = getSourceLayer(importPath, currentFilePath);
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
