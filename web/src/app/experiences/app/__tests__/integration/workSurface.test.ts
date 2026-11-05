import { describe, it, expect } from 'vitest';
import {
  INTERACTIVE_OWNER_SELECTOR,
  WORK_SURFACE_SELECTOR,
  hasActiveSelectionWithin,
  isInteractiveOwner,
  isWorkSurface,
} from '../../workSurface';

function element(html: string, selector: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const found = host.querySelector(selector);
  if (!found) {
    throw new Error(`no element matched ${selector}`);
  }
  return found;
}

describe('isWorkSurface', () => {
  it('matches the surface itself, not only its descendants', () => {
    const viewport = element('<div data-terminal-viewport></div>', '[data-terminal-viewport]');

    expect(isWorkSurface(viewport)).toBe(true);
  });

  it('walks up from a deep descendant', () => {
    const screen = element(
      '<div data-terminal-viewport><div class="xterm"><div class="xterm-screen"></div></div></div>',
      '.xterm-screen',
    );

    expect(isWorkSurface(screen)).toBe(true);
  });

  const matched: Array<[string, string, string]> = [
    [
      'the terminal viewport',
      '<div data-terminal-viewport><span></span></div>',
      'span',
    ],
    [
      'a bare xterm mount',
      '<div class="xterm"><div class="xterm-viewport"></div></div>',
      '.xterm-viewport',
    ],
    [
      'CodeMirror',
      '<div class="cm-editor"><div class="cm-content"></div></div>',
      '.cm-content',
    ],
    ['a textarea', '<div><textarea></textarea></div>', 'textarea'],
    [
      'the capsule',
      '<div data-testid="terminal-capsule"><div data-testid="capsule-shell"></div></div>',
      '[data-testid="capsule-shell"]',
    ],
    [
      'the capability capsule row',
      '<nav data-testid="workspace-capability-capsule"><div data-testid="workspace-capability-scroll"><button data-testid="workspace-tool-files"></button></div></nav>',
      '[data-testid="workspace-tool-files"]',
    ],
  ];

  it.each(matched)('reports %s as a work surface', (_name, html, selector) => {
    expect(isWorkSurface(element(html, selector))).toBe(true);
  });

  const unmatched: Array<[string, string, string]> = [
    ['shell chrome', '<div class="shell-chrome"></div>', '.shell-chrome'],
    ['a sibling of the terminal well', '<header class="chrome"></header>', '.chrome'],
    ['a header inside the terminal page', '<div data-testid="app-spatial-page-terminal"><header></header></div>', 'header'],
    ['a button', '<button type="button">Sessions</button>', 'button'],
    ['an input outside the capsule', '<form><input /></form>', 'input'],
  ];

  it.each(unmatched)('does not report %s as a work surface', (_name, html, selector) => {
    expect(isWorkSurface(element(html, selector))).toBe(false);
  });

  it('resolves a text node through its parent element', () => {
    const host = element('<div data-terminal-viewport>text</div>', '[data-terminal-viewport]');
    const text = host.firstChild;

    expect(text).not.toBeNull();
    expect(isWorkSurface(text)).toBe(true);
  });

  it('treats an unclassifiable target as navigation, not as work', () => {
    // The rule names what is excluded rather than whitelisting what is
    // allowed, so "cannot tell" resolves to the gesture still working.
    expect(isWorkSurface(null)).toBe(false);
    expect(isWorkSurface(document)).toBe(false);
    expect(isWorkSurface({} as EventTarget)).toBe(false);
  });

  it('exposes the exclusion list as one selector', () => {
    // The count is here to make an addition deliberate: every member is a
    // surface that owns touch behaviour, and the cases above say why each one
    // is on the list.
    expect(WORK_SURFACE_SELECTOR.split(', ')).toHaveLength(6);
    expect(element('<div class="cm-editor"></div>', '.cm-editor').matches(WORK_SURFACE_SELECTOR)).toBe(true);
  });
});

