/**
 * App layer — public API
 *
 * This is the only entry point for the app layer. Other layers (features, core, shared)
 * should only import from this file, not from internal app modules.
 *
 * The app layer contains:
 * - Application composition root (Workbench, App)
 * - Top-level routing and layout
 * - Feature orchestration (how features are combined)
 *
 * It does NOT contain:
 * - Feature-specific business logic (that's in features/)
 * - Shared infrastructure (that's in core/ or shared/)
 */

export { Workbench } from './Workbench';
