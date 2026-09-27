/**
 * The provider's `preview` as one line a list row can draw (#1120 item 5).
 *
 * The field is the user's own prompt, passed through verbatim by the provider on
 * purpose — measured, it is often a slash command, and sometimes a single
 * character. Bounding it for display is the caller's job, because the caller is
 * the only layer that knows the row's width; this is that bounding, kept in one
 * place so the list row and any later surface cannot disagree about it.
 *
 * Two transformations, both of which are about *the line* rather than the text:
 *
 * - **Whitespace is collapsed.** A prompt is frequently multi-line (a pasted
 *   stack trace, a bulleted request), and a newline in a one-line slot either
 *   breaks the row's height or gets clipped mid-word. Collapsing keeps the words
 *   and drops the shape, which is the right trade for a scanning aid.
 * - **An empty result is `null`, not `''`.** A prompt of `"   \n  "` is not a
 *   preview, and returning an empty string would make the row reserve a blank
 *   second line — the failure `#1120` names when it says a row without a preview
 *   must degrade to title and time.
 *
 * It does **not** truncate to a character count. The row uses CSS truncation, so
 * the cut follows the actual width rather than a guess made here; a character
 * bound would either clip early on a wide row or let a narrow one overflow.
 */
export function previewLine(preview: string | null | undefined): string | null {
  if (!preview) {
    return null;
  }
  const collapsed = preview.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? null : collapsed;
}
