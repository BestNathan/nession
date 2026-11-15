/**
 * The create-time ENV choice vocabulary (#3649).
 *
 * `inherit` and `replace` are the wire intents; the Web offers three choices
 * because `custom` and `none` are meaningfully different to the user even
 * though both send `replace`. `none` is the explicit empty replacement — the
 * legacy empty `env_files` with a Project means inherit.
 */
export type CreateEnvSelectionMode = 'inherit' | 'custom' | 'none';

/** Where the effective selection in the preview came from. */
export type CreateEnvOrigin = 'project' | 'custom' | 'none' | 'explicit';

export const ENV_MODE_OPTIONS: {
  value: CreateEnvSelectionMode;
  title: string;
  description: string;
}[] = [
  {
    value: 'inherit',
    title: 'Use Project defaults',
    description: "Inherit the Project's current ordered ENV references.",
  },
  {
    value: 'custom',
    title: 'Custom ENV selection',
    description: 'Replace Project defaults with only the files selected below.',
  },
  {
    value: 'none',
    title: 'No environment',
    description: 'Explicitly bind zero ENV files, even when the Project has defaults.',
  },
];

export const ENV_MODE_LABEL: Record<CreateEnvSelectionMode, string> = {
  inherit: 'Use Project defaults',
  custom: 'Custom ENV selection',
  none: 'No environment',
};

export const ENV_ORIGIN_LABEL: Record<CreateEnvOrigin, string> = {
  project: 'From Project defaults',
  custom: 'Explicit replacement',
  none: 'Explicit empty',
  explicit: 'Explicit selection',
};
