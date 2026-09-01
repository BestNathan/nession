const CAPSULE_GLOB = 'src/session-first/capsule/';

const ALLOWLIST = new Set([
  'src/session-first/capsule/capsuleStyles.ts',
  'src/session-first/capsule/components/ComposerMeasureMirror.tsx',
]);

const METRIC_PREFIX =
  '(?:h|w|size|gap|p|px|py|pt|pb|pl|pr|m|mx|my|mr|ml|mb|mt|min-h|min-w|max-h|max-w)';

const RULES = [
  {
    id: 'tailwind-text-scale',
    re: /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|\[[0-9])/,
    message: 'Use composer font tokens via capsuleStyles (text-[length:var(--composer-font-size)]).',
  },
  {
    id: 'tailwind-metric-scale',
    re: new RegExp(`\\b${METRIC_PREFIX}-(?:[1-9]\\d*|\\[[0-9])`),
    message: 'Use design token vars via capsuleStyles — no Tailwind numeric size scale.',
  },
  {
    id: 'max-lg-fork',
    re: /\bmax-lg:/,
    message: 'App/Web must differ by [data-experience] + tokens, not max-lg: breakpoints.',
  },
  {
    id: 'sf-legacy',
    re: /--sf-/,
    message: 'Retire --sf-* on the capsule path; use design/tokens/ + generated CSS vars.',
  },
  {
    id: 'numeric-arbitrary',
    re: /\[(?!length:var\()[0-9]+(?:\.\d+)?(?:px|rem|vh|vw|%)\]/,
    message: 'Arbitrary numeric dimensions forbidden — use length:var(--composer-*|--control-*|--icon-*).',
  },
  {
    id: 'font-via-line-height',
    re: /text-\[length:var\(--composer-line-height\)\]/,
    message: 'Font size must use --composer-font-size, not --composer-line-height.',
  },
];

function reportClassViolations(context, node, classString) {
  if (typeof classString !== 'string') {
    return;
  }
  for (const rule of RULES) {
    if (rule.re.test(classString)) {
      context.report({
        node,
        messageId: 'violation',
        data: { message: rule.message, ruleId: rule.id },
      });
    }
  }
}

function isCapsuleFile(filename) {
  const normalized = filename.replace(/\\/g, '/');
  return (
    normalized.includes(CAPSULE_GLOB) &&
    !normalized.includes('/__tests__/') &&
    !/\.(test|spec)\.[jt]sx?$/.test(normalized)
  );
}

function isAllowlisted(filename) {
  const normalized = filename.replace(/\\/g, '/');
  for (const allowed of ALLOWLIST) {
    if (normalized.endsWith(allowed)) {
      return true;
    }
  }
  return false;
}

export default function noCapsuleMagicMetrics() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'Disallow Tailwind numeric metrics in session-first capsule components',
      },
      schema: [],
      messages: {
        violation: '{{message}}\n\nnession/no-capsule-magic-metrics ({{ruleId}})',
        sideOffset:
          'Popover sideOffset must read --composer-popover-side-offset via readPopoverSideOffset(), not a numeric literal.',
      },
    },
    create(context) {
      const filename = context.filename ?? '';
      if (!isCapsuleFile(filename) || isAllowlisted(filename)) {
        return {};
      }

      return {
        Literal(node) {
          reportClassViolations(context, node, node.value);
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) {
            reportClassViolations(context, quasi, quasi.value.cooked ?? quasi.value.raw);
          }
        },
        JSXAttribute(node) {
          if (
            node.name?.name === 'sideOffset' &&
            node.value?.type === 'JSXExpressionContainer' &&
            node.value.expression?.type === 'Literal' &&
            typeof node.value.expression.value === 'number'
          ) {
            context.report({
              node: node.value.expression,
              messageId: 'sideOffset',
            });
          }
        },
      };
    },
  };
}
