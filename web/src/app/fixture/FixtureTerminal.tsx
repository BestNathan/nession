import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { NESSION_TERMINAL_THEME } from '@/core/terminal-runtime/ThemeManager';
import { TerminalSurface } from '@/features/terminal/TerminalSurface';

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
 */
export function FixtureTerminal() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: NESSION_TERMINAL_THEME,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    });
    term.open(ref.current as HTMLDivElement);
    term.write(FIXTURE_BUFFER);
    return () => term.dispose();
  }, []);

  return (
    <TerminalSurface inputDisabled={false} controller={null}>
      <div data-testid="fixture-terminal" ref={ref} className="h-full w-full" />
    </TerminalSurface>
  );
}
