/**
 * The shared presentation owner for file content (#2876).
 *
 * Files and Git Changes both consume [`FileContentViewer`] with exactly one
 * format policy ([`resolveFilePresentation`]). This package is presentation
 * only: it has no file/Git/session I/O, no authority check, no write path and
 * no `capabilities/*` import.
 */
export { FileContentViewer } from './FileContentViewer';
export {
  mediaHintForPath,
  mediaKindForMimeType,
  resolveFilePresentation,
} from './presentation';
export type { FilePresentation, PresentationKind } from './presentation';
export type {
  FileContentViewerProps,
  FileSourceEditor,
  FileSourceEditorProps,
  FileViewData,
  FileViewMode,
} from './types';
