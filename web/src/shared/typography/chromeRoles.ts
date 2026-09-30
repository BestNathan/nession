import { cn } from '@/shared/lib/utils';

/** Canonical chrome typography roles (#1216). */
export type ChromeTypographyRole =
  | 'title'
  | 'primary'
  | 'body'
  | 'secondary'
  | 'metadata'
  | 'caption'
  | 'code';

/** Literal class fragments so design inventory can resolve token consumers. */
const ROLE_SIZE_CLASS: Record<ChromeTypographyRole, string> = {
  title: 'text-[length:var(--typography-title-size)]',
  primary: 'text-[length:var(--typography-primary-size)]',
  body: 'text-[length:var(--typography-body-size)]',
  secondary: 'text-[length:var(--typography-secondary-size)]',
  metadata: 'text-[length:var(--typography-metadata-size)]',
  caption: 'text-[length:var(--typography-caption-size)]',
  code: 'text-[length:var(--typography-code-size)]',
};

const ROLE_WEIGHT_CLASS: Record<ChromeTypographyRole, string> = {
  title: 'font-[number:var(--typography-title-weight)]',
  primary: 'font-[number:var(--typography-primary-weight)]',
  body: 'font-[number:var(--typography-body-weight)]',
  secondary: 'font-[number:var(--typography-secondary-weight)]',
  metadata: 'font-[number:var(--typography-metadata-weight)]',
  caption: 'font-[number:var(--typography-caption-weight)]',
  code: 'font-[number:var(--typography-code-weight)]',
};

const ROLE_LINE_HEIGHT_CLASS: Record<ChromeTypographyRole, string> = {
  title: 'leading-[var(--typography-title-line-height)]',
  primary: 'leading-[var(--typography-primary-line-height)]',
  body: 'leading-[var(--typography-body-line-height)]',
  secondary: 'leading-[var(--typography-secondary-line-height)]',
  metadata: 'leading-[var(--typography-metadata-line-height)]',
  caption: 'leading-[var(--typography-caption-line-height)]',
  code: 'leading-[var(--typography-code-line-height)]',
};

function roleMetricClasses(role: ChromeTypographyRole): string {
  return cn(ROLE_SIZE_CLASS[role], ROLE_WEIGHT_CLASS[role], ROLE_LINE_HEIGHT_CLASS[role]);
}

/** Product sans at the role's canonical size, weight, and leading. */
export function chromeSansRole(role: ChromeTypographyRole): string {
  return cn(roleMetricClasses(role), 'font-sans');
}

/** Technical mono at the role's canonical size, weight, and leading. */
export function chromeMonoRole(role: ChromeTypographyRole): string {
  return cn(roleMetricClasses(role), 'font-mono');
}
