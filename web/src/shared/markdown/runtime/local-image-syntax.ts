/**
 * Recover standalone local image references with bare spaces without changing
 * code or source offsets.
 *
 * Upstream: https://github.com/deepseek-ai/deepseek-harness
 * Baseline: 21638c56315ae6a2b552d6091945d3144c9af32e
 * Source: packages/client/ui-primitives/src/markdown/local-image-syntax.ts
 * License: MIT (see THIRD_PARTY_NOTICES.md)
 * Adaptation: Adopted and simplified — no `dsh-app://` product vocabulary;
 * recovered destinations go through Nession's own remote-URL allowlist at
 * render time and otherwise stay inert alt text.
 */
import type { Root, RootContent, PhrasingContent } from 'mdast'

/**
 * Check if a file path has an image extension.
 * @param path - File path to check.
 * @returns True if the path has a common image extension.
 */
function isImagePath(path: string): boolean {
  const imageExtensions = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)(\?|#|$)/i
  return imageExtensions.test(path)
}

/**
 * Recover only unambiguous, unescaped image-only paragraphs containing a local path with spaces.
 * @param root - Parsed Markdown tree, modified in place.
 * @param source - Original source used to distinguish authored syntax from escaped examples.
 * @returns The same root with recovered image nodes.
 */
export function recoverLocalImages(root: Root, source: string): Root {
  const visit = (node: Root | RootContent): void => {
    if (node.type === 'paragraph' && node.children.length === 1) {
      const [child] = node.children as [PhrasingContent]
      if (child.type === 'text' && child.position !== undefined
        && source.slice(child.position.start.offset, child.position.end.offset) === child.value) {
        const pattern = /^!\[([^\]\n]*)\]\(((?:\/(?!\/)|\.{1,2}\/|[a-z]:[\\/])[^\n<>()[\]"']+\.[a-z\d]+)\)$/iu
        const match = pattern.exec(child.value) as [string, string, string] | null
        if (match !== null && match[2].includes(' ') && isImagePath(match[2])) {
          node.children = [{ type: 'image', alt: match[1], url: match[2], position: child.position }]
        }
      }
    } else if ('children' in node) {
      for (const child of node.children) {visit(child)}
    }
  }
  visit(root)
  return root
}
