/**
 * An App-only design token must not be referenced from code that renders on Web.
 *
 * The two experiences are asymmetric, and that asymmetry is what makes this a
 * real hazard rather than a style preference:
 *
 *   `emitAppExperienceRemap` writes every app leaf into `[data-experience="app"]`,
 *   while web leaves are written to `:root`. So `--touch-target-min` exists only
 *   inside the App experience, and `var(--touch-target-min)` elsewhere resolves
 *   to nothing — the declaration is dropped and the layout silently collapses.
 *   The reverse is not a hazard: a web-only token sits at `:root` and therefore
 *   resolves in both experiences.
 *
 * The token list is derived from the token source (`appOnlyVars`) and arrives
 * through generated lint metadata. It used to be a hand-written literal naming
 * `control-app-sm|md|lg` and `touch-target-min` — a naming scheme this pipeline
 * never emitted — and the rule matched whole whitespace-separated class tokens
 * rather than the `var(--x)` form the code actually uses. It therefore could not
 * fire on any input, and did not, for its whole life (#771).
 *
 * The scope bridge is the name of the binding holding the class string. An
 * App-only token is legitimate only where the class is App-scoped, and this
 * codebase already names those bindings that way — `capsuleShellAppOuterClass`
 * beside `capsuleShellWebOuterClass`. Naming is used instead of tracing render
 * paths because "does this element render on Web" is a runtime property of the
 * component tree and is not statically decidable; the binding name is the
 * author's own statement of that fact, and it is checkable.
 */

/** Names of the custom properties only the App experience defines. */
function appOnlyVarSet(metadata) {
  return new Set(metadata.experienceAppVars ?? []);
}

/**
 * The `var(--x)` references in `value` that point at App-only tokens.
 * Returns the offending custom property names, de-duplicated, in order.
 */
export function findCrossExperienceVars(value, metadata) {
  const appOnly = appOnlyVarSet(metadata);
  if (typeof value !== 'string' || appOnly.size === 0) {
    return [];
  }
  const found = [];
  for (const match of value.matchAll(/var\(--([a-zA-Z0-9-]+)/g)) {
    const name = match[1];
    if (appOnly.has(name) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * Whether a binding name marks its class string as App-scoped.
 *
 * `capsuleShellAppOuterClass` yes; `capsuleShellWebOuterClass` no. A class with
 * no enclosing named binding (written inline in JSX) is not marked, so it is
 * reported — the rule asks the author to say which experience it belongs to.
 */
export function isAppScopedBinding(name) {
  return typeof name === 'string' && name.includes('App');
}

function enclosingBindingName(sourceCode, node) {
  for (const ancestor of sourceCode.getAncestors(node).slice().reverse()) {
    if (ancestor.type === 'VariableDeclarator' && ancestor.id?.type === 'Identifier') {
      return ancestor.id.name;
    }
  }
  return null;
}

export default function noCrossExperienceTokenRule(metadata) {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Disallow App-only experience tokens in class bindings that are not App-scoped',
      },
      schema: [],
      messages: {
        violation: [
          'App-only token {{vars}} is referenced from "{{binding}}", which is not App-scoped.',
          '',
          'These custom properties are emitted only under [data-experience="app"], so',
          'outside the App experience they resolve to nothing and the declaration is',
          'dropped — a silent layout failure, not an error.',
          '',
          'owner:  design/tokens/experience/app.json',
          'repair: name the binding for the experience it belongs to (e.g. capsuleShellAppOuterClass),',
          '        or use a token both experiences define.',
          '',
          'nession/no-cross-experience-token',
        ].join('\n'),
      },
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();

      function check(node, value) {
        const vars = findCrossExperienceVars(value, metadata);
        if (vars.length === 0) {
          return;
        }
        const binding = enclosingBindingName(sourceCode, node);
        if (isAppScopedBinding(binding)) {
          return;
        }
        context.report({
          node,
          messageId: 'violation',
          data: {
            vars: vars.map((v) => `var(--${v})`).join(', '),
            binding: binding ?? '(no named binding)',
          },
        });
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
