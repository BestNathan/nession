/**
 * LanguageId detection - VS Code-style language identifiers
 * This module provides unified language detection decoupled from CodeMirror grammar loading.
 *
 * Markdown is not decided here: it is delegated to `@/markdown`, which ranks
 * extension / MIME / basename signals above content and caps content-only
 * guesses. This module owns everything else — basenames, shebangs, extensions.
 */

import { detectMarkdownLanguage } from '@/markdown/detect';
import { AUTO_APPLY_CONFIDENCE, type LanguageDetection } from '@/markdown/types';

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

  // just — no CodeMirror grammar exists for it; makefile is the closest match
  // (tab-indented recipes under `target:` headers). Listing it here is what
  // keeps justfiles out of content sniffing, which used to read their `#`
  // comments as markdown headings.
  justfile: 'makefile',
  Justfile: 'makefile',
  '.justfile': 'makefile',

  // README files
  README: 'markdown',
  'README.md': 'markdown',
  'README.txt': 'markdown',
  'README.rst': 'markdown',

  // Conventionally plain text, and prone to misdetection: licences are full of
  // numbered lists and `---` rules. Pinning them blocks content sniffing.
  LICENSE: 'plaintext',
  LICENCE: 'plaintext',
  'LICENSE.txt': 'plaintext',
  COPYING: 'plaintext',
  NOTICE: 'plaintext',
  AUTHORS: 'plaintext',
  TODO: 'plaintext',

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

// Pattern-based rules (regex matches against basename)
// Runs AFTER basename matching but BEFORE extension matching.
export const PATTERN_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly language: LanguageId }> = [
  // .env variant files (.env.local, .env.production, etc.)
  { pattern: /^\.env\..+$/, language: 'plaintext' },
  // TypeScript declaration files (also caught by double-ext check, included for consistency)
  { pattern: /\.d\.ts$/, language: 'typescript' },
  // Dockerfile variants (case-insensitive, e.g. my-dockerfile, Dockerfile.dev)
  { pattern: /dockerfile/i, language: 'dockerfile' },
];

// Shebang interpreter → language mapping
const SHEBANG_INTERPRETERS: Record<string, LanguageId> = {
  bash: 'shellscript',
  sh: 'shellscript',
  zsh: 'shellscript',
  python: 'python',
  node: 'javascript',
  ruby: 'ruby',
  perl: 'perl',
};

/**
 * Detect language from a shebang line.
 *
 * Parses the first line of `content` for `#!` and maps common interpreters
 * to their LanguageId. Returns `null` if there is no shebang, the interpreter
 * is unrecognised, or content is empty.
 */
export function detectShebang(content: string): LanguageId | null {
  const newlineIdx = content.indexOf('\n');
  const firstLine = newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
  if (!firstLine.startsWith('#!')) {
    return null;
  }

  const rest = firstLine.slice(2).trim();
  if (rest.length === 0) {
    return null;
  }

  const parts = rest.split(/\s+/);
  // Take basename of the command path
  let cmd = parts[0];
  const lastSlash = cmd.lastIndexOf('/');
  if (lastSlash >= 0) {
    cmd = cmd.slice(lastSlash + 1);
  }

  // `env` forwards to the next argument
  if (cmd === 'env' && parts.length > 1) {
    cmd = parts[1];
    const envSlash = cmd.lastIndexOf('/');
    if (envSlash >= 0) {
      cmd = cmd.slice(envSlash + 1);
    }
  }

  // Strip version suffixes: python3.11 -> python, node18 -> node
  const base = cmd.replace(/[\d.]+$/, '');

  return SHEBANG_INTERPRETERS[base] ?? null;
}

/**
 * Detect language from filename alone (no content sniffing).
 *
 * Runs the filename-only rules in priority order:
 *   1. Basename matching (exact filename, e.g. "Makefile" -> 'makefile')
 *   2. Double extension matching (e.g. "foo.d.ts" -> 'typescript')
 *   3. Pattern rules (regex on basename, e.g. ".env.local" -> 'plaintext')
 *   4. Extension matching (e.g. ".ts" -> 'typescript')
 *
 * Returns `null` when nothing matched, so callers can decide what to try next.
 */
