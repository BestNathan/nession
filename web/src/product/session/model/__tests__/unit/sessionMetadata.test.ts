import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '@/product/session/types';
import {
  addSessionMetadataTag,
  codepointLength,
  draftFromMetadata,
  isSessionMetadataDraftDirty,
  metadataDisplayTitle,
  normalizeSessionMetadataDraft,
  removeSessionMetadataTag,
  SESSION_METADATA_DESCRIPTION_MAX,
  SESSION_METADATA_TAG_LIMIT,
  SESSION_METADATA_TAG_MAX,
  SESSION_METADATA_TITLE_MAX,
  validateSessionMetadataDraft,
} from '../../sessionMetadata';

function metadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    revision: 1,
    title: 'Release triage',
    description: 'Fix the staging run',
    tags: ['release', 'staging'],
    created_at: 1762300000,
    updated_at: 1762303600,
    ...overrides,
  };
}

describe('metadataDisplayTitle', () => {
  it('uses the metadata title when set', () => {
    expect(metadataDisplayTitle(metadata(), 'tmux-name')).toBe('Release triage');
  });

  it('falls back to the tmux name for absent, empty and whitespace titles', () => {
    expect(metadataDisplayTitle(null, 'tmux-name')).toBe('tmux-name');
    expect(metadataDisplayTitle(metadata({ title: null }), 'tmux-name')).toBe('tmux-name');
    expect(metadataDisplayTitle(metadata({ title: '   ' }), 'tmux-name')).toBe('tmux-name');
  });
});

describe('draft', () => {
  it('maps absent metadata to an empty draft', () => {
    expect(draftFromMetadata(null)).toEqual({ title: '', description: '', tags: [] });
  });

  it('normalizes trimmed values and drops empty fields', () => {
    const draft = draftFromMetadata(metadata({ title: '  T  ', description: '  ' }));
    expect(normalizeSessionMetadataDraft(draft)).toEqual({
      title: 'T',
      description: null,
      tags: ['release', 'staging'],
    });
  });

  it('recognizes a draft that equals the stored metadata as clean', () => {
    expect(isSessionMetadataDraftDirty(draftFromMetadata(metadata()), metadata())).toBe(false);
    expect(
      isSessionMetadataDraftDirty(
        { ...draftFromMetadata(metadata()), title: 'Other' },
        metadata(),
      ),
    ).toBe(true);
  });
});

describe('validation bounds', () => {
  it('counts Unicode scalar values, not UTF-16 code units', () => {
    // Each emoji is one Rust `char` but two UTF-16 code units.
    expect(codepointLength('🧪')).toBe(1);
    const max = '🧪'.repeat(SESSION_METADATA_TITLE_MAX);
    expect(validateSessionMetadataDraft({ title: max, description: '', tags: [] })).toBeNull();
    expect(
      validateSessionMetadataDraft({
        title: `${max}🧪`,
        description: '',
        tags: [],
      }),
    ).not.toBeNull();
  });

  it('rejects an overlong description', () => {
    const draft = {
      title: '',
      description: 'x'.repeat(SESSION_METADATA_DESCRIPTION_MAX + 1),
      tags: [],
    };
    expect(validateSessionMetadataDraft(draft)).toContain('Description');
  });

  it('rejects too many, too long and duplicate tags', () => {
    const tooMany = Array.from({ length: SESSION_METADATA_TAG_LIMIT + 1 }, (_, i) => `t${i}`);
    expect(validateSessionMetadataDraft({ title: '', description: '', tags: tooMany })).toContain(
      'at most',
    );
    expect(
      validateSessionMetadataDraft({
        title: '',
        description: '',
        tags: ['x'.repeat(SESSION_METADATA_TAG_MAX + 1)],
      }),
    ).toContain('Each tag');
    expect(
      validateSessionMetadataDraft({ title: '', description: '', tags: ['Same', 'same'] }),
    ).toContain('twice');
  });

  it('ignores duplicate and empty tags it would trim away', () => {
    expect(
      validateSessionMetadataDraft({ title: '', description: '', tags: ['  ', ' one '] }),
    ).toBeNull();
  });
});

describe('tag editing', () => {
  const draft = { title: '', description: '', tags: ['release'] };

  it('adds a trimmed, case-insensitively unique tag', () => {
    const result = addSessionMetadataTag(draft, '  Staging ');
    expect(result.error).toBeNull();
    expect(result.draft.tags).toEqual(['release', 'Staging']);
  });

  it('refuses empty, duplicate, overlong and over-limit tags', () => {
    expect(addSessionMetadataTag(draft, '   ').error).toContain('Enter a tag');
    expect(addSessionMetadataTag(draft, 'RELEASE').error).toContain('already added');
    expect(
      addSessionMetadataTag(draft, 'x'.repeat(SESSION_METADATA_TAG_MAX + 1)).error,
    ).toContain('at most');
    const full = {
      ...draft,
      tags: Array.from({ length: SESSION_METADATA_TAG_LIMIT }, (_, i) => `t${i}`),
    };
    expect(addSessionMetadataTag(full, 'one-more').error).toContain('at most 12 tags');
  });

  it('keeps the first-seen order and removes by index', () => {
    const first = addSessionMetadataTag(draft, 'second');
    const second = addSessionMetadataTag(first.draft, 'third');
    expect(second.draft.tags).toEqual(['release', 'second', 'third']);
    expect(removeSessionMetadataTag(second.draft, 1).tags).toEqual(['release', 'third']);
  });
});
