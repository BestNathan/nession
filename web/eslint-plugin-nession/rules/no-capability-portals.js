/**
 * A capability body may not portal out of the Peek host (#1347 SC-27).
 *
 * The host draws every body inside one element carrying `contain: paint`, which
 * clips paint, resolves `fixed`/`absolute` descendants against the host, and
 * keeps a descendant's z-index inside the host's stacking context. A React
 * portal is **not a descendant of that element** — it mounts wherever the
 * portal target says, typically `document.body` — so containment cannot clip,
 * scope, or constrain it. The re-review of #1347 measured exactly the gap:
 * "contain-paint cannot constrain portals; no enforceable plugin gate", and
 * held SC-27 at Fail until an escape is *rejected* rather than merely absent
 * from today's bodies.
 *
 * This rule is that gate. It is deliberately the enforceable subset — the same
 * posture `no-ui-product-imports` takes — rather than a second architecture
 * model:
 *
 *   - `import { createPortal }` (any alias, any source: a re-export is
 *     laundering, not permission) is reported at the import;
 *   - `ReactDOM.createPortal` through a default or namespace `react-dom`
 *     import is reported at the member expression;
 *   - the dynamic forms — `(await import('react-dom')).createPortal` and
 *     `const { createPortal } = await import('react-dom')` — are reported too,
 *     because a dynamic import is the same escape as a static one.
 *
 * What a body does instead is hand the host content: `actions.openDetail(detail)`
 * gives the body the *approved* overlay and keeps placement with the host
 * (#1120). A capability test may still mount a portal — proving what the host
 * does with one is a legitimate thing to assert — so test files are out of
 * scope, as they are for the other path-scoped rules here.
 *
 * Not covered, on purpose: a portal laundered through a rename
 * (`export { createPortal as makePortal }` upstream) and a hand-rolled
 * `document.body.appendChild`. The name is the detectable edge; the rule's
 * silence about the untraceable ones is a limit, not a clearance.
 */

function fromSrc(normalizedPath) {
  const marker = '/src/';
  const at = normalizedPath.lastIndexOf(marker);
  return at === -1 ? normalizedPath : normalizedPath.slice(at + 1);
}

function isCapabilityFile(filename) {
  const normalized = (filename ?? '').replace(/\\/g, '/');
  if (!fromSrc(normalized).startsWith('src/capabilities/')) {
    return false;
  }
  if (normalized.includes('/__tests__/')) {
    return false;
  }
  return !/\.(test|spec)\.[jt]sx?$/.test(normalized);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow React portals in capability-owned code — the Peek body stays inside the host (#1347 SC-27)',
    },
    schema: [],
    messages: {
      violation: [
        'Capability code mounts a portal ({{source}}), escaping the Peek host.',
        '',
        'The host clips and scopes its subtree with `contain: paint`, but a portal',
        'is not a descendant of that element — it cannot be constrained, which is',
        'the escape #1347 SC-27 forbids.',
        '',
        'owner:  web/src/capabilities/',
        'repair: hand the host content through `actions.openDetail(detail)`; the',
        '        host owns the overlay and its placement (#1120).',
        '',
        'nession/no-capability-portals',
      ].join('\n'),
    },
  },
  create(context) {
    const filename = context.filename ?? '';
    if (!isCapabilityFile(filename)) {
      return {};
    }

    /** Local names bound to the `react-dom` module object (default / namespace). */
    const reactDomBindings = new Set();

    function report(node, source) {
      context.report({ node, messageId: 'violation', data: { source } });
    }

    return {
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== 'string') {
          return;
        }
        for (const spec of node.specifiers ?? []) {
          if (spec.type === 'ImportSpecifier') {
            if (spec.imported?.name === 'createPortal') {
              report(spec, `\`${source}\``);
            }
          } else if (
            source === 'react-dom' &&
            (spec.type === 'ImportDefaultSpecifier' ||
              spec.type === 'ImportNamespaceSpecifier')
          ) {
            reactDomBindings.add(spec.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (node.computed || node.property?.name !== 'createPortal') {
          return;
        }
        const object = node.object;
        if (object.type === 'Identifier' && reactDomBindings.has(object.name)) {
          report(node, `${object.name}.createPortal`);
          return;
        }
        // `(await import('react-dom')).createPortal`
        if (
          object.type === 'AwaitExpression' &&
          object.argument?.type === 'ImportExpression' &&
          object.argument.source?.value === 'react-dom'
        ) {
          report(node, "import('react-dom').createPortal");
        }
      },
      VariableDeclarator(node) {
        // `const { createPortal } = await import('react-dom')`
        if (node.id?.type !== 'ObjectPattern') {
          return;
        }
        const init = node.init;
        if (
          init?.type !== 'AwaitExpression' ||
          init.argument?.type !== 'ImportExpression' ||
          init.argument.source?.value !== 'react-dom'
        ) {
          return;
        }
        for (const prop of node.id.properties ?? []) {
          const key = prop.key?.name ?? prop.key?.value;
          if (key === 'createPortal') {
            report(prop, "await import('react-dom')");
          }
        }
      },
    };
  },
};
