/**
 * Repository-wide visual vocabulary boundary (#1451).
 *
 * Nession-owned CSS custom properties have one public spelling: --nession-*.
 * The legal list is generated from design/tokens, so this rule never owns a
 * second hand-written token registry. During migration the generated CSS keeps
 * old aliases alive for rendering compatibility; production source is not
 * allowed to consume those aliases.
 */

const RAW_COLOR_RE = /\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl|oklch|oklab)\([^\]]+)\]/i;
const PALETTES = new Set([
  'red','green','blue','yellow','amber','orange','emerald','teal','cyan','sky',
  'indigo','violet','purple','fuchsia','pink','rose','zinc','neutral','slate',
  'gray','stone','lime','black','white',
]);
const VISUAL_COLOR_PREFIXES = new Set([
  'bg','text','border','ring','outline','fill','stroke','decoration','accent',
  'caret','divide','from','to','via',
]);
const TYPOGRAPHY_SCALE_RE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/;
const PROSE_SCALE_RE = /^prose-(?:sm|base|lg|xl|2xl)$/;
const TYPOGRAPHY_LITERAL_RE = /^text-\[(?:-?\d+(?:\.\d+)?)(?:px|rem|em)?\]$/;
const FONT_WEIGHT_RE = /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/;
const LEADING_RE = /^leading-(?:none|tight|snug|normal|relaxed|loose|\[[^\]]+\])$/;
const TRACKING_RE = /^tracking-(?:tighter|tight|normal|wide|wider|widest|\[[^\]]+\])$/;
const GENERIC_RADIUS_RE = /^rounded(?:-[trblsexy]{1,2})?(?:-(?:sm|md|lg|xl|[2-9]xl))?$/;
const RADIUS_LITERAL_RE = /^rounded(?:-[trblsexy]{1,2})?-\[(?:-?\d+(?:\.\d+)?)(?:px|rem|em)?\]$/;
const ELEVATION_RE = /^shadow(?:-(?:sm|md|lg|xl|2xl|inner))?$/;
const INLINE_COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^)]+\))$/i;
const STYLE_COLOR_PROPS = new Set([
  'color',
  'background',
  'backgroundColor',
  'borderColor',
  'outlineColor',
  'fill',
  'stroke',
]);

function baseClassToken(token) {
  const parts = String(token).split(':');
  return (parts.at(-1) ?? '').replace(/^!/, '');
}

function semanticColorNames(metadata) {
  return new Set(Object.keys(metadata.tailwindThemeBridges?.color ?? {}));
}

function semanticSpacingNames(metadata) {
  return new Set(Object.keys(metadata.tailwindThemeBridges?.spacing ?? {}));
}

function primitiveColorId(value) {
  const clean = value.split('/')[0];
  if (PALETTES.has(clean)) return clean;
  const match = clean.match(/^([a-z]+)-(\d+)$/);
  return match && PALETTES.has(match[1]) ? clean : null;
}

