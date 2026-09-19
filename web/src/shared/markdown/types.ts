/**
 * Types for markdown detection and the unified language-detection result.
 *
 * Markdown cannot be identified from content alone: under CommonMark every
 * plain-text file is valid markdown, and the format has no magic bytes. So
 * detection is a ranked set of signals with a confidence score, and content
 * sniffing is the weakest of them — deliberately never strong enough to change
 * how a file is presented on its own.
 */

/** Which signal decided the language, ordered by trustworthiness. */
export type DetectionSource =
  | 'manual'
  | 'filename'
  | 'extension'
  | 'mime'
  | 'content'
  | 'fallback';

/** Result of scoring file content (plus optional filename/MIME) for markdown. */
export interface MarkdownDetection {
  /** True when the accumulated score clears the detection threshold. */
  matched: boolean;
  /** Accumulated signal score. Negative for actively-excluded formats. */
  score: number;
  /** Names of the signals that contributed, for debugging and tests. */
  reasons: string[];
}

/**
 * Unified language-detection result.
 *
 * `confidence` drives presentation decisions. The bands are fixed:
 *   - `>= 0.8` — trustworthy metadata (extension / MIME / known basename).
 *     Callers may change presentation without asking.
 *   - `0.5 – 0.8` — content sniffing only. Callers must keep the current
 *     presentation and may offer a dismissible suggestion.
 *   - `< 0.5` — no usable signal; treat as plaintext and stay silent.
 */
export interface LanguageDetection {
  /** A LanguageId such as `markdown`, or `plaintext` when nothing matched. */
  language: string;
  /** 0.0 – 1.0. See the band table above. */
  confidence: number;
  source: DetectionSource;
  reasons: string[];
}

/**
 * Highest confidence a content-only detection may report.
 *
 * Kept strictly below AUTO_APPLY_CONFIDENCE so a content guess can never
 * silently switch a file into markdown preview — the bug this module replaces.
 */
export const MAX_CONTENT_CONFIDENCE = 0.75;

/** At or above this, a caller may change presentation without prompting. */
export const AUTO_APPLY_CONFIDENCE = 0.8;

/** At or above this (but below auto-apply), a caller may suggest markdown. */
export const SUGGEST_CONFIDENCE = 0.5;
