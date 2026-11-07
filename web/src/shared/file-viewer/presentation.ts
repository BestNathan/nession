import { detectLanguage, type LanguageId } from '@/shared/lib/languageId';
import { isMarkdownExt, isMarkdownMimeType } from '@/shared/markdown/extensions';
import {
  getJsonPreviewKind,
  getViewerType,
  parseExt,
  type JsonPreviewKind,
  type ViewerType,
} from './model/viewerRegistry';
import type { FileViewData } from './types';

/** What the shared viewer should render for one file. */
export type PresentationKind =
  | 'code'
  | 'markdown'
  | 'json'
  | 'jsonl'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'unavailable';

export interface FilePresentation {
  kind: PresentationKind;
  language: LanguageId;
  /** Structured preview is meaningful only for complete text. */
  canPreview: boolean;
  /** The JSON / JSONL preview family, when this is structured text. */
  jsonKind: JsonPreviewKind | null;
}

/** The media family a path hints at, before any bytes are read. */
export function mediaHintForPath(path: string): ViewerType | null {
  return getViewerType(parseExt(path));
}

/** The real media family of a caller-validated MIME type. */
export function mediaKindForMimeType(mimeType: string): PresentationKind | null {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('image/')) {
    return 'image';
  }
  if (normalized.startsWith('video/')) {
    return 'video';
  }
  if (normalized.startsWith('audio/')) {
    return 'audio';
  }
  if (normalized === 'application/pdf') {
    return 'pdf';
  }
  return null;
}

const CODE_ONLY: Pick<FilePresentation, 'canPreview' | 'jsonKind'> = {
  canPreview: false,
  jsonKind: null,
};

/**
 * The single format policy for every file presentation surface.
 *
 * The data kind decides first: a caller that only has text never gets a media
 * viewer, and a caller that only has media never gets source text. Only when
 * the data is text does the path select a structured or code presentation.
 * That ordering is what makes an extension a *hint* rather than byte
 * authority: a text file named `.png` is displayed as text, not as a broken
 * image, and a binary answer is `unavailable` rather than decoded as source.
 */
export function resolveFilePresentation(
  file: { path: string; mimeType?: string },
  data?: FileViewData,
): FilePresentation {
  if (data?.kind === 'unavailable') {
    return { kind: 'unavailable', language: 'plaintext', ...CODE_ONLY };
  }

  if (data?.kind === 'media') {
    const kind = mediaKindForMimeType(data.mimeType);
    return {
      kind: kind ?? 'unavailable',
      language: 'plaintext',
      ...CODE_ONLY,
    };
  }

  // Text (or no data yet): the path/MIME selects a text presentation.
  const path = file.path;
  const jsonKind = getJsonPreviewKind(parseExt(path));
  if (jsonKind) {
    return {
      kind: jsonKind,
      language: jsonKind === 'json' ? 'json' : 'plaintext',
      // The format supports a structured preview; whether the caller's data is
      // complete enough to show one is decided by the caller's `complete` flag.
      canPreview: true,
      jsonKind,
    };
  }

  const mimeSaysMarkdown = isMarkdownMimeType(file.mimeType ?? '');
  if (isMarkdownExt(parseExt(path)) || mimeSaysMarkdown) {
    return {
      kind: 'markdown',
      language: 'markdown',
      canPreview: true,
      jsonKind: null,
    };
  }

  return {
    kind: 'code',
    language: detectLanguage(path),
    ...CODE_ONLY,
  };
}
