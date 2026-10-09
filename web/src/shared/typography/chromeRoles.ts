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
  title: 'text-[length:var(--nession-typography-title-size)]',
  primary: 'text-[length:var(--nession-typography-primary-size)]',
  body: 'text-[length:var(--nession-typography-body-size)]',
  secondary: 'text-[length:var(--nession-typography-secondary-size)]',
  metadata: 'text-[length:var(--nession-typography-metadata-size)]',
  caption: 'text-[length:var(--nession-typography-caption-size)]',
  code: 'text-[length:var(--nession-typography-code-size)]',
};

const ROLE_WEIGHT_CLASS: Record<ChromeTypographyRole, string> = {
  title: 'font-[number:var(--nession-typography-title-weight)]',
  primary: 'font-[number:var(--nession-typography-primary-weight)]',
  body: 'font-[number:var(--nession-typography-body-weight)]',
  secondary: 'font-[number:var(--nession-typography-secondary-weight)]',
  metadata: 'font-[number:var(--nession-typography-metadata-weight)]',
  caption: 'font-[number:var(--nession-typography-caption-weight)]',
  code: 'font-[number:var(--nession-typography-code-weight)]',
};

const ROLE_LINE_HEIGHT_CLASS: Record<ChromeTypographyRole, string> = {
  title: 'leading-[var(--nession-typography-title-line-height)]',
  primary: 'leading-[var(--nession-typography-primary-line-height)]',
  body: 'leading-[var(--nession-typography-body-line-height)]',
  secondary: 'leading-[var(--nession-typography-secondary-line-height)]',
  metadata: 'leading-[var(--nession-typography-metadata-line-height)]',
  caption: 'leading-[var(--nession-typography-caption-line-height)]',
  code: 'leading-[var(--nession-typography-code-line-height)]',
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


export type ChromeLabelRole = Extract<ChromeTypographyRole, 'metadata' | 'caption'>;

/** Uppercase quiet label: canonical chrome metrics plus owned tracking. */
export function chromeLabelRole(role: ChromeLabelRole = 'metadata'): string {
  return cn(
    chromeSansRole(role),
    'uppercase tracking-[var(--nession-typography-label-tracking)]',
  );
}

/** Technical uppercase label with the same owned tracking treatment. */
export function chromeMonoLabelRole(role: ChromeLabelRole = 'metadata'): string {
  return cn(
    chromeMonoRole(role),
    'uppercase tracking-[var(--nession-typography-label-tracking)]',
  );
}
