export function findAppExperienceClass(value, metadata) {
  if (typeof value !== 'string' || !metadata.experienceAppClasses?.length) {
    return null;
  }
  for (const token of value.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const base = token.includes(':') ? token.split(':').pop() ?? token : token;
    if (metadata.experienceAppClasses.includes(base)) {
      return base;
    }
  }
  return null;
}

export default function noCrossExperienceTokenRule(metadata) {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'Disallow App experience utility classes in Web TSX',
      },
      schema: [],
    },
    create(context) {
      return {
        Literal(node) {
          if (typeof node.value !== 'string') {
            return;
          }
          const hit = findAppExperienceClass(node.value, metadata);
          if (hit) {
            context.report({
              node,
              message: `App experience class "${hit}" cannot be used in Web components.\n\nnession/no-cross-experience-token`,
            });
          }
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) {
            const hit = findAppExperienceClass(quasi.value.raw, metadata);
            if (hit) {
              context.report({
                node: quasi,
                message: `App experience class "${hit}" cannot be used in Web components.\n\nnession/no-cross-experience-token`,
              });
            }
          }
        },
      };
    },
  };
}
