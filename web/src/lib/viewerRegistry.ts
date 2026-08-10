export type ViewerType = 'image' | 'video' | 'audio' | 'pdf' | 'markdown';

const EXT_VIEWER_MAP: Record<string, ViewerType> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio',
  pdf: 'pdf',
};

const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go',
  rs: 'rust',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
  toml: 'toml',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kotlin: 'kotlin',
  scala: 'scala',
  hs: 'haskell',
  exs: 'elixir', ex: 'elixir',
  clj: 'clojure', cljs: 'clojure', edn: 'clojure',
  r: 'r',
  jl: 'julia',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  groovy: 'groovy',
  cs: 'csharp',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  m: 'objectivec', mm: 'objectivec',
};

/** Return the viewer type for a file extension, or null for unsupported. */
export function getViewerType(ext: string): ViewerType | null {
  const key = ext.toLowerCase();
  return EXT_VIEWER_MAP[key] ?? null;
}

/** Return the CodeMirror language key for a file extension, or undefined. */
export function getLangKey(ext: string): string | undefined {
  const key = ext.toLowerCase();
  return EXT_LANG_MAP[key];
}

/** Check if an extension has any viewer registered (media or code). */
export function isViewable(ext: string): boolean {
  return getViewerType(ext) !== null || getLangKey(ext) !== undefined;
}

/** Parse extension from a file path (lowercase, no leading dot). */
export function parseExt(path: string): string {
  const filename = path.split('/').pop() ?? path;
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) {
    return '';
  }
  return filename.slice(dot + 1).toLowerCase();
}

/** Return true if the extension indicates a markdown file. */
export function isMarkdownExt(ext: string): boolean {
  const key = ext.toLowerCase();
  return key === 'md' || key === 'markdown';
}

/**
 * Given a list of file paths, return unique extensions that have registered
 * CodeMirror language loaders. Used by FileBrowser to fire preload().
 */
export function preloadExtensions(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const ext = parseExt(path);
    if (ext && getLangKey(ext) && !seen.has(ext)) {
      seen.add(ext);
    }
  }
  return Array.from(seen);
}
