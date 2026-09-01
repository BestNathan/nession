import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import nession from './eslint-plugin-nession/index.js'

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'eslint-plugin-nession/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      nession,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'nession/no-primitive-tokens': 'error',
      'nession/no-cross-experience-token': 'error',
      'nession/no-capsule-magic-metrics': 'error',

      // ── Code quality limits ──────────────────────────────────────────
      complexity:    ['error', 20],
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true }],
      'max-depth':   ['error', 4],
      'max-params':  ['error', 4],

      // ── Best practices (from VS Code) ─────────────────────────────────
      curly:                       'error',
      eqeqeq:                      'error',
      'no-eval':                   'error',
      'no-throw-literal':          'error',
      'no-var':                    'error',
      'no-debugger':               'error',
      'no-duplicate-imports':      'warn',
      'prefer-const':              ['warn', { destructuring: 'all' }],
      'no-restricted-globals':     ['warn',
        'name', 'length', 'event', 'closed', 'external',
        'status', 'origin', 'orientation', 'context',
      ],

      // ── TypeScript-specific ───────────────────────────────────────────
      '@typescript-eslint/no-explicit-any':              'warn',
      '@typescript-eslint/consistent-generic-constructors': ['warn', 'constructor'],
      '@typescript-eslint/no-unused-expressions':        ['warn', { allowTernary: true }],

      // ── Naming convention ─────────────────────────────────────────────
      // variables/functions/methods → camelCase, classes/interfaces/types → PascalCase, constants → UPPER_CASE
      // Exceptions: leading _ for private/unused, snake_case for API protocol types
      '@typescript-eslint/naming-convention': ['warn',
        // Top-level constants: allow all conventions (real constants like MAX_DELAY are opt-in)
        { selector: 'variable', modifiers: ['const', 'global'], format: ['camelCase', 'PascalCase', 'UPPER_CASE'] },
        // React components (function name starts with uppercase): PascalCase
        { selector: 'function', format: ['PascalCase'], filter: { regex: '^[A-Z]', match: true } },
        // Regular functions, variables, parameters: camelCase, allow _ prefix
        { selector: 'function', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'PascalCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        // Class, Interface, Type alias, Enum: PascalCase
        { selector: 'class', format: ['PascalCase'] },
        { selector: 'interface', format: ['PascalCase'] },
        { selector: 'typeAlias', format: ['PascalCase'] },
        { selector: 'enum', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        // Class members: camelCase, allow _ prefix
        { selector: 'classMethod', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'classProperty', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
        // Allow destructured names from external libs
        { selector: 'variable', modifiers: ['destructured'], format: null },
        // Object literal properties follow their own convention
        { selector: 'objectLiteralProperty', format: null },
        // Type members: camelCase OR snake_case (API protocol types use snake_case)
        { selector: 'typeProperty', format: ['camelCase', 'snake_case', 'UPPER_CASE'], leadingUnderscore: 'allow' },
      ],

    },
  },

  // ── Test files ───────────────────────────────────────────────────────
  {
    files: ['**/__tests__/**', '**/*.test.*', '**/*.spec.*'],
    rules: {
      'max-lines-per-function': 'off',
      'nession/no-capsule-magic-metrics': 'off',
    },
  },

  // ── Terminal xterm.js integration ────────────────────────────────────
  {
    files: ['src/components/Terminal.tsx'],
    rules: {
      'max-lines-per-function': ['error', { max: 450, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── Complex components with many sub-components and hooks ────────────
  {
    files: ['src/components/FileBrowser.tsx', 'src/components/TerminalView.tsx', 'src/terminal/components/TerminalWorkspace.tsx'],
    rules: {
      'max-lines-per-function': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── App entry point ───────────────────────────────────────────────────
  // main.tsx is the bootstrap file; its Root wrapper hosts a media-query
  // hook and is never HMR-mounted, so the fast-refresh export rule
  // doesn't apply.
  {
    files: ['src/main.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  {
    files: [
      'src/terminal/ThemeManager.ts',
      'src/terminal/__tests__/unit/ThemeManager.test.ts',
    ],
    rules: {
      'nession/no-primitive-tokens': 'off',
    },
  },
)
