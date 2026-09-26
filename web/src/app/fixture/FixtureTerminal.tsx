import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  gridFor,
  measuredCellDimensionsOf,
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

/**
 * How many frames to keep re-deriving the grid for, after each change to the
 * well's box.
 *
 * A grid is a function of two inputs — the well's content box and xterm's cell
 * — and either can move after the other has been read. The box arrives through
 * the observer; the cell is sampled per frame, so this is the window in which a
 * cell that changes on its own is still caught. The cell is measured on xterm's
 * first layout pass and re-measured when the font finishes loading, which is a
 * change no resize accompanies.
 *
 * The bound exists so a terminal that never measures cannot spin the tab, and
 * it is generous rather than tight because stopping early leaves the grid sized
 * for a cell that is no longer drawn — a wrong terminal that a baseline would
 * capture. Half a second of idle frame callbacks costs a static page nothing.
 */
const SETTLE_FRAMES = 30;

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
    // Opened only once the font has settled. xterm measures one cell when it
    // opens and every glyph afterwards is laid out from it, so a terminal
    // opened against a not-yet-loaded face is fitted to the substitute's
    // advance — measured on CI at 844×390, fitted at 7.5px per column and
    // redrawn at 8px, 864px of terminal in an 816px well. `document.fonts.ready`
    // is the product's own signal for this (`TerminalInstance.warmTerminalFont`
    // and `remeasureOnFontLoad`); it resolves immediately when nothing is
    // pending, which is the common case. The face is self-hosted rather than a
    // CDN, so in CI it is a real fetch that the local cache hides.
    let disposed = false;
    let teardown: (() => void) | undefined;

    // `document.fonts` is absent outside a browser — jsdom, where the mount
    // tests run — and there is nothing to wait for there.
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    void fontsReady.then(() => {
      if (disposed) {
        return;
      }
      teardown = startFixtureTerminal(host);
    });

    return () => {
      disposed = true;
      teardown?.();
    };
    // Depends on nothing reactive: the host is a ref, and the profile comes from
    // the viewport. `experience` is deliberately not here — it selects which
    // capsule the surface renders, not how the grid is fitted.
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

/** Open, size and fill the fixture terminal. Returns its teardown. */
function startFixtureTerminal(host: HTMLDivElement): () => void {
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

  // Fitted, and re-fitted whenever one of the grid's two inputs moves. Without
  // this, xterm sits at its 80x24 default for the life of the page — so every
  // terminal baseline pinned a small terminal in the corner of a much larger
  // well instead of the surface the product actually shows, and the visual gate
  // was protecting a screen no user sees.
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
  let remaining = 0;
  // Fit to the cell xterm reports, and skip the grid it already has. Both
  // halves matter while the cell is still settling: a resize to the same
  // dimensions is churn, and the write below must not be repeated.
  const applyGrid = () => {
    if (size !== null) {
      const cell = measuredCellDimensionsOf(term);
      // A cell of `null` is "the renderer has not measured one yet", not a
      // measurement — and a grid fitted to the *fallback* is wrong
      // permanently, because nothing corrects it: the observer fires again
      // only when the host resizes. `FitAddon` declined to fit in this state
      // too, which is the guard this replaced.
      const grid = cell === null ? null : gridFor(size, cell);
      if (grid !== null && (term.cols !== grid.cols || term.rows !== grid.rows)) {
        term.resize(grid.cols, grid.rows);
      }
      // Written once the grid is right, rather than before sizing it. A write
      // at xterm's 80x24 default followed by a resize leaves the buffer to
      // reflow, and a line that was never wrapped is not re-split — the
      // fixture's longest line lost three characters off its tail that way.
      if (grid !== null && !written) {
        written = true;
        term.write(FIXTURE_BUFFER);
      }
    }
    // The cell, the grid's other input — sampled per frame for the settle
    // window rather than watched, because a re-measure is not an event xterm
    // publishes. See `SETTLE_FRAMES`.
    if (remaining > 0) {
      remaining -= 1;
      frame = requestAnimationFrame(applyGrid);
    }
  };

  // The well's box, one of the grid's two inputs. Re-armed on every fire, so a
  // resize long after the first grid still gets its own settle window. A
  // zero-size host (first paint, and every test that mounts the surface
  // without laying it out) yields a degenerate grid and is skipped until the
  // observer reports a real size.
  //
  // Deferred by a frame rather than applied in the callback, because the
  // observer's first fire lands before xterm's render service has measured a
  // cell — the same race `TerminalInstance` guards on its own accessor, where
  // `dimensions` throws until the renderer's first layout pass.
  const observer = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect;
    if (rect === undefined) {
      return;
    }
    size = { width: rect.width, height: rect.height };
    cancelAnimationFrame(frame);
    remaining = SETTLE_FRAMES;
    frame = requestAnimationFrame(applyGrid);
  });
  observer.observe(host);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    term.dispose();
  };
}