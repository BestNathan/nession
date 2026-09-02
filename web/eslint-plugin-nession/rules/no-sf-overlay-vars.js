const SESSION_FIRST_GLOB = 'src/session-first/';
const CAPSULE_GLOB = 'src/session-first/capsule/';

function isSessionFirstShellFile(filename) {
  const normalized = filename.replace(/\\/g, '/');
  return (
    normalized.includes(SESSION_FIRST_GLOB) &&
    !normalized.includes(CAPSULE_GLOB) &&
    !normalized.includes('/__tests__/') &&
    !/\.(test|spec)\.[jt]sx?$/.test(normalized)
  );
}

export default function noSfOverlayVars() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Disallow legacy --sf-* CSS variables in session-first shell components',
      },
      schema: [],
      messages: {
        violation:
          'Use design/tokens/ generated vars (e.g. --shell-space-*, --motion-shell-*) — --sf-* overlay is retired.',
      },
    },
    create(context) {
      const filename = context.filename ?? '';
      if (!isSessionFirstShellFile(filename)) {
        return {};
      }

      function checkString(node, value) {
        if (typeof value === 'string' && /--sf-/.test(value)) {
          context.report({ node, messageId: 'violation' });
        }
      }

      return {
        Literal(node) {
          checkString(node, node.value);
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) {
            checkString(quasi, quasi.value.cooked ?? quasi.value.raw);
          }
        },
      };
    },
  };
}
