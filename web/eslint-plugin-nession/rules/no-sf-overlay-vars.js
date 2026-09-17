// The shell used to live under `src/session-first/`. It moved to `src/app/`,
// and this glob was not moved with it — so the rule matched zero files and had
// silently stopped guarding the retired `--sf-*` vocabulary (issue #759). No
// `--sf-` variable remains anywhere in web/src, so restoring the scope changes
// no current verdict; it restores the guard against reintroducing one.
const APP_SHELL_GLOB = 'src/app/';

function isAppShellFile(filename) {
  const normalized = filename.replace(/\\/g, '/');
  return (
    normalized.includes(APP_SHELL_GLOB) &&
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
          'Disallow legacy --sf-* CSS variables in app-layer shell components',
      },
      schema: [],
      messages: {
        violation:
          'Use design/tokens/ generated vars (e.g. --shell-space-*, --motion-shell-*) — --sf-* overlay is retired.',
      },
    },
    create(context) {
      const filename = context.filename ?? '';
      if (!isAppShellFile(filename)) {
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