describe('isInteractiveOwner (#2724)', () => {
  const owned: Array<[string, string, string]> = [
    ['a button', '<button type="button">Sessions</button>', 'button'],
    ['an input', '<form><input /></form>', 'input'],
    ['a select', '<form><select></select></form>', 'select'],
    ['a textarea', '<form><textarea></textarea></form>', 'textarea'],
    ['a link', '<a href="/workspace">Workspace</a>', 'a'],
    ['a contenteditable region', '<div contenteditable="true"><span></span></div>', 'span'],
    ['a role=button control', '<div role="button"><span></span></div>', 'span'],
    ['an open dialog', '<div role="dialog"><div class="body"></div></div>', '.body'],
    ['an alert dialog', '<div role="alertdialog"><button>Discard</button></div>', 'button'],
    [
      'the expanded Capsule Peek',
      '<div role="region" data-testid="capsule-capability-projection"><span></span></div>',
      'span',
    ],
    [
      'the capability capsule row',
      '<nav data-testid="workspace-capability-capsule"><div data-testid="workspace-capability-scroll"></div></nav>',
      '[data-testid="workspace-capability-scroll"]',
    ],
    ['an explicit swipe owner', '<div data-swipe-owner><span></span></div>', 'span'],
  ];

  it.each(owned)('reports %s as an interactive owner', (_name, html, selector) => {
    expect(isInteractiveOwner(element(html, selector))).toBe(true);
  });

  const free: Array<[string, string, string]> = [
    ['shell chrome', '<div class="shell-chrome"></div>', '.shell-chrome'],
    ['the xterm surface', '<div data-terminal-viewport><div class="xterm"></div></div>', '.xterm'],
    ['the CodeMirror editor', '<div class="cm-editor"><div class="cm-content"></div></div>', '.cm-content'],
    ['the capsule composer root', '<div data-testid="terminal-capsule"><span></span></div>', 'span'],
  ];

  it.each(free)('does not report %s as an interactive owner', (_name, html, selector) => {
    expect(isInteractiveOwner(element(html, selector))).toBe(false);
  });

  it('resolves a text node through its parent element', () => {
    const host = element('<button type="button">Sessions</button>', 'button');
    const text = host.firstChild;

    expect(text).not.toBeNull();
    expect(isInteractiveOwner(text)).toBe(true);
  });

  it('treats an unclassifiable target as not interactive', () => {
    expect(isInteractiveOwner(null)).toBe(false);
    expect(isInteractiveOwner(document)).toBe(false);
    expect(isInteractiveOwner({} as EventTarget)).toBe(false);
  });

  it('exposes the always-owned set as one selector', () => {
    // Pinned so adding a control/panel owner is a decision. The work-surface
    // rule may yield a 28px band; these may not, because the touch the user
    // aimed at a control or a nested scroller is that owner's.
    expect(INTERACTIVE_OWNER_SELECTOR.split(', ')).toHaveLength(12);
  });
});

describe('hasActiveSelectionWithin (#2724)', () => {
  function selectContents(host: Element): void {
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = document.getSelection();
    if (!selection) {
      throw new Error('jsdom exposes getSelection');
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it('recognises a live selection inside the touched target', () => {
    const host = element('<div data-terminal-viewport><span>echo hello</span></div>', '[data-terminal-viewport]');
    document.body.appendChild(host);
    selectContents(host);

    expect(hasActiveSelectionWithin(host)).toBe(true);
    document.getSelection()?.removeAllRanges();
    host.remove();
  });

  it('does not claim a collapsed selection', () => {
    const host = element('<div data-terminal-viewport><span>echo hello</span></div>', '[data-terminal-viewport]');
    document.body.appendChild(host);
    const span = host.querySelector('span');
    if (!span) {
      throw new Error('fixture span missing');
    }
    const range = document.createRange();
    range.setStart(span.firstChild ?? span, 0);
    range.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    expect(hasActiveSelectionWithin(host)).toBe(false);
    document.getSelection()?.removeAllRanges();
    host.remove();
  });

  it('does not claim a selection elsewhere on the page', () => {
    const host = element('<div data-terminal-viewport><span>echo hello</span></div>', '[data-terminal-viewport]');
    const elsewhere = element('<div><span>other</span></div>', 'span');
    document.body.append(host, elsewhere);
    selectContents(elsewhere);

    expect(hasActiveSelectionWithin(host)).toBe(false);
    document.getSelection()?.removeAllRanges();
    host.remove();
    elsewhere.remove();
  });
});
