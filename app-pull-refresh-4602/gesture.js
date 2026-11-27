/*
 * App host pull-to-refresh gesture decisions — #4602 prototype.
 *
 * Pure logic, no DOM: the smoke test executes exactly these decisions against
 * synthetic contacts. Production implementation belongs to #4602, not here.
 */
(function (root) {
  'use strict';

  var AXIS_LOCK_PX = 8;
  var RELEASE_THRESHOLD_PX = 64;
  var RESISTANCE = 0.5;
  var MAX_PULL_PX = 96;

  /**
   * Whether a surface may arm the host pull at all. Terminal, editor, modal and
   * nested scroller contacts belong to their own owners (#4602 §4).
   */
  function isEligible(surface) {
    return surface === 'sessions';
  }

  function createContact(options) {
    return {
      eligible: isEligible(options.surface) && options.atTop === true,
      surface: options.surface,
      atTop: options.atTop === true,
      axis: null,
      rawY: 0,
      distance: 0,
      committed: false
    };
  }

  /**
   * Classify one move. The first movement past the lock decides the axis for
   * the whole contact, so a pull can never become a swipe mid-gesture.
   */
  function move(contact, dx, dy) {
    contact.rawY = dy;
    if (contact.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) {
        return { action: 'pending', distance: 0 };
      }
      contact.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    if (contact.axis === 'horizontal') {
      // The outer pager owns this contact; the host pull never arms.
      return { action: 'surrender', distance: 0 };
    }
    if (!contact.eligible) {
      // Not at top, or a surface that owns its own touches: ordinary scrolling.
      return { action: 'scroll', distance: 0 };
    }
    if (dy <= 0) {
      contact.distance = 0;
      return { action: 'scroll', distance: 0 };
    }
    contact.distance = Math.min(MAX_PULL_PX, dy * RESISTANCE);
    return { action: 'pull', distance: contact.distance };
  }

  /** Release commits at most once, and only past the threshold. */
  function release(contact) {
    if (contact.committed) { return { action: 'none' }; }
    var qualifies = contact.axis === 'vertical'
      && contact.eligible
      && contact.rawY >= RELEASE_THRESHOLD_PX;
    if (!qualifies) { return { action: 'cancel' }; }
    contact.committed = true;
    return { action: 'commit' };
  }

  root.NessionPullGesture = {
    AXIS_LOCK_PX: AXIS_LOCK_PX,
    RELEASE_THRESHOLD_PX: RELEASE_THRESHOLD_PX,
    RESISTANCE: RESISTANCE,
    MAX_PULL_PX: MAX_PULL_PX,
    isEligible: isEligible,
    createContact: createContact,
    move: move,
    release: release
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
