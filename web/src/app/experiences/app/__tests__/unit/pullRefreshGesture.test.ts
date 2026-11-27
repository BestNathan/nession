import { describe, expect, it } from 'vitest';
import {
  AXIS_LOCK_PX,
  MAX_PULL_PX,
  PULL_RESISTANCE,
  RELEASE_THRESHOLD_PX,
  createPullContact,
  movePullContact,
  releasePullContact,
} from '../../pullRefreshGesture';

function contact(surface: 'sessions' | 'terminal' | 'nested' = 'sessions', atTop = true) {
  return createPullContact({ surface, atTop });
}

describe('App host pull gesture (#4602 SC-05)', () => {
  it('cancels a short pull without committing', () => {
    const c = contact();
    expect(movePullContact(c, 0, 30).action).toBe('pull');
    expect(releasePullContact(c)).toBe('cancel');
    expect(c.committed).toBe(false);
  });

  it('commits once at the raw-travel threshold', () => {
    const c = contact();
    movePullContact(c, 0, RELEASE_THRESHOLD_PX);
    expect(releasePullContact(c)).toBe('commit');
    expect(releasePullContact(c)).toBe('none');
  });

  it('measures the threshold on raw travel, not resisted distance', () => {
    const c = contact();
    const result = movePullContact(c, 0, RELEASE_THRESHOLD_PX);
    expect(result.distance).toBe(RELEASE_THRESHOLD_PX * PULL_RESISTANCE);
    expect(releasePullContact(c)).toBe('commit');

    const under = contact();
    movePullContact(under, 0, RELEASE_THRESHOLD_PX - 1);
    expect(releasePullContact(under)).toBe('cancel');
  });

  it('locks the axis on the first movement past the lock', () => {
    const c = contact();
    expect(movePullContact(c, 3, 2).action).toBe('pending');
    expect(movePullContact(c, 20, 6).action).toBe('surrender');
    // Later vertical drift cannot arm a surrendered contact.
    expect(movePullContact(c, 20, 90).action).toBe('surrender');
    expect(releasePullContact(c)).toBe('cancel');
  });

  it('keeps a vertical lock against later horizontal drift', () => {
    const c = contact();
    expect(movePullContact(c, 2, AXIS_LOCK_PX + 12).action).toBe('pull');
    expect(movePullContact(c, 40, 80).action).toBe('pull');
    expect(releasePullContact(c)).toBe('commit');
  });

  it('surrenders when the list is not at top', () => {
    const c = contact('sessions', false);
    expect(movePullContact(c, 0, 90).action).toBe('scroll');
    expect(releasePullContact(c)).toBe('cancel');
  });

  it('never arms for Terminal or a nested scroller', () => {
    for (const surface of ['terminal', 'nested'] as const) {
      const c = contact(surface);
      expect(movePullContact(c, 0, 90).action).toBe('scroll');
      expect(releasePullContact(c)).toBe('cancel');
    }
  });

  it('treats an upward drag as ordinary scrolling', () => {
    const c = contact();
    expect(movePullContact(c, 0, -60).action).toBe('scroll');
    expect(releasePullContact(c)).toBe('cancel');
  });

  it('resists and caps the indicator travel', () => {
    const c = contact();
    expect(movePullContact(c, 0, 40).distance).toBe(20);
    expect(movePullContact(c, 0, 1000).distance).toBe(MAX_PULL_PX);
  });
});
