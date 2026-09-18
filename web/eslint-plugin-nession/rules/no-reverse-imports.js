/**
 * ESLint rule: no-reverse-imports
 *
 * Enforces the dependency direction between layers, so a module can only be
 * pulled in by something at or above it.
 *
 * The direction is #801's target vocabulary — `app` composes `product` /
 * `capabilities` / `platform` over `shared` — with the pre-#801 `features/` still
 * in the table while it is drained. `docs/architecture/web.md` owns the model and
 * the migration state; this file owns the executable half.
 *
 * ── What this rule is about, and what it is not ─────────────────────────────
 *
 * It protects the **runtime** dependency graph: which module can pull which
 * into the bundle. Two things are therefore out of scope, and both are exempt
 * below rather than left to accumulate:
 *
 *   - `import type` is erased at build time. It creates no runtime edge and
 *     cannot form a bundle cycle, so forcing type declarations to move down the
 *     layers would be churn that buys nothing. `import { type X }` is a *value*
 *     import statement and stays in scope.
 *   - test files are not shipped and are not part of that graph. A test wiring
 *     several layers together to exercise something is doing its job; the
 *     shipped graph is what this rule is for. (`no-capsule-magic-metrics` treats
 *     test files the same way.)
 *
 * ── The bug this rule shipped with (#783) ───────────────────────────────────
 *
 * `getSourceLayer` accepted the import path and checked it *first* — the same
 * input `getTargetLayer` reads. For any `@/` alias both therefore returned the
 * layer of the import *target*, the mismatch check short-circuited, and the rule
 * reported nothing at all. Every cross-layer import in this repo uses `@/`, so
 * it never fired once in its life. A source layer is a property of where the
 * code lives and must never be read from what the code imports.
 *
 * ── What counts as an edge (#788, #791) ─────────────────────────────────────
 *
 * A re-export is the same runtime edge as an import: `export { x } from '…'`
 * pulls the module into the bundle exactly as `import` does, so
 * `components/ui` re-exporting a feature is the same violation as importing it.
 * The rule had only an `ImportDeclaration` visitor, so that form passed. Then
 * `await import('…')` was uncovered for the same reason — a third syntax for
 * the identical edge.
 *
 * All four statements now share one `checkRuntimeEdge`. A local `export { x }`
 * with no `from` clause is skipped (it references no other module), as is a
 * non-literal dynamic import (`import(someVar)` names nothing statically
 * resolvable). The visit list is the whole taxonomy of runtime edges, so a
 * fifth form appearing should be a deliberate omission rather than an oversight.
 */

// Import direction map: which layers can import which.
//
// The #801 migration allowance lived here — `features` exempt in both
// directions while it was drained into the layers below. `features/` is now
// empty and deleted, so the allowance is gone with it, exactly as its comment
// promised: the layers are related by this table alone.
const ALLOWED_IMPORTS = {
  'app': ['product', 'capabilities', 'platform', 'extensions', 'core', 'shared'],
  // `capabilities` is #801's second target layer: a unit that can be
  // discovered, activated and contributed (Files, Env, Commands, Claude Code)
  // as a vertical slice, rather than a chunk of the product.
  //
  // One-way with `product`, and that is measured rather than assumed: six real
  // value imports go `product → capabilities` (the capsule surfaces quick
  // commands, the attach dialog offers env files) and **none** come back.
  // PRINCIPLE #3 is what says the direction is right — "capabilities should
  // naturally gain presence when they become relevant to the current context"
  // is a capability appearing *inside* a product context, not a product
  // appearing inside a capability. If a capability ever needs a Product
  // Pattern, that is the same decision `extensions ↔ capabilities` already
  // records, and it should be made then rather than pre-granted here.
  'capabilities': ['platform', 'core', 'shared'],
  // `product` is #801's first target layer: a module that means something in
  // Nession's product vocabulary (Session, Terminal, Workspace, Agent) rather
  // than one that merely implements something. It sits below `app` (the shell
  // composes it) and above the infrastructure. `core` is listed because it is
  // the pre-Phase-5 name for `platform` — when that convergence lands this
  // becomes `['platform', 'shared']` and nothing else about the layer changes.
  // `extensions` is in this list because the registry *is* the contribution
  // contract, not a peer to reach into: a Product Pattern rendering a slot
  // (`AgentDetail` renders `agent-detail`) is PRINCIPLE #5 working as designed —
  // Nession owns the structure, the contribution fills a hole in it. Reaching
  // into a capability's internals is the inversion; asking the registry for a
  // slot is not.
  'product': ['capabilities', 'platform', 'extensions', 'core', 'shared'],
  // `platform` is #801's fourth layer: the machinery beneath the product —
  // transport, runtime, attach, and framework-level code that carries no
  // product semantics (the Explorer file-tree framework, the Server plugin).
  // It sits above `shared` and below everything that means anything.
  //
  // It is not React-free as a layer; `core/terminal-runtime` is React-free as a
  // module, and that property is worth keeping where it already holds. Widening
  // the layer's definition to admit a UI framework is deliberate: #801's §7
  // convergence list describes where `platform` will *come from*
  // (`core/` + `runtime/` + `services/` + `atoms/` + owner-specific `lib/`),
  // not the whole of what it may hold.
  'platform': ['core', 'shared'],
  // `extensions/` is a rung of its own. It may reach `capabilities` because an
  // extension is the UI contribution *for* a capability —
  // `extensions/claude-code` renders the Claude Code capability. The mutual
  // allowance is deliberate and documented in docs/architecture/web.md: the
  // registry is consumed by app and capability code, and an extension composes
  // what it extends. A sanctioned cycle, not an oversight — do not "fix" it by
  // folding extensions into a layer, which would wrongly let `core` reach it.
  'extensions': ['capabilities', 'core', 'shared'],
  'core': ['shared'],
  'shared': [], // shared cannot import any business layer
};

