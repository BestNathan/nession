/**
 * Features layer — public API
 *
 * This is the only entry point for the features layer. The core and shared layers
 * should not import from features (dependency direction: app → features → core → shared).
 *
 * The features layer contains:
 * - Domain-specific business logic (terminal, explorer, session management)
 * - Feature-specific components and hooks
 * - Feature state management (atoms, stores)
 *
 * Each feature should expose its public API through this file or through
 * feature-specific subdirectories (e.g., features/terminal/public.ts).
 *
 * During migration, legacy directories (components/, hooks/, explorer/)
 * are mapped to this layer. They will be gradually moved into features/.
 */

// Legacy directory mappings (to be removed after migration):
// - components/ → features/
// - hooks/ → features/
// - explorer/ → features/explorer/

// DONE (Phase 3): terminal/ migrated.
// - terminal/ runtime → core/terminal-runtime/ (React-free)
// - terminal/ UI + state → features/terminal/ (components/, hooks/, state/)
// - Capsule → features/terminal/capsule/

// TODO: Export feature public APIs as they are migrated
// export * as terminal from './terminal/public';
// export * as explorer from './explorer/public';