function semanticUtility(value, metadata) {
  const token = baseClassToken(value);
  if (token.includes('var(--nession-')) return true;

  const color = token.match(/^([a-z-]+)-(.+)$/);
  if (color && VISUAL_COLOR_PREFIXES.has(color[1])) {
    const name = color[2].split('/')[0];
    return semanticColorNames(metadata).has(name);
  }

  const spacing = token.match(/^(?:h|w|min-h|min-w|max-h|max-w|size|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-(.+)$/);
  return Boolean(spacing && semanticSpacingNames(metadata).has(spacing[1]));
}

function repairFor(kind) {
  switch (kind) {
    case 'typography':
      return 'use chromeSansRole(...) / chromeMonoRole(...) or the workload renderer owner';
    case 'radius':
      return 'use rounded-[var(--nession-radius-<role>)] or a canonical product recipe';
    case 'elevation':
      return 'use a Nession-owned elevation/material recipe such as var(--nession-elevation-*)';
    case 'color':
      return 'use a generated semantic utility such as bg-background/text-muted-foreground or a --nession-* token';
    default:
      return 'use the generated Nession visual vocabulary';
  }
}

export function findInlineStyleVisualViolations(node) {
  if (!node || node.type !== 'ObjectExpression') return [];
  const violations = [];

  for (const prop of node.properties) {
    if (prop.type !== 'Property' || prop.key?.type !== 'Identifier') continue;
    if (!STYLE_COLOR_PROPS.has(prop.key.name)) continue;
    if (prop.value?.type !== 'Literal' || typeof prop.value.value !== 'string') continue;

    const value = prop.value.value.trim();
    if (!INLINE_COLOR_RE.test(value)) continue;
    violations.push({
      node: prop.value,
      token: value,
      kind: 'color',
      repair: repairFor('color'),
    });
  }

  return violations;
}

export function findVisualUtilityViolations(value, metadata) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const violations = [];

  for (const raw of value.split(/\s+/).filter(Boolean)) {
    const token = baseClassToken(raw);
    if (!token || semanticUtility(token, metadata)) continue;

    if (RAW_COLOR_RE.test(token)) {
      violations.push({ token: raw, kind: 'color', repair: repairFor('color') });
      continue;
    }

    if (TYPOGRAPHY_SCALE_RE.test(token) || PROSE_SCALE_RE.test(token) || TYPOGRAPHY_LITERAL_RE.test(token) ||
        FONT_WEIGHT_RE.test(token) || LEADING_RE.test(token) || TRACKING_RE.test(token)) {
      violations.push({ token: raw, kind: 'typography', repair: repairFor('typography') });
      continue;
    }

    if ((GENERIC_RADIUS_RE.test(token) && token !== 'rounded-full' && token !== 'rounded-none') ||
        RADIUS_LITERAL_RE.test(token)) {
      violations.push({ token: raw, kind: 'radius', repair: repairFor('radius') });
      continue;
    }

    if (ELEVATION_RE.test(token) && token !== 'shadow-none') {
      violations.push({ token: raw, kind: 'elevation', repair: repairFor('elevation') });
      continue;
    }

    const color = token.match(/^([a-z-]+)-(.+)$/);
    if (color && VISUAL_COLOR_PREFIXES.has(color[1])) {
      const name = color[2].split('/')[0];
      if (primitiveColorId(name)) {
        violations.push({ token: raw, kind: 'color', repair: repairFor('color') });
      }
    }
  }

  return violations;
}

function normalizedPath(filename) {
  return String(filename ?? '').replace(/\\/g, '/');
}

export function isForeignAdapter(filename) {
  const path = normalizedPath(filename);
  return (
    path.includes('/src/components/ui/') ||
    path.includes('/src/platform/editor/') ||
    path.includes('/src/platform/terminal-runtime/') ||
    path.endsWith('/src/product/terminal/components/TerminalViewport.tsx')
  );
}

function isCapabilitySource(filename) {
  return normalizedPath(filename).includes('/src/capabilities/');
}

function capabilityCannotOwnVariable(name, metadata) {
  const cssVariable = `--${name}`;
  const owner = metadata.cssVariableOwners?.[cssVariable] ?? null;
  return (
    owner === 'pattern.terminal-capsule' ||
    name === 'nession-radius-capsule'
  );
}

function variableSets(metadata) {
  const canonical = new Set(
    (metadata.cssVariables ?? []).map((name) => String(name).replace(/^--/, '')),
  );
  const legacy = new Set(
    (metadata.legacyCssVariables ?? []).map((name) => String(name).replace(/^--/, '')),
  );
  return { canonical, legacy };
}

