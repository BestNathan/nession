/**
 * ESLint rule: no-direct-xterm
 *
 * Enforces the Xterm Engine boundary from #2581:
 *
 *   app / product / capabilities / extensions / shared
 *     ── may import the business-neutral `TerminalEmulator` port
 *     ── may NOT import `@xterm/*`
 *     ── may NOT import the engine adapter module (`terminal-runtime/xterm/*`)
 *        or touch xterm's private `_core`
 *
 *   platform/terminal-runtime/xterm/  — the one production owner of xterm
 *   platform/terminal-runtime/xterm/XtermMetrics.ts — the ONE compatibility
 *     adapter allowed to read `_core` (measured cells)
 *   app/fixture/FixtureTerminal.tsx — the canonical fixture, allowed to import
 *     the engine's public barrel so it consumes the same construction rules as
 *     the product (SC-10)
 *
 * The mutable engine surface (`write`/`resize`) is reachable only through the
 * adapter module, and outside `platform/terminal-runtime` that module cannot be
 * imported — so Product/UI cannot bypass `SerializedTerminalWriter`. The
 * negative fixtures below prove every rejected case, and the positive ones
 * prove legitimate adapter access still passes.
 *
 * Test files are exempt, like they are for `no-reverse-imports`: they are not
 * shipped, and a test that drives the real xterm buffer is doing its job.
 */

const XTERM_PACKAGE = /^@xterm\//;
const XTERM_ENGINE_DIR = '/src/platform/terminal-runtime/xterm/';
const XTERM_METRICS_FILE = '/src/platform/terminal-runtime/xterm/XtermMetrics.ts';
const PLATFORM_RUNTIME_DIR = '/src/platform/terminal-runtime/';
const FIXTURE_FILE = '/src/app/fixture/FixtureTerminal.tsx';
const ENGINE_BARREL = '/src/platform/terminal-runtime/xterm';

function normalize(filePath) {
  return (filePath ?? '').replace(/\\/g, '/');
}

function isTestFile(filePath) {
  const path = normalize(filePath);
  return path.includes('/__tests__/') || /\.(test|spec)\.[jt]sx?$/.test(path);
}

/** Resolve a relative specifier to a `src`-rooted path. */
function resolveRelative(fromFile, specifier) {
  const segments = normalize(fromFile).split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** The engine module a specifier points at, or null. */
function engineSpecifier(importPath, filePath) {
  let resolved;
  if (importPath.startsWith('@/')) {
    resolved = `/src/${importPath.slice(2)}`;
  } else if (importPath.startsWith('.')) {
    resolved = resolveRelative(filePath, importPath);
  } else {
    return null;
  }
  return resolved.includes(ENGINE_BARREL) ? resolved : null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Keep raw xterm access inside the platform/terminal-runtime/xterm engine (#2581)',
      category: 'Architecture',
      recommended: true,
    },
    schema: [],
    messages: {
      rawImport:
        '@xterm import {{specifier}} is outside the Xterm Engine. '
        + 'owner:  web/src/platform/terminal-runtime/xterm/  '
        + 'repair: import the TerminalEmulator port from @/platform/terminal-runtime/emulator, '
        + 'or add the capability to the engine instead of reaching into xterm. '
        + 'Enabled by nession/no-direct-xterm.',
      engineImport:
        'Direct engine import {{specifier}} from {{layer}} crosses the Xterm Engine boundary. '
        + 'repair: consume the TerminalEmulator port through the controller '
        + '(registerLinkMatcher / read models), or add the capability to '
        + 'web/src/platform/terminal-runtime/xterm/ instead. Enabled by nession/no-direct-xterm.',
      privateCore:
        'xterm private `_core` access outside the single compatibility adapter. '
        + 'owner:  web/src/platform/terminal-runtime/xterm/XtermMetrics.ts  '
        + 'repair: read the measured cell through XtermMetrics / TerminalEmulator; do not '
        + 'reach into the render service. Enabled by nession/no-direct-xterm.',
    },
  },
  create(context) {
    const filePath = normalize(context.getFilename());
    if (isTestFile(filePath)) {
      return {};
    }

    const inXtermEngine = filePath.includes(XTERM_ENGINE_DIR);
    const inPlatformRuntime = filePath.includes(PLATFORM_RUNTIME_DIR);
    const isFixture = filePath.endsWith(FIXTURE_FILE);

    return {
      ImportDeclaration(node) {
        const specifier = node.source?.value;
        if (typeof specifier !== 'string') { return; }

        if (XTERM_PACKAGE.test(specifier)) {
          if (!inXtermEngine) {
            context.report({ node, messageId: 'rawImport', data: { specifier } });
          }
          return;
        }

        const engine = engineSpecifier(specifier, filePath);
        if (engine === null) { return; }
        // The owner and the rest of the platform may compose the engine. The
        // fixture may use the public barrel; nothing else may reach it.
        if (inPlatformRuntime) { return; }
        if (isFixture && engine === ENGINE_BARREL) { return; }
        if (isFixture && engine !== ENGINE_BARREL) {
          context.report({ node, messageId: 'engineImport', data: { specifier, layer: 'the canonical fixture' } });
          return;
        }
        context.report({ node, messageId: 'engineImport', data: { specifier, layer: 'Product/UI' } });
      },

      // `_core` is xterm's private render service. Reading it is allowed in
      // exactly one file; everywhere else the measured cell comes from the
      // engine's read model.
      MemberExpression(node) {
        if (filePath.endsWith(XTERM_METRICS_FILE)) { return; }
        const property = node.property;
        const name = node.computed
          ? (property?.type === 'Literal' ? property.value : undefined)
          : property?.name;
        if (name !== '_core') { return; }
        context.report({ node, messageId: 'privateCore' });
      },
    };
  },
};
