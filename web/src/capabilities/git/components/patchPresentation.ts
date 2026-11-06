import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

/** The two presentations Pierre Diffs offers for one patch. */
export type GitDiffLayout = 'unified' | 'split';

/**
 * What a bounded `git.diff` answer can actually be drawn as.
 *
 * The Agent sends one file's patch and a `binary` flag, but the text can still
 * be one of five things: a normal patch, a mode-only patch with no hunks, an
 * empty answer, a binary answer, or output the renderer cannot parse. Keeping
 * that decision here — not in the component — is what lets the view state each
 * case explicitly instead of handing an empty pane to the reader and letting
 * them infer "unchanged".
 *
 * Parsing is validation, not rendering. `PatchDiff` parses the same text again
 * when it draws; this pass exists so a malformed or truncated patch becomes the
 * labelled raw fallback rather than an exception out of a third-party renderer.
 */
export type GitPatchInspection =
  | { kind: 'binary' }
  | { kind: 'empty' }
  | { kind: 'mode-only'; from: string; to: string }
  | { kind: 'no-lines' }
  | { kind: 'malformed' }
  | { kind: 'renderable'; file: FileDiffMetadata };

/**
 * Classify one bounded patch.
 *
 * `throwOnError` matters: without it the parser logs the failure and returns an
 * empty patch list, which is indistinguishable from valid empty output. With it,
 * an incomplete hunk (the ordinary shape of a byte-capped patch) is a rejection
 * we can fall back from.
 *
 * A patch must contain exactly one patch and one file. The Agent's `git.diff`
 * is requested for one path, so a multi-file answer is not something this view
 * can honestly present as one file's change.
 */
export function inspectGitPatch(text: string, binary: boolean): GitPatchInspection {
  if (binary) {
    return { kind: 'binary' };
  }
  if (text === '') {
    return { kind: 'empty' };
  }

  try {
    const patches = parsePatchFiles(text, { throwOnError: true });
    const patch = patches[0];
    if (patches.length !== 1 || !patch || patch.files.length !== 1) {
      return { kind: 'malformed' };
    }

    const file = patch.files[0];
    if (!file) {
      return { kind: 'malformed' };
    }
    if (file.hunks.length > 0) {
      return { kind: 'renderable', file };
    }
    if (
      typeof file.prevMode === 'string' &&
      typeof file.mode === 'string' &&
      file.prevMode !== file.mode
    ) {
      return { kind: 'mode-only', from: file.prevMode, to: file.mode };
    }
    return { kind: 'no-lines' };
  } catch {
    return { kind: 'malformed' };
  }
}
