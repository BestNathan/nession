/**
 * App layer — public API
 *
 * The app layer is the composition root: shell layout, routing and feature
 * orchestration. It may import features, core and shared — never the reverse.
 *
 * Composition happens in `App.tsx` (top-level), which renders the single
 * session-first shell (`SessionFirstShell`) plus the `/fixture` routes used
 * by visual regression tests. There is deliberately no barrel re-export here
 * yet — app-internal modules import each other directly; revisit if a second
 * consumer for a shell module appears.
 */