// Physical directory -> layer. The legacy feature dirs (hooks/,
// session-first/, non-ui components/) were deleted in Phase 5 (#655);
// components/ now holds only the shared shadcn ui/ primitives.
//
// Verified against who *consumes* each directory, so these are not guesses:
// features import `atoms` (9 files) and `runtime` (8 files), so both must sit
// below features — which is where they already are. The reverse imports found
// by fixing this rule are real, not a mis-classification (#783).
//
// `markdown` is `shared`, decided by the same test rather than by its name: its
// consumers are `capabilities/files` (3 edges) *and* `lib/languageId` (2 edges), and
// a `shared` module importing it forces it to `shared` — shared is the bottom.
// The `markdown ↔ lib` cycle that results is deliberate and both files say so:
// general language detection needs markdown's ranked signals, and markdown
// cannot host the general tables without importing them back. Same layer, so
// the rule permits it; this entry is what makes that a decision rather than an
// accident (#793).
const LEGACY_TO_LAYER = {
  'components': 'shared', // components/ui only
  'lib': 'shared',
  'atoms': 'shared', // atoms are shared state
  'markdown': 'shared', // markdown pipeline — rationale in the note above
  'services': 'core', // services/socket, attachPrefs, deepLinkAttach
  'runtime': 'core',
  'core': 'core',
  'shared': 'shared',
  // `features` is deliberately absent: the directory is gone. A row for it would
  // be a layer that nothing can be in — and if someone recreates `src/features/`,
  // the completeness fixture fails until it is classified rather than letting it
  // fall silently into `unknown`.
  'app': 'app',
  // Outside the ladder proper; see ALLOWED_IMPORTS.extensions.
  'extensions': 'extensions',
  // #801's first target layer, filled one concept at a time: `agent`,
  // `session` and `terminal` live here now, plus Workspace's Product Pattern.
  // `capabilities` is the second. The migration state — which concepts have
  // moved and which have not — is tracked in docs/architecture/web.md.
  'product': 'product',
  // #801's second target layer, filled by the four contributable capabilities.
  'capabilities': 'capabilities',
  // #801's fourth target layer. Started early, with the two modules that are
  // infrastructure but were neither product, capability, nor helper — the
  // Explorer framework and the Server plugin. `core/`, `runtime/`, `services/`
  // and `atoms/` converge here in Phase 5.
  'platform': 'platform',
};

// Directories under `src/` that are deliberately not layers. Everything else
// must appear in LEGACY_TO_LAYER. A fixture asserts that against the real
// directory listing, in both directions, so a new `src/` directory cannot
// repeat the mistake #793 records: falling into `unknown`, which
// `checkRuntimeEdge` skips — unchecked in both directions while looking mapped.
const NON_LAYER_DIRS = {
  '__tests__': 'test files — exempt from this rule entirely (see isTestFile)',
  'test': 'vitest setup + shared mocks; imported only by test files',
};

// Modules that sit directly under `src/`, outside any layer directory. They are
// on real edges like anything else — `@/types` is imported by every layer, and
// `App.tsx` is the composition root — but a directory-shaped lookup misses them
// and returns `unknown`, which `checkRuntimeEdge` skips. `types.ts` is `shared`
// per `docs/architecture/web.md` ("shared root type barrel"); the two entries
// are the composition root, which is `app` by the same doc.
//
// Keyed by module name as written in an import (`@/types`), not by filename, so
// both `@/types` and a resolved `../types` land on the same entry.
const ROOT_FILE_LAYER = {
  App: 'app',
  main: 'app',
  types: 'shared',
  'vite-env': 'shared',
};

function isTestFile(filePath) {
  const normalized = (filePath ?? '').replace(/\\/g, '/');
  return (
    normalized.includes('/__tests__/') ||
    /\.(test|spec)\.[jt]sx?$/.test(normalized)
  );
}