export function findVisualVariableViolations(value, metadata, filename = '') {
  if (typeof value !== 'string') return [];

  const { canonical, legacy } = variableSets(metadata);
  const adapter = isForeignAdapter(filename);
  const violations = [];

  for (const match of value.matchAll(/var\(--([A-Za-z0-9_-]+)/g)) {
    const name = match[1];

    if (canonical.has(name)) {
      if (isCapabilitySource(filename) && capabilityCannotOwnVariable(name, metadata)) {
        violations.push({
          name,
          kind: 'ownership',
          repair:
            'capability body content must consume the host slot/shared primitive; Capsule host geometry stays with the Nession product pattern',
        });
      }
      continue;
    }
    if (name.startsWith('nession-local-')) {
      continue;
    }

    if (legacy.has(name)) {
      violations.push({
        name,
        kind: 'legacy',
        repair: `var(--nession-${name})`,
      });
      continue;
    }

    if (!adapter) {
      violations.push({
        name,
        kind: name.startsWith('nession-') ? 'unknown-nession' : 'foreign',
        repair: name.startsWith('nession-')
          ? 'add the token to design/tokens and regenerate the vocabulary'
          : 'route this value through a --nession-* token or move the integration behind an approved adapter',
      });
    }
  }

  return violations;
}

export default function visualVocabularyRule(metadata) {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Require Nession-owned visual custom properties to use the generated --nession-* vocabulary',
      },
      schema: [],
      messages: {
        violation: [
          'DESIGN_SYSTEM_VIOLATION',
          '',
          'rule: nession/visual-vocabulary',
          'actual: var(--{{name}})',
          'kind: {{kind}}',
          'expected: a generated --nession-* variable or approved renderer/framework adapter',
          'owner: design/tokens/* + design/scripts/generate-tokens.mjs',
          'repair: {{repair}}',
        ].join('\n'),
        utilityViolation: [
          'DESIGN_SYSTEM_VIOLATION',
          '',
          'rule: nession/visual-vocabulary',
          'actual: {{token}}',
          'kind: {{kind}}',
          'expected: a generated semantic utility, Nession token, shared primitive, or product recipe',
          'owner: design/tokens/* + canonical visual grammar',
          'repair: {{repair}}',
        ].join('\n'),
        ownershipViolation: [
          'DESIGN_SYSTEM_VIOLATION',
          '',
          'rule: nession/visual-vocabulary',
          'actual: {{actual}}',
          'kind: ownership',
          'expected: capability contributes body/content; Nession product pattern owns host chrome',
          'owner: {{owner}}',
          'repair: {{repair}}',
        ].join('\n'),
      },
    },

    create(context) {
      const filename = context.filename ?? '';

      function check(node, value) {
        for (const violation of findVisualVariableViolations(value, metadata, filename)) {
          context.report({
            node,
            messageId: 'violation',
            data: violation,
          });
        }
        if (!isForeignAdapter(filename)) {
          for (const violation of findVisualUtilityViolations(value, metadata)) {
            context.report({
              node,
              messageId: 'utilityViolation',
              data: violation,
            });
          }
        }
      }

      return {
        Literal(node) {
          check(node, node.value);
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) {
            check(quasi, quasi.value.cooked ?? quasi.value.raw);
          }
        },
        JSXAttribute(node) {
          if (node.name.name !== 'style' || node.value?.type !== 'JSXExpressionContainer') {
            return;
          }
          for (const violation of findInlineStyleVisualViolations(node.value.expression)) {
            context.report({
              node: violation.node,
              messageId: 'utilityViolation',
              data: violation,
            });
          }
        },
        ImportDeclaration(node) {
          if (!isCapabilitySource(filename) || typeof node.source?.value !== 'string') {
            return;
          }
          const source = node.source.value;
          const forbiddenOwner =
            source === '@/product/terminal/capsule/capsuleStyles'
              ? 'pattern.terminal-capsule'
              : source === '@/product/workspace/patterns/workspaceNavigationStyles'
                ? 'pattern.workspace-navigation'
                : null;
          if (!forbiddenOwner) return;

          context.report({
            node: node.source,
            messageId: 'ownershipViolation',
            data: {
              actual: source,
              owner: forbiddenOwner,
              repair:
                'consume the host-provided slot/shared primitive instead of importing product host chrome into a capability',
            },
          });
        },
      };
    },
  };
}
