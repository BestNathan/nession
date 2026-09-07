/**
 * Shared layer — public API
 *
 * The shared layer is the foundation of the dependency hierarchy. It can be imported
 * by any other layer (app, features, core) but cannot import from them.
 *
 * The shared layer contains:
 * - Pure utility functions (formatting, validation, type guards)
 * - Generic React utilities (cn helper, generic hooks)
 * - Shared types and constants
 * - UI primitives (shadcn components in components/ui/)
 *
 * The shared layer does NOT contain:
 * - Business logic (that's in features/)
 * - Infrastructure services (that's in core/)
 * - Application composition (that's in app/)
 *
 * During migration, legacy directories are mapped to this layer:
 * - lib/ → shared/utils/
 * - atoms/ → shared/state/
 * - components/ui/ → shared/ui/
 */

// Legacy directory mappings (to be removed after migration):
// - lib/ → shared/utils/
// - atoms/ → shared/state/
// - components/ui/ → shared/ui/

// TODO: Export shared public APIs as they are migrated
// export * from './utils/public';
// export * from './state/public';
// export * from './ui/public';