function detectLanguageFromFilename(filename: string): LanguageId | null {
  // Priority 1: Basename matching
  const basename = parseLangBasename(filename);
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // Priority 2: Double extension matching (e.g., .d.ts)
  if (basename.endsWith('.d.ts')) {
    return 'typescript';
  }

  // Priority 3: Pattern rules
  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(basename)) {
      return rule.language;
    }
  }

  // Priority 4: Extension matching
  const ext = parseLangExt(filename);
  if (ext && ext in EXTENSION_RULES) {
    return EXTENSION_RULES[ext];
  }

  return null;
}

/**
 * Unified language detection with a confidence score.
 *
 * Signals are consulted in descending trustworthiness:
 *   1. Markdown extension or `text/markdown` MIME type      → 0.95
 *   2. Filename rules — basename, double extension, pattern, extension → 0.9
 *   3. Conventional markdown basenames (CHANGELOG, CONTRIBUTING) → 0.9
 *   4. Shebang line                                          → 0.9
 *   5. Markdown content structures                            → 0.5 – 0.75
 *   6. Nothing                                                → plaintext, 0.0
 *
 * Content is last and capped: a content-derived result never reaches
 * AUTO_APPLY_CONFIDENCE, so callers cannot silently change how a file is
 * presented based on a guess. Step 2 runs before step 3 so a specific extension
 * wins over the basename convention — `readme.json` is JSON, not markdown.
 */
export function detectLanguageForFile(
  filename: string,
  content?: string,
  mimeType?: string,
): LanguageDetection {
  // Step 1: markdown by extension or MIME — the only signals strong enough to
  // outrank the generic filename tables.
  const markdownByMetadata = detectMarkdownLanguage(filename, undefined, mimeType);
  if (markdownByMetadata && markdownByMetadata.source !== 'filename') {
    return markdownByMetadata;
  }

  // Step 2: filename rules.
  const fromFilename = detectLanguageFromFilename(filename);
  if (fromFilename !== null) {
    return {
      language: fromFilename,
      confidence: 0.9,
      source: 'filename',
      reasons: ['filenameRule'],
    };
  }

  // Step 3: conventional markdown basenames (README, CHANGELOG, ...).
  if (markdownByMetadata) {
    return markdownByMetadata;
  }

  if (content !== undefined) {
    // Step 4: shebang — an executable script, whatever its comments look like.
    const shebangLang = detectShebang(content);
    if (shebangLang !== null) {
      return {
        language: shebangLang,
        confidence: 0.9,
        source: 'content',
        reasons: ['shebang'],
      };
    }

    // Step 5: markdown content structures, capped below auto-apply.
    const markdownByContent = detectMarkdownLanguage(filename, content, mimeType);
    if (markdownByContent) {
      return markdownByContent;
    }
  }

  // Step 6: nothing usable.
  return { language: 'plaintext', confidence: 0, source: 'fallback', reasons: [] };
}

/**
 * Detect language from filename, with optional content as a fallback signal.
 *
 * Thin wrapper over {@link detectLanguageForFile} that keeps only results
 * confident enough to act on. Content-derived markdown is deliberately dropped
 * here: it never clears AUTO_APPLY_CONFIDENCE, so an extensionless file is
 * loaded as plaintext rather than having a markdown grammar guessed for it.
 * Callers that want to *offer* markdown should use `detectLanguageForFile` and
 * read the confidence themselves.
 *
 * @param filename - File path or basename
 * @param content  - Optional file content; enables shebang detection.
 * @returns Detected LanguageId, defaults to 'plaintext'
 */
export function detectLanguage(filename: string, content?: string): LanguageId {
  const detection = detectLanguageForFile(filename, content);
  if (detection.confidence < AUTO_APPLY_CONFIDENCE) {
    return 'plaintext';
  }
  return detection.language as LanguageId;
}

