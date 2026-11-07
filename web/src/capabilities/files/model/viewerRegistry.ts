/**
 * Compatibility re-export (#2876).
 *
 * The format registry moved to `shared/file-viewer`, where Files and Git
 * Changes resolve the same policy. This path remains for existing imports
 * while consumers migrate; it owns no rules of its own.
 */
export * from '@/shared/file-viewer/model/viewerRegistry';
