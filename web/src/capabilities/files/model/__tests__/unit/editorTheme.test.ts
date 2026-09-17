import { describe, it, expect } from 'vitest';
import { githubLight } from '@uiw/codemirror-theme-github';
import { EDITOR_THEME } from '../../editorTheme';

describe('EDITOR_THEME', () => {
  it('is the light theme, whatever the clock says', () => {
    // The predecessor of this module picked its theme from `getHours()` —
    // light 06:00-18:00, dark outside it — so the code editor went dark every
    // evening inside a light-only product. There is no time input any more;
    // this asserts the outcome rather than the mechanism, so a reintroduced
    // time dependency fails here.
    expect(EDITOR_THEME).toBe(githubLight);
  });
});
