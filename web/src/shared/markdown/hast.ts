/**
 * The smallest slice of hast this module reads.
 *
 * `@types/hast` is installed, but only *transitively* — it arrives under
 * `react-markdown` — and a type package nobody declared is one a dependency
 * bump can take away without anything in this repo saying so. Declaring the
 * four fields `CodeBlock` actually touches is both narrower and safer: it
 * documents the dependency instead of inheriting one, and a hast node that
 * grows a field does not change this file.
 */
export interface HastElement {
  type: 'element';
  tagName: string;
  properties: {
    className?: unknown;
  };
  children: HastNode[];
}

export interface HastText {
  type: 'text';
  value: string;
}

/**
 * A child of an element.
 *
 * Only these two, rather than a catch-all arm for the node kinds hast also has
 * (`comment`, `doctype`). A third `{ type: string }` member would match `text`
 * as well and stop TypeScript narrowing the union at all — so the kinds this
 * module does not read are simply not modelled, and a reader that meets one at
 * runtime contributes nothing, which is what it should do anyway.
 */
export type HastNode = HastElement | HastText;
