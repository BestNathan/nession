/**
 * Repository-wide visual vocabulary boundary (#1451).
 *
 * Nession-owned CSS custom properties have one public spelling: --nession-*.
 * The legal list is generated from design/tokens, so this rule never owns a
 * second hand-written token registry. During migration the generated CSS keeps
 * old aliases alive for rendering compatibility; production source is not
 * allowed to consume those aliases.
 */

function normalizedPath(filename) {
  return String(filename ?? '').replace(/\\/g, '/');
}

function isForeignAdapter(filename) {
  const path = normalizedPath(filename);
  return (
    path.includes('/src/components/ui/') ||
    path.includes('/src/platform/editor/') ||
    path.includes('/src/platform/terminal-runtime/') ||
    path.endsWith('/src/product/terminal/components/TerminalViewport.tsx')
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

    if (canonical.has(name) || name.startsWith('nession-local-')) {
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
      };
    },
  };
}
