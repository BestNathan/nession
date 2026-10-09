import { describe, expect, it } from 'vitest';
import * as roles from '@/app/experiences/app/appTypography';

/**
 * The App's role → custom property wiring (#1073, #1216).
 *
 * Metrics resolve under `[data-experience="app"]` via shared chrome role recipes.
 */
const ROLE_NAMES = [
  'title',
  'primary',
  'body',
  'secondary',
  'metadata',
  'caption',
  'code',
] as const;

const ROLES: [string, string][] = ROLE_NAMES.map((role) => [
  role,
  roles[`${role}AppClass` as keyof typeof roles] as string,
]);

describe('App typography role classes', () => {
  it('binds each role to its typography custom properties', () => {
    for (const [role, className] of ROLES) {
      expect(className, `${role} missing size binding`).toContain(
        `var(--nession-typography-${role}-size)`,
      );
      expect(className, `${role} missing weight binding`).toContain(
        `var(--nession-typography-${role}-weight)`,
      );
      expect(className, `${role} missing line-height binding`).toContain(
        `var(--nession-typography-${role}-line-height)`,
      );
    }
  });

  it('gives every role a distinct class, so two roles cannot share one recipe', () => {
    const bound = ROLES.map(([, className]) => className);
    expect(new Set(bound).size).toBe(ROLES.length);
  });

  it('declares each role in a binding name that marks the App experience', () => {
    const names = Object.keys(roles);
    expect(names).toHaveLength(ROLES.length);
    for (const name of names) {
      expect(name, `${name} does not mark its class App-scoped`).toMatch(/App/);
    }
  });
});
