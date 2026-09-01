import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { CATPPUCCIN_MOCHA } from '@/terminal';

const FIXTURE_BUFFER = [
  '$ git status --short',
  ' M web/src/session-first/patterns/SessionHeader.tsx',
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
 */
export function FixtureTerminal() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: CATPPUCCIN_MOCHA,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    });
    term.open(ref.current as HTMLDivElement);
    term.write(FIXTURE_BUFFER);
    return () => term.dispose();
  }, []);

  return <div data-testid="fixture-terminal" ref={ref} className="h-full w-full" />;
}
