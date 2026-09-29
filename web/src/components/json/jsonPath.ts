/** Build a stable JSON path segment for copy/navigation (#1199). */
export function formatJsonPath(segments: Array<string | number>): string {
  if (segments.length === 0) {
    return '$';
  }
  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      path += `[${segment}]`;
    } else {
      path += `.${segment}`;
    }
  }
  return path;
}

export function pathKey(segments: Array<string | number>): string {
  return segments.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('');
}
