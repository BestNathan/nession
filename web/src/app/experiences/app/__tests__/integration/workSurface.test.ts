import { describe, it, expect } from 'vitest';
import { WORK_SURFACE_SELECTOR, isWorkSurface } from '../../workSurface';

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
    expect(WORK_SURFACE_SELECTOR.split(', ')).toHaveLength(5);
    expect(element('<div class="cm-editor"></div>', '.cm-editor').matches(WORK_SURFACE_SELECTOR)).toBe(true);
  });
});
