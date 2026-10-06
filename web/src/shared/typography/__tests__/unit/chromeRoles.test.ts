import { describe, expect, it } from 'vitest';
import {
  type ChromeTypographyRole,
  chromeMonoRole,
  chromeSansRole,
} from '@/shared/typography/chromeRoles';

const ROLES: ChromeTypographyRole[] = [
  'title',
  'primary',
  'body',
  'secondary',
  'metadata',
  'caption',
  'code',
];

describe('chrome typography role classes', () => {
  for (const role of ROLES) {
    it(`binds sans metrics for ${role}`, () => {
      const className = chromeSansRole(role);
      expect(className).toContain(`var(--nession-typography-${role}-size)`);
      expect(className).toContain(`var(--nession-typography-${role}-weight)`);
      expect(className).toContain(`var(--nession-typography-${role}-line-height)`);
      expect(className).toContain('font-sans');
    });

    it(`binds mono metrics for ${role}`, () => {
      const className = chromeMonoRole(role);
      expect(className).toContain(`var(--nession-typography-${role}-size)`);
      expect(className).toContain('font-mono');
    });
  }
});
