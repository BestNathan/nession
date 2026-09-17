import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  NESSION_TERMINAL_THEME,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
} from '@/core/terminal-runtime/ThemeManager';
import {
  DEFAULT_FONT,
  DEFAULT_FONT_SIZE,
} from '@/core/terminal-runtime/instance/TerminalInstance';
import { TerminalSurface } from '@/product/terminal/TerminalSurface';

const FIXTURE_BUFFER = [
  '$ git status --short',
  ' M web/src/app/patterns/SessionHeader.tsx',
  ' M docs/design/visual-language.md',
  '$ cargo test -p nession-common 2>&1 | tail -3',
  'running 42 tests',
  'test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
  '',
  '$ npm run lint --workspace=web --silent',
  '✨  No lint errors found.',
  '',
  '─ sessions are terminal-first; chrome stays quiet ─',
].join('\r\n');

/**
 * Static, deterministic terminal for the canonical /fixture route.
 * Real xterm instance; no transport, no network. Phase 6 baseline source.
 *
 * Goes through the real `TerminalSurface`, so the canonical screens show the
 * same surface the product does: the well host plus the floating capsule.
 * Rendering the bare xterm here used to leave the capsule out of every
 * terminal baseline, which meant the visual gate did not protect the surface
 * users actually interact with — and left `pattern.terminal-capsule` with no
 * screen to assert against. There is no second capsule implementation here;
 * `capsuleExperience` inside the surface follows the viewport, so one fixture
 * yields the web and app variants as the contract matrix iterates viewports.
 *
 * `inputDisabled={false}` is deliberate: `disabled` reaches the capsule's
 * Buttons, which style as `disabled:opacity-50`, so a disabled capsule would
 * render half-transparent and the baselines would capture a state no user
 * sees. Sends are inert anyway — `controller` is null, and
 * `TerminalSurface.capsuleSendText` routes through `controller?.handleInput`.
 *
 * The font stack and the contrast ratio come from the runtime rather than
 * xterm's defaults for the same reason. A bare `new Terminal()` renders in
 * `courier-new`, so the baseline would pin a typeface the product never uses
 * — and cell metrics follow the font, so the terminal's cols/rows would be
 * measured against the wrong one.
 */
export function FixtureTerminal() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) {
      return;
    }
    const term = new Terminal({
      theme: NESSION_TERMINAL_THEME,
      fontFamily: DEFAULT_FONT,
      fontSize: DEFAULT_FONT_SIZE,
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    });

    // Fitted, and re-fitted when the well resizes. Without this, xterm sits at
    // its 80x24 default for the life of the page — so every terminal baseline
    // pinned a small terminal in the corner of a much larger well instead of
    // the surface the product actually shows, and the visual gate was
    // protecting a screen no user sees.
    //
    // `FitAddon` is already a dependency. The product path uses
    // `ResizeController` instead because it also has to publish cols/rows to the
    // transport and debounce the PTY notification; a static fixture has no
    // transport to notify.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.write(FIXTURE_BUFFER);

    // Guarded rather than caught: FitAddon throws below a 2x2 grid, and a
    // zero-size host is a real state here (first paint, and every test that
    // mounts the surface without laying it out).
    //
    // Deferred by a frame as well as guarded. `fit()` reads the cell metrics off
    // xterm's render service, and that service has no dimensions until the
    // renderer's first layout pass — measuring in the same tick as `open()`
    // throws inside `Viewport.syncScrollArea`. `TerminalInstance` guards the
    // same race on its own metrics accessor. The observer's own first fire
    // lands in that window too, so every fit goes through this path.
    let frame = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) {
          fit.fit();
        }
      });
    };
    scheduleFit();
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <TerminalSurface inputDisabled={false} controller={null}>
      <div data-testid="fixture-terminal" ref={ref} className="h-full w-full" />
    </TerminalSurface>
  );
}
