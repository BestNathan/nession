/**
 * Core layer — public API
 *
 * This is the only entry point for the core layer. The shared layer should not import
 * from core (dependency direction: app → features → core → shared).
 *
 * The core layer contains:
 * - Framework-agnostic runtime logic
 * - Infrastructure services (WebSocket, HTTP, storage)
 * - Cross-cutting concerns (logging, error handling, telemetry)
 *
 * The core layer does NOT contain:
 * - React components or hooks (those belong in features/)
 * - Business logic specific to a single feature (that's in features/)
 * - Pure utility functions (those belong in shared/)
 *
 * During migration, legacy directories are mapped to this layer:
 * - services/websocket/ → core/websocket/
 * - runtime/ → core/runtime/
 */

// Legacy directory mappings (to be removed after migration):
// - services/websocket/ → core/websocket/
// - runtime/ → core/runtime/

// TODO: Export core public APIs as they are migrated
// export * as websocket from './websocket/public';
// export * as runtime from './runtime/public';
