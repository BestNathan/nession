# Terminal + Capsule Fidelity

Read when the product viewport includes Terminal, TUI, Terminal Keys, Capsule, Peek or terminal scrolling. Include [Web/App shell](web-app-shell.md) if showing the global frame.

## Reference sources

- [Terminal Surface pattern](../../../../docs/design/design-system/patterns/terminal-surface.md), [TerminalCapsule pattern](../../../../docs/design/design-system/patterns/terminal-capsule.md), [fixed-column sizing](../../../../docs/design/terminal/terminal-sizing.md).
- Composition: [TerminalRegion](../../../../web/src/app/TerminalRegion.tsx), [TerminalWell](../../../../web/src/app/TerminalWell.tsx), [TerminalSurface](../../../../web/src/product/terminal/patterns/TerminalSurface.tsx), [TerminalCapsule](../../../../web/src/product/terminal/capsule/TerminalCapsule.tsx), [TerminalViewport](../../../../web/src/product/terminal/components/TerminalViewport.tsx).
- Style owner: [capsuleStyles](../../../../web/src/product/terminal/capsule/capsuleStyles.ts), [generated CSS](../../../../design/generated/web.css), especially `--nession-terminal-*` and `--nession-terminal-capsule-*`.
- Deterministic actual rendering reference: [FixtureTerminal](../../../../web/src/app/fixture/FixtureTerminal.tsx), which uses xterm and the production Terminal Surface.

## What must remain recognizable

- Terminal is a **flush, dominant work well**, not a rounded dashboard card with decorative outer border/padding.
- Fixed canonical columns are independent of device width; width adapts local font/grid fit and visible rows. Do not change line wrapping arbitrarily to fit a mobile mock; read current sizing rules rather than copying stale numeric values.
- Capsule is a **floating contextual interaction surface**, compact at rest. Additional keys, commands and capabilities appear through explicit disclosure, not an always-open full-width toolbar.
- When a capsule or panel expands, maintain readable newest output, scrollback reachability, keyboard/touch focus and clear distinction between terminal scrolling and App edge navigation.
- Peek and Workspace are product depths. A test-state inspector or scenario switch is **never** a Capsule/Peek and stays outside the product viewport.
- Web uses keyboard/xterm focus; App uses IME/touch and safe-area positioning. Do not shrink desktop controls indiscriminately.
- Only genuine Nession status/notices appear inside Terminal UI. Mock transport labels, source links, replay buttons and helper narration belong in the external harness.

## Behavior checks

Exercise initial state → expand → select/control/compose → collapse → scroll to history/newest output. Test relevant unavailable, focus, resize and touch states. Use sanitized representative TUI content. Clearly state in README whether this uses a real xterm fixture, a CSS grid approximation or plain text; a fake terminal does not prove xterm/tmux/PT﻿Y behavior.
