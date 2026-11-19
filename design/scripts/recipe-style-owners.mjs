/**
 * Canonical files whose content spacing and visual grammar are Nession-owned
 * rather than upstream shadcn or renderer internals (#4050).
 *
 * Keep the list in one place. layout-ownership and visual-vocabulary/ESLint
 * both consume it; neither can grant a blanket components/ui exemption.
 */
export const LAYOUT_RECIPE_OWNER = 'web/src/app/workspace/layout/workspaceLayout.tsx';

export const TOKEN_OWNED_RECIPE_FILES = Object.freeze([
  LAYOUT_RECIPE_OWNER,
  'web/src/components/ui/resource-detail.tsx',
  'web/src/components/ui/configuration-form.tsx',
  'web/src/components/ui/configuration-formStyles.ts',
  'web/src/components/ui/operation-surface.tsx',
]);

export function isTokenOwnedRecipe(filename) {
  const file = String(filename ?? '').replaceAll('\\', '/');
  return TOKEN_OWNED_RECIPE_FILES.some(path => file === path || file.endsWith('/' + path));
}
