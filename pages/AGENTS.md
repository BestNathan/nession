# Pages ownership — public observatory (Issue #1782)

This is a standalone, anonymous static project. All application code, visual language, design tokens, typography, CSS, navigation, icons and components live under \`pages/\`. There is **no dependency on \`web/\`**: no imports, copied components/tokens/styles, runtime auth, session state or WebSockets. It is intentionally a distinct visual design.

Pages consumes only versioned **public read-only projections** from canonical sources. Never publish raw prompts, tool input/output, Provider sessions, encrypted checkpoints, credentials, host/session identifiers, untrusted HTML or sensitive paths. An unknown measurement is \`null\`, not zero. Preserve source revision and generated-at, never infer SC Pass, realtime online state or orphan integrity from summaries.

All external repo links must be https://github.com/BestNathan/nession; render outside text with \`textContent\`, not dynamic \`innerHTML\`. Use \`node --test pages/tests/*.test.mjs\` for projection/security fixtures and \`node pages/scripts/build.mjs\` for a static Pages artifact. The Pages build has its own dependency-free Node 24 toolchain.
