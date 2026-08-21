/**
 * LanguageId detection - VS Code-style language identifiers
 * This module provides unified language detection decoupled from CodeMirror grammar loading.
 */

// 66 VS Code-style language identifiers
export type LanguageId =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'jsonc'
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'haskell'
  | 'elixir'
  | 'erlang'
  | 'clojure'
  | 'lua'
  | 'perl'
  | 'r'
  | 'julia'
  | 'dart'
  | 'groovy'
  | 'powershell'
  | 'shellscript'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'dockerfile'
  | 'makefile'
  | 'cmake'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'sql'
  | 'graphql'
  | 'diff'
  | 'log'
  | 'ini'
  | 'properties'
  | 'env'
  | 'git-commit'
  | 'git-rebase'
  | 'ignore'
  | 'latex'
  | 'tex'
  | 'vb'
  | 'fsharp'
  | 'ocaml'
  | 'nix'
  | 'terraform'
  | 'protobuf'
  | 'thrift'
  | 'vue'
  | 'svelte'
  | 'objective-c'
  | 'nginx'
  | 'vim'
  | 'prisma'
  | 'solidity';

// Basename priority rules (exact filename matches)
export const BASENAME_RULES: Record<string, LanguageId> = {
  // Docker
  Dockerfile: 'dockerfile',
  'dockerfile': 'dockerfile',

  // Make
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  makefile: 'makefile',

  // README files
  README: 'markdown',
  'README.md': 'markdown',
  'README.txt': 'markdown',
  'README.rst': 'markdown',

  // Ruby
  Gemfile: 'ruby',
  Rakefile: 'ruby',

  // Jenkins
  Jenkinsfile: 'groovy',

  // CMake
  'CMakeLists.txt': 'cmake',

  // Git
  '.gitignore': 'ignore',
  '.gitattributes': 'plaintext',
  '.gitmodules': 'plaintext',

  // Shell configs
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.profile': 'shellscript',
  '.bash_profile': 'shellscript',
  '.zprofile': 'shellscript',
};

// Extension-based language detection rules
export const EXTENSION_RULES: Record<string, LanguageId> = {
  // JavaScript/TypeScript
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescriptreact',
  mts: 'typescript',
  cts: 'typescript',

  // Python
  py: 'python',
  pyw: 'python',
  pyx: 'python',

  // Data formats
  json: 'json',
  jsonld: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',

  // Markup
  md: 'markdown',
  markdown: 'markdown',
  mkd: 'markdown',
  html: 'html',
  htm: 'html',

  // Styles
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  styl: 'css',

  // Shell
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ksh: 'shellscript',

  // Compiled languages
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  cs: 'csharp',
  fs: 'fsharp',
  m: 'objective-c',
  mm: 'objective-c',

  // Scripting languages
  rb: 'ruby',
  php: 'php',
  phtml: 'php',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  jl: 'julia',
  dart: 'dart',

  // Functional languages
  hs: 'haskell',
  exs: 'elixir',
  ex: 'elixir',
  erl: 'erlang',

  // Config files
  ini: 'ini',
  properties: 'properties',
  cfg: 'ini',
  conf: 'nginx',

  // Web frameworks
  vue: 'vue',
  svelte: 'svelte',

  // Database
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',

  // Infrastructure
  tf: 'terraform',
  hcl: 'terraform',
  proto: 'protobuf',
  nix: 'nix',
  dockerfile: 'dockerfile',
  cmake: 'cmake',

  // PowerShell
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',

  // Misc
  vim: 'vim',
  prisma: 'prisma',
  solidity: 'solidity',
  csv: 'plaintext',
  log: 'log',
  lock: 'plaintext',
  mod: 'plaintext',
  sum: 'plaintext',
};

/**
 * Parse the basename from a file path (language detection variant)
 *
 * Note: This differs from viewerRegistry.parseBasename() which uses split/pop.
 * This version uses lastIndexOf for explicit control over path parsing.
 *
 * Examples:
 *   "/path/to/file.txt" -> "file.txt"
 *   "file.txt" -> "file.txt"
 *   ".gitignore" -> ".gitignore"
 *   "" -> ""
 */
export function parseLangBasename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

/**
 * Parse the extension from a file path for language detection (case-sensitive)
 *
 * Note: This differs from viewerRegistry.parseExt() which:
 *   1. Lowercases the result (we preserve case for language detection)
 *   2. Returns "gitignore" for ".gitignore" (we return "" for dotfiles)
 *
 * The dotfile behavior is intentional: files like ".gitignore" are matched
 * by basename rules, not extension rules, in language detection.
 *
 * Examples:
 *   "file.txt" -> "txt"
 *   "file.test.ts" -> "ts"
 *   "Makefile" -> ""
 *   ".gitignore" -> "" (dotfile, no extension)
 *   ".bashrc" -> "" (dotfile, no extension)
 *   "file.MAKEFILE" -> "MAKEFILE" (case preserved)
 */
export function parseLangExt(path: string): string {
  const basename = parseLangBasename(path);
  const lastDot = basename.lastIndexOf('.');
  // No dot, or dot at position 0 (hidden file like .gitignore)
  if (lastDot <= 0) {
    return '';
  }
  return basename.slice(lastDot + 1);
}

/**
 * Detect language from filename
 *
 * Detection priority (execution order):
 *   1. Basename matching (exact filename matches, e.g., "Makefile" -> 'makefile')
 *   2. Double extension matching (e.g., "foo.d.ts" -> 'typescript')
 *   3. Extension matching (e.g., ".ts" -> 'typescript')
 *   4. Shebang detection (TODO: not implemented yet)
 *   5. Content-based detection (TODO: not implemented yet)
 *   6. Fallback to 'plaintext'
 *
 * @param filename - File path or basename
 * @returns Detected LanguageId, defaults to 'plaintext'
 */
export function detectLanguage(filename: string): LanguageId {
  // Priority 1: Basename matching
  const basename = parseLangBasename(filename);
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // Priority 2: Double extension matching (e.g., .d.ts)
  if (basename.endsWith('.d.ts')) {
    return 'typescript';
  }

  // Priority 3: Extension matching
  const ext = parseLangExt(filename);
  if (ext && ext in EXTENSION_RULES) {
    return EXTENSION_RULES[ext];
  }

  // TODO: Priority 4 - Shebang detection
  // TODO: Priority 5 - Content-based detection

  // Priority 6: Fallback
  return 'plaintext';
}
