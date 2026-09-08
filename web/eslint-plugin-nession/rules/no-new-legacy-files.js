/**
 * ESLint rule: no-new-legacy-files
 *
 * Prevents new business logic from being added to legacy directories.
 * Legacy directories are frozen during the architecture migration (Phase 0-5).
 *
 * Legacy directories:
 * - src/components/ (except ui/) — should migrate to features/
 * - src/hooks/ — should migrate to features/
 * - src/session-first/ — should migrate to app/workbench/

 * - src/explorer/ — should consolidate into features/explorer/
 *
 * Allowed operations in legacy directories:
 * - Bug fixes (small, targeted changes)
 * - Migrations (moving files OUT of legacy)
 * - Deletions (removing migrated files)
 *
 * Forbidden operations:
 * - New feature components
 * - New hooks with business logic
 * - New state management (atoms, stores)
 */

const LEGACY_DIRS = [
  'src/components/',
  'src/hooks/',
  'src/session-first/',

  'src/explorer/',
];

// Files that are allowed to exist in legacy dirs (already there, not new)
// This rule only prevents NEW files from being created
const ALLOWED_PATTERNS = [
  // Test files are always allowed
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
  /__tests__\//,
  // Type definitions are allowed
  /\.d\.ts$/,
  // Config files
  /\/types\.ts$/,
];

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent new business logic in legacy directories during migration',
      category: 'Architecture',
      recommended: true,
    },
    schema: [],
    messages: {
      legacyFrozen: 'Legacy directory "{{dir}}" is frozen. New business logic should go to features/ or app/workbench/. See #650.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const filePath = context.getFilename();

        // Check if file is in a legacy directory
        for (const legacyDir of LEGACY_DIRS) {
          if (filePath.includes(legacyDir)) {
            // Allow UI primitives (components/ui/)
            if (filePath.includes('src/components/ui/')) {
              return;
            }

            // Allow test files
            for (const pattern of ALLOWED_PATTERNS) {
              if (pattern.test(filePath)) {
                return;
              }
            }

            // For all other files, report a warning
            // Note: We can't actually detect if this is a NEW file vs existing
            // This rule serves as documentation and manual enforcement
            context.report({
              node,
              messageId: 'legacyFrozen',
              data: {
                dir: legacyDir,
              },
            });
            return;
          }
        }
      },
    };
  },
};
