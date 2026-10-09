import { describe, expect, it } from 'vitest';
import { resolveCapabilityProjection } from '../../emergence';
import type { CapabilityPresence } from '../../presence';
import type { CapabilityId } from '../../model';

const shown = (...ids: CapabilityId[]): CapabilityPresence[] =>
  ids.map(
    (capabilityId): CapabilityPresence => ({
      capabilityId,
      surface: 'capsule',
      level: 'contextual',
    }),
  );

describe('the projection is the chosen capability, at one depth', () => {
  it('is dormant when nothing was chosen', () => {
    expect(resolveCapabilityProjection({ presences: shown('git'), chosen: null })).toBeUndefined();
  });

  it('shows the chosen capability', () => {
    expect(resolveCapabilityProjection({ presences: shown('git'), chosen: 'git' })).toBe('git');
  });

  it('ignores a choice the registry does not show here', () => {
    expect(resolveCapabilityProjection({ presences: shown('git'), chosen: 'files' })).toBeUndefined();
  });

  it('ignores a hidden capability', () => {
    const hidden: CapabilityPresence[] = [{ capabilityId: 'git', surface: 'capsule', level: 'hidden' }];
    expect(resolveCapabilityProjection({ presences: hidden, chosen: 'git' })).toBeUndefined();
  });
});
