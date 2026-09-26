import { describe, expect, it } from 'vitest';
import * as roles from '@/app/experiences/app/appTypography';

/**
 * The App's role → custom property wiring (#1073).
 *
 * The expected strings are spelled out rather than derived: they are the
 * contract between the App's composition and
 * `design/tokens/experience/app.json`, and a test that read them from the same
 * constant the component uses would follow any edit instead of catching it.
 *
 * What this owns is the half jsdom cannot see. `getComputedStyle` there does not
 * resolve custom properties, so a rendering test can only assert that *a* class
 * is present, not that the class names a role which exists — a typo in the
 * variable name renders exactly like the correct one and resolves to nothing in
 * a browser. `nession/no-cross-experience-token` catches that for the two
 * App-only roles and cannot see the four shared ones at all.
 */
const ROLES: [string, string][] = [
  ['title', roles.titleAppClass],
  ['primary', roles.primaryAppClass],
  ['body', roles.bodyAppClass],
  ['secondary', roles.secondaryAppClass],
  ['metadata', roles.metadataAppClass],
  ['code', roles.codeAppClass],
];

describe('App typography role classes', () => {
  it('binds each role to its own App custom property', () => {
    for (const [role, className] of ROLES) {
      expect(className, `${role} does not bind --typography-${role}-size`).toBe(
        `text-[length:var(--typography-${role}-size)]`,
      );
    }
  });

  it('gives every role a distinct class, so two roles cannot share one size', () => {
    const bound = ROLES.map(([, className]) => className);
    expect(new Set(bound).size).toBe(ROLES.length);
  });

  it('declares each role in a binding name that marks the App experience', () => {
    // `--typography-title-size` and `--typography-body-size` are emitted only
    // under `[data-experience="app"]`, and the lint asks the binding name to
    // state that. Asserted on the exported names, so a rename that dropped the
    // marker fails here rather than silently turning that check into a no-op.
    const names = Object.keys(roles);
    expect(names).toHaveLength(ROLES.length);
    for (const name of names) {
      expect(name, `${name} does not mark its class App-scoped`).toMatch(/App/);
    }
  });
});
