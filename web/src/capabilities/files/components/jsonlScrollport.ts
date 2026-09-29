/** Resolve scrollport block height when layout has not run yet (flex + jsdom). */
export function readScrollportHeight(node: HTMLElement): number {
  if (node.clientHeight > 0) {
    return node.clientHeight;
  }
  const inline = Number.parseFloat(node.style.height);
  if (Number.isFinite(inline) && inline > 0) {
    return inline;
  }
  const computed = Number.parseFloat(getComputedStyle(node).height);
  if (Number.isFinite(computed) && computed > 0) {
    return computed;
  }
  return 0;
}

export function syncJsonlScrollportHeight(scrollEl: HTMLElement): number {
  if (readScrollportHeight(scrollEl) > 0) {
    return readScrollportHeight(scrollEl);
  }
  let ancestor: HTMLElement | null = scrollEl.parentElement;
  while (ancestor) {
    const blockHeight = readScrollportHeight(ancestor);
    if (blockHeight > 0) {
      scrollEl.style.height = `${blockHeight}px`;
      return blockHeight;
    }
    ancestor = ancestor.parentElement;
  }
  return 0;
}
