const PREFIXES = [
  'text',
  'bg',
  'border',
  'ring',
  'from',
  'to',
  'via',
  'fill',
  'stroke',
  'outline',
  'decoration',
  'accent',
  'caret',
  'divide',
  'shadow',
];

const PALETTES = [
  'red',
  'green',
  'blue',
  'yellow',
  'amber',
  'orange',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'zinc',
  'neutral',
  'slate',
  'gray',
  'stone',
  'lime',
  'black',
  'white',
];

const PREFIX_PATTERN = PREFIXES.join('|');
const PALETTE_PATTERN = PALETTES.join('|');

const CLASS_TOKEN_RE = new RegExp(
  `^(?:${PREFIX_PATTERN})-(?:${PALETTE_PATTERN})(?:-\\d+)?(?:\\/\\d+(?:\\.\\d+)?)?$`,
);

const ARBITRARY_COLOR_RE = /\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl|oklch)[^\]]+)\]/i;

const INLINE_COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl|oklch)\([^)]+\))$/i;

const STYLE_COLOR_PROPS = new Set([
  'color',
  'background',
  'backgroundColor',
  'borderColor',
  'outlineColor',
  'fill',
  'stroke',
]);

function formatSuggestions(metadata, primitiveId) {
  const entry = metadata[primitiveId];
  if (!entry?.suggestions?.length) {
    return 'Use a semantic or domain token instead.';
  }
  return `Suggested:\n${entry.suggestions.map((s) => `  ${s}`).join('\n')}`;
}

function primitiveIdFromToken(token) {
  const base = token.includes(':') ? token.split(':').pop() ?? token : token;
  const match = base.match(
    new RegExp(`^(?:${PREFIX_PATTERN})-(${PALETTE_PATTERN})(?:-(\\d+))?(?:\\/([\\d.]+))?$`),
  );
  if (!match) {
    return null;
  }
  const palette = match[1];
  const shade = match[2];
  return shade ? `${palette}-${shade}` : palette;
}

export function findPrimitiveInString(value, metadata) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  if (ARBITRARY_COLOR_RE.test(value)) {
    return {
      match: value.match(ARBITRARY_COLOR_RE)?.[0] ?? value,
      primitiveId: 'literal',
      message: 'Arbitrary literal colors are forbidden in class strings.',
    };
  }

  for (const token of value.split(/\s+/)) {
    if (!token) {
      continue;
    }
    if (ARBITRARY_COLOR_RE.test(token)) {
      return {
        match: token,
        primitiveId: 'literal',
        message: 'Arbitrary literal colors are forbidden in class strings.',
      };
    }
    if (!CLASS_TOKEN_RE.test(token.includes(':') ? token.split(':').pop() ?? token : token)) {
      continue;
    }
    const primitiveId = primitiveIdFromToken(token);
    if (!primitiveId) {
      continue;
    }
    const lookupId = metadata[primitiveId] ? primitiveId : `${primitiveId.split('-')[0]}-500`;
    return {
      match: token,
      primitiveId,
      message: formatSuggestions(metadata, metadata[primitiveId] ? primitiveId : lookupId),
    };
  }

  return null;
}

function reportMatch(context, node, hit) {
  const label =
    hit.primitiveId === 'literal'
      ? 'Literal color'
      : `Primitive color "${hit.primitiveId}"`;
  context.report({
    node,
    message: `${label} must not be used directly in product UI.\n\n${hit.message}\n\nnession/no-primitive-tokens`,
  });
}

function checkString(context, metadata, node, value) {
  const hit = findPrimitiveInString(value, metadata);
  if (hit) {
    reportMatch(context, node, hit);
  }
}

function checkStyleObject(context, node) {
  if (node.type !== 'ObjectExpression') {
    return;
  }
  for (const prop of node.properties) {
    if (prop.type !== 'Property' || prop.key.type !== 'Identifier') {
      continue;
    }
    if (!STYLE_COLOR_PROPS.has(prop.key.name)) {
      continue;
    }
    if (prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
      if (INLINE_COLOR_RE.test(prop.value.value.trim())) {
        reportMatch(context, prop.value, {
          match: prop.value.value,
          primitiveId: 'literal',
          message: 'Use CSS variables or Tailwind semantic/domain classes instead.',
        });
      }
    }
  }
}

export default function noPrimitiveTokensRule(metadata) {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'Disallow Tailwind palette and literal colors in product TSX',
      },
      schema: [],
    },
    create(context) {
      return {
        Literal(node) {
          if (typeof node.value === 'string') {
            checkString(context, metadata, node, node.value);
          }
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) {
            checkString(context, metadata, quasi, quasi.value.raw);
          }
        },
        JSXAttribute(node) {
          if (node.name.name !== 'style' || !node.value) {
            return;
          }
          if (node.value.type === 'JSXExpressionContainer') {
            checkStyleObject(context, node.value.expression);
          }
        },
      };
    },
  };
}
