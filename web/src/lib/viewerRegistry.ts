import { detectLanguage } from './languageId';

export type ViewerType = 'image' | 'video' | 'audio' | 'pdf' | 'markdown';

const EXT_VIEWER_MAP: Record<string, ViewerType> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
  pdf: 'pdf',
};

/** Extension → @uiw/codemirror-extensions-langs key (before resolveLangKey aliases). */
const EXT_LANG_MAP: Record<string, string> = {
  js: 'js', jsx: 'jsx', mjs: 'mjs', cjs: 'cjs',
  ts: 'ts', tsx: 'tsx', mts: 'mts', cts: 'cts',
  py: 'py', pyw: 'pyw', pyx: 'pyx',
  json: 'json', jsonld: 'jsonld',
  yaml: 'yaml', yml: 'yml',
  md: 'md', markdown: 'markdown', mkd: 'mkd',
  html: 'html', htm: 'htm',
  css: 'css', scss: 'scss', less: 'less', sass: 'sass', styl: 'styl',
  sh: 'sh', bash: 'bash', zsh: 'zsh', ksh: 'ksh', fish: 'fish',
  go: 'go',
  rs: 'rs',
  c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'h', hpp: 'hpp', hh: 'hh', hxx: 'hxx',
  sql: 'sql',
  xml: 'xml', xsd: 'xsd', xsl: 'xsl', svg: 'svg',
  toml: 'toml',
  ini: 'ini', in: 'in', properties: 'properties',
  env: 'env',
  java: 'java',
  rb: 'rb',
  php: 'php', phtml: 'phtml',
  swift: 'swift',
  kt: 'kt', kts: 'kts',
  scala: 'scala',
  hs: 'hs',
  exs: 'exs', ex: 'ex',
  clj: 'clj', cljs: 'cljs', cljc: 'cljc', edn: 'edn',
  r: 'r',
  jl: 'jl',
  dart: 'dart',
  lua: 'lua',
  pl: 'pl', pm: 'pm',
  groovy: 'groovy', gradle: 'gradle',
  cs: 'cs',
  fs: 'fs', fsi: 'fsi', fsx: 'fsx',
  m: 'm', mm: 'mm',
  proto: 'proto',
  nix: 'nix',
  vue: 'vue',
  svelte: 'svelte',
  solidity: 'solidity',
  cmake: 'cmake',
  cfg: 'cfg',
  ps1: 'ps1', psm1: 'psm1', psd1: 'psd1',
  dockerfile: 'dockerfile',
  tf: 'tf', hcl: 'hcl',
  conf: 'conf',
  lock: 'lock', mod: 'mod', sum: 'sum',
  csv: 'csv', log: 'log',
  vim: 'vim',
  graphql: 'graphql', gql: 'graphql',
  prisma: 'prisma',
};

/** Return the viewer type for a file extension, or null for unsupported. */
export function getViewerType(ext: string): ViewerType | null {
  const key = ext.toLowerCase();
  return EXT_VIEWER_MAP[key] ?? null;
}

/**
 * Return the CodeMirror / UIW langs key for a file extension, or undefined.
 * @deprecated Use detectLanguage() + languageIdToCodeMirrorKey() instead.
 */
export function getLangKey(ext: string): string | undefined {
  const key = ext.toLowerCase();
  return EXT_LANG_MAP[key];
}

export function parseBasename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Known text extensions that are viewable even when detected as plaintext. */
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'env', 'ini', 'cfg', 'conf', 'lock', 'mod', 'sum', 'csv']);

/** Known text basenames (dotfiles, config files) that are viewable as plaintext. */
const TEXT_BASENAMES = new Set(['.gitignore', '.env', '.gitattributes', '.gitmodules']);

/** Check if a path is openable in FileViewer (media or text/code). */
export function isViewablePath(path: string): boolean {
  const ext = parseExt(path);

  // Media files (image/video/audio/pdf) take precedence
  if (getViewerType(ext) !== null) {
    return true;
  }

  // Text/code files: use LanguageId detection
  const languageId = detectLanguage(path);

  // All LanguageIds except 'plaintext' are viewable (they have meaning)
  if (languageId !== 'plaintext') {
    return true;
  }

  // Plaintext is viewable if it has a known text extension
  if (TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  // Known text basenames (dotfiles, config files)
  const basename = parseBasename(path);
  if (TEXT_BASENAMES.has(basename) || basename.startsWith('.env.')) {
    return true;
  }

  return false;
}

/** Check if an extension has any viewer registered (media or code). */
export function isViewable(ext: string): boolean {
  return getViewerType(ext) !== null || getLangKey(ext) !== undefined;
}

/** Parse extension from a file path (lowercase, no leading dot). */
export function parseExt(path: string): string {
  const filename = parseBasename(path);
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) {
    return '';
  }
  return filename.slice(dot + 1).toLowerCase();
}

/** Return true if the extension indicates a markdown file. */
export function isMarkdownExt(ext: string): boolean {
  const key = ext.toLowerCase();
  return key === 'md' || key === 'markdown' || key === 'mkd';
}
