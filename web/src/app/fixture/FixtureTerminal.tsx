import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  cellDimensionsOf,
  gridFor,
  type PixelSize,
} from '@/platform/terminal-runtime/grid';
import {
  NESSION_TERMINAL_THEME,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
} from '@/platform/terminal-runtime/ThemeManager';
import { cn } from '@/shared/lib/utils';
import { DEFAULT_FONT } from '@/platform/terminal-runtime/instance/TerminalInstance';
import { detectProfile, PROFILES } from '@/platform/terminal-runtime/DeviceProfile';
import {
  terminalViewportBoxClass,
  terminalViewportInsetClass,
} from '@/product/terminal/components/TerminalViewport';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';
import type { TerminalChrome } from '@/app/ShellMain';

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
 * The capsule's capability contribution is handed in by the shell rather than
 * resolved here, so the fixture shows the same entry a real Session does. It
 * used to render with none, which meant the canonical screens showed a composer
 * no user with a Session ever sees — and left a capability projection with
 * nowhere in the fixture to open from (#838).
 *
 * `inputDisabled={false}` is deliberate: `disabled` reaches the capsule's
 * Buttons, which style as `disabled:opacity-50`, so a disabled capsule would
 * render half-transparent and the baselines would capture a state no user
 * sees. Sends are inert anyway — `controller` is null, and
 * `TerminalSurface.capsuleSendText` routes through `controller?.handleInput`.
 *
 * The font stack, the type metrics and the contrast ratio come from the
 * runtime rather than xterm's defaults for the same reason. A bare
 * `new Terminal()` renders in `courier-new`, so the baseline would pin a
 * typeface the product never uses — and cell metrics follow the font, so the
 * terminal's cols/rows would be measured against the wrong one. Size and
 * leading are the device profile's, selected the same way
 * `useTerminalOrchestration` selects them, so a baseline at a narrow viewport
 * pins the App metrics and a wide one pins Web's instead of one hardcoded size
 * standing in for both.
 */
export function FixtureTerminal({
  chrome,
  experience,
}: {
  chrome?: TerminalChrome;
  /** Which experience's capsule to render — the same prop the real shell passes. */
  experience: CapsuleExperience;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) {
      return;
    }
    const metrics = PROFILES[detectProfile(window.innerWidth)];
    const term = new Terminal({
      theme: NESSION_TERMINAL_THEME,
      fontFamily: DEFAULT_FONT,
      fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight,
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
    // Sized the way the product sizes it — `gridFor`, from the container's
    // **content box**. `FitAddon` stood here and measured the parent's border
    // box, so the `--terminal-pad-x` inset was never subtracted: the grid came
    // out 11px wider than the well, 14px of inset on the left and 3px on the
    // right, in every App baseline (#1092). The arithmetic is shared with
    // `ResizeController` rather than reimplemented, so the fixture and the
    // product cannot drift again; only the *observation* differs, because a
    // static fixture has no transport to publish cols/rows to and nothing to
    // debounce.
    term.open(host);

    let size: PixelSize | null = null;
    let written = false;
    let frame = 0;
    const applyGrid = () => {
      if (size === null) {
        return;
      }
      const grid = gridFor(size, cellDimensionsOf(term));
      if (grid === null) {
        return;
      }
      term.resize(grid.cols, grid.rows);
      // Written once the grid is right, rather than before sizing it. A write
      // at xterm's 80x24 default followed by a resize leaves the buffer to
      // reflow, and a line that was never wrapped is not re-split — the
      // fixture's longest line lost three characters off its tail that way.
      if (!written) {
        written = true;
        term.write(FIXTURE_BUFFER);
      }
    };

    // Deferred by a frame rather than applied in the callback, because the
    // observer's first fire lands before xterm's render service has measured a
    // cell — the same race `TerminalInstance` guards on its own accessor, where
    // `dimensions` throws until the renderer's first layout pass. The frame
    // puts the apply after that pass, so the first grid and the write both use
    // real metrics. A zero-size host (first paint, and every test that mounts
    // the surface without laying it out) yields a degenerate grid and is
    // skipped until the observer reports a real size.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect === undefined) {
        return;
      }
      size = { width: rect.width, height: rect.height };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(applyGrid);
    });
    observer.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <TerminalSurface
      experience={experience}
      inputDisabled={false}
      controller={null}
      capsuleCapabilities={chrome?.capsuleCapabilities}
      capsuleProjection={chrome?.capsuleProjection}
    >
      {/* Same box and inset as the product's viewport, from the product's own
          class exports — the canonical screens have to draw the well the user
          gets, or the inset is protected by nothing. */}
      <div
        data-testid="fixture-terminal"
        data-terminal-viewport
        ref={ref}
        className={cn(terminalViewportBoxClass, terminalViewportInsetClass)}
      />
    </TerminalSurface>
  );
}
