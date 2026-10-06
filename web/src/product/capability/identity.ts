import type { CapabilityDefinition, CapabilitySnapshot } from './model';

export const CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES = 8;

interface GraphemeSegment {
  segment: string;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>;
}

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;

let cachedSegmenter: GraphemeSegmenter | undefined;

function capabilityTitleSegmenter(): GraphemeSegmenter {
  if (cachedSegmenter) {
    return cachedSegmenter;
  }

  const Segmenter = (
    Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }
  ).Segmenter;

  if (!Segmenter) {
    throw new Error(
      'Capability title validation requires Intl.Segmenter; use a runtime with Unicode grapheme segmentation support.',
    );
  }

  cachedSegmenter = new Segmenter(undefined, { granularity: 'grapheme' });
  return cachedSegmenter;
}

/**
 * Count user-visible grapheme clusters rather than UTF-16 code units.
 *
 * Capability compact identity is a visual contract: a family emoji or a
 * base-letter + combining mark is one visible character and must count as one.
 */
export function countCapabilityTitleGraphemes(value: string): number {
  return Array.from(capabilityTitleSegmenter().segment(value)).length;
}

/**
 * The label a constrained navigation surface renders.
 *
 * There is intentionally no automatic abbreviation here. The capability owns
 * the semantic short form; Nession only resolves which declared identity fits
 * the compact surface.
 */
export function resolveCapabilityCompactTitle(
  identity: Pick<CapabilitySnapshot, 'title' | 'shortTitle'>,
): string {
  return identity.shortTitle ?? identity.title;
}

/**
 * Enforce the compact identity contract at registration, before any surface can
 * render a capability with an unstable or invented abbreviation.
 */
export function validateCapabilityIdentity(
  definition: Pick<CapabilityDefinition, 'id' | 'title' | 'shortTitle'>,
): void {
  const titleLength = countCapabilityTitleGraphemes(definition.title);
  const shortTitle = definition.shortTitle;

  if (shortTitle !== undefined) {
    const shortTitleLength = countCapabilityTitleGraphemes(shortTitle);

    if (shortTitleLength === 0) {
      throw new Error(
        `Capability "${definition.id}" shortTitle is empty; provide a meaningful compact title or omit it when the full title fits within ${CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES} graphemes.`,
      );
    }

    if (shortTitleLength > CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES) {
      throw new Error(
        `Capability "${definition.id}" shortTitle "${shortTitle}" is ${shortTitleLength} graphemes; shorten it to at most ${CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES} graphemes.`,
      );
    }
  }

  if (
    titleLength > CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES &&
    shortTitle === undefined
  ) {
    throw new Error(
      `Capability "${definition.id}" title "${definition.title}" is ${titleLength} graphemes; add shortTitle with at most ${CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES} graphemes.`,
    );
  }
}
