import type { ComponentType } from 'react';
import type { FilePresentation } from './presentation';

/** The source-editor primitive a caller supplies (layering: shared cannot reach platform). */
export interface FileSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  filename?: string;
  initialLine?: number;
  /** 1-based column when a navigation target carried one (#3187). */
  initialColumn?: number;
}

export type FileSourceEditor = ComponentType<FileSourceEditorProps>;

/**
 * The authorized content a caller already owns.
 *
 * The shared viewer never fetches: `text` has been decoded by the caller,
 * `media.url` is a caller-owned Blob URL (or equivalent) that the caller
 * revokes, and `unavailable` is a truthful refusal rather than a fabricated
 * empty file. Git and Files differ in how they authorize and read; they agree
 * on this shape.
 */
export type FileViewData =
  | { kind: 'text'; text: string; complete: boolean }
  | { kind: 'media'; url: string; mimeType: string; complete: true }
  | { kind: 'unavailable'; reason: string };

export type FileViewMode = 'preview' | 'source';

export interface FileContentViewerProps {
  file: { path: string; mimeType?: string };
  data: FileViewData;
  /**
   * The platform-owned code editor primitive. `shared` may not import
   * `platform`, so the consumer supplies the same renderer it would otherwise
   * compose here; the shared owner still decides *when* source is shown.
   */
  sourceEditor: FileSourceEditor;
  /**
   * `auto` shows a structured preview when one is meaningful and complete,
   * otherwise source. An explicit mode is honored only when the presentation
   * supports it.
   */
  mode?: 'auto' | FileViewMode;
  onModeChange?: (mode: FileViewMode) => void;
  /** Defaults to true. Git always uses the default. */
  readOnly?: boolean;
  /** Files' explicit edit path only; ignored when `readOnly`. */
  onTextChange?: (next: string) => void;
  initialLine?: number;
  initialColumn?: number;
}

export type { FilePresentation };