/**
 * Layer of a module path — a directory under `src/`, or a file directly in it.
 *
 * Every module needs a layer. Anything this cannot place becomes `unknown`,
 * and `checkRuntimeEdge` skips on unknown, so an unplaced path is not
 * "unclassified", it is *unchecked* — in both directions, while looking
 * covered. That is the bug #793 records for directories, and the same hole
 * swallowed `../features/...` (relative targets) and `@/types` (root files).
 */
function layerOfPath(path) {
  const normalized = (path ?? '').replace(/\\/g, '/');
  const dir = normalized.match(/\/src\/([^/]+)\//);
  if (dir) {
    return LEGACY_TO_LAYER[dir[1]] ?? 'unknown';
  }
  const rootFile = normalized.match(/\/src\/([^/]+)$/);
  if (rootFile) {
    return ROOT_FILE_LAYER[rootFile[1]] ?? 'unknown';
  }
  return 'unknown';
}

/** The layer of the file *doing the importing*, from its own path. */
function getSourceLayer(currentFilePath) {
  return layerOfPath(currentFilePath);
}

/**
 * Resolve a relative specifier against the importing file, so it can be
 * classified like any other path. Returns a `src`-rooted path; extensionless
 * specifiers are fine because `layerOfPath` only reads the first segment.
 */
function resolveRelative(fromFile, specifier) {
  const segments = fromFile.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** The layer an import specifier points at, from the importing file's path. */
function getTargetLayer(importPath, currentFilePath) {
  // `@/x/y` and `../x/y` are the same lookup once normalised to a src path.
  if (importPath.startsWith('@/')) {
    return layerOfPath(`/src/${importPath.slice(2)}`);
  }
  if (importPath.startsWith('.')) {
    return layerOfPath(resolveRelative(currentFilePath, importPath));
  }
  return 'unknown';
}

/**
 * Report `node` when the module edge from the current file to `importPath`
 * points back up the layer order.
 *
 * Shared by all three statement forms so their alias handling and skip
 * conditions cannot drift apart — the divergence between visitors is how the
 * coverage gap in #788 survived: one check, one place.
 */
function checkRuntimeEdge(context, node, importPath, currentFilePath) {
  // A non-literal or absent source names no module we can resolve: a computed
  // dynamic import, or a local `export { x }`.
  if (typeof importPath !== 'string') {
    return;
  }

  // Skip external packages (no @/ prefix and not relative)
  if (!importPath.startsWith('@/') && !importPath.startsWith('.')) {
    return;
  }

  const sourceLayer = getSourceLayer(currentFilePath);
  const targetLayer = getTargetLayer(importPath, currentFilePath);

  // Skip if we can't determine layers
  if (sourceLayer === 'unknown' || targetLayer === 'unknown') {
    return;
  }

  // Check if the edge is allowed
  const allowedTargets = ALLOWED_IMPORTS[sourceLayer] || [];
  if (!allowedTargets.includes(targetLayer) && sourceLayer !== targetLayer) {
    context.report({
      node,
      messageId: 'reverseImport',
      data: {
        sourceLayer,
        targetLayer,
        allowed: allowedTargets.join(', '),
      },
    });
  }
}

// Exported for the fixture that asserts every `src/` directory is classified.
// The rule's own behaviour never reads them directly.
export { ALLOWED_IMPORTS, LEGACY_TO_LAYER, NON_LAYER_DIRS, ROOT_FILE_LAYER };

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce layered architecture import direction (app → features → core → shared)',
      category: 'Architecture',
      recommended: true,
    },
    schema: [],
    messages: {
      reverseImport: 'Reverse import detected: {{sourceLayer}} cannot import from {{targetLayer}}. Allowed: [{{allowed}}]',
    },
  },
  create(context) {
    const currentFilePath = context.getFilename();
    if (isTestFile(currentFilePath)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        // Erased at build time — no runtime edge, so no direction to enforce.
        if (node.importKind === 'type') {
          return;
        }
        checkRuntimeEdge(context, node, node.source?.value, currentFilePath);
      },

      // `export { x } from '…'` and `export { x }`. `source` is null in the
      // second form, which references no other module.
      ExportNamedDeclaration(node) {
        if (!node.source || node.exportKind === 'type') {
          return;
        }
        checkRuntimeEdge(context, node, node.source.value, currentFilePath);
      },

      // `export * from '…'` / `export * as ns from '…'` — always has a source.
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') {
          return;
        }
        checkRuntimeEdge(context, node, node.source?.value, currentFilePath);
      },

      // `await import('…')` — the same edge by a third syntax. Note `source` is
      // an *expression*, not a Literal: `import(someVar)` is not statically
      // resolvable, and checkRuntimeEdge's non-string guard leaves it alone
      // rather than guessing.
      ImportExpression(node) {
        checkRuntimeEdge(context, node, node.source?.value, currentFilePath);
      },
    };
  },
};
