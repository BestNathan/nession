/**
 * Markdown domain module — detection, filename signals, and the preview
 * plugin chain.
 *
 * Detection deliberately trusts metadata over content: markdown has no magic
 * bytes and every plain-text file is valid markdown, so a content guess is
 * capped below the confidence at which callers may change presentation. See
 * `detect.ts` for the reasoning and `types.ts` for the confidence bands.
 *
 * Note: the general-purpose `detectLanguageForFile()` lives in
 * `@/lib/languageId` and is re-exported here for convenience. It cannot be
 * implemented inside this module without a circular import, since it needs the
 * full extension/basename tables that in turn depend on markdown detection.
 */

export {
  detectMarkdown,
  detectMarkdownLanguage,
} from './detect';

export {
  MARKDOWN_BASENAMES,
  MARKDOWN_EXTENSIONS,
  MARKDOWN_MIME_TYPES,
  basenameOf,
  isMarkdownBasename,
  isMarkdownExt,
  isMarkdownMimeType,
} from './extensions';

export {
  getRehypePlugins,
  getRemarkPlugins,
  markdownSanitizeSchema,
} from './previewPlugins';

export {
  AUTO_APPLY_CONFIDENCE,
  MAX_CONTENT_CONFIDENCE,
  SUGGEST_CONFIDENCE,
  type DetectionSource,
  type LanguageDetection,
  type MarkdownDetection,
} from './types';

export { detectLanguageForFile } from '@/lib/languageId';
