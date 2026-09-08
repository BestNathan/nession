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

// DONE (Phase 3): terminal/ migrated.
// - terminal/ runtime → core/terminal-runtime/ (React-free)
// - terminal/ UI + state → features/terminal/ (components/, hooks/, state/)
// - Capsule → features/terminal/capsule/

// DONE (Phase 4): explorer/ + file browser/viewer UI migrated.
// - explorer/ → features/explorer/ (tree framework; extensions, stores)
// - FileBrowser/FileViewer/viewers + file hooks → features/files/
//   (components/, hooks/, model/, adapters/)
// - legacy components/ + hooks/ still hold terminal layouts and app chrome

// DONE (Phase 5 slice 1): sessions + agents domain UI/data migrated.
// - session list/details + shared dialogs + list hooks + domainState model
//   → features/sessions/ (components/, hooks/, model/)
// - agent cards/detail/delete + workspace agent page + agent data hooks
//   → features/agents/ (components/, hooks/)
// - features/agents reads the session-workspace channel vocabulary through
//   features/sessions (model/domainState + ConnectionStatus) — recorded in
//   each feature README
// - legacy components/ + hooks/ + session-first/ still hold the Dashboard
//   shell chrome (SessionList/SessionsSection, useDashboard composition),
//   attach domain (SessionDropdown, AttachDialog, atoms/), and the
//   session-first shell layouts — remaining Phase-5 slices

// TODO: Export feature public APIs as they are migrated
// export * as terminal from './terminal/public';
// export * as explorer from './explorer/public';
