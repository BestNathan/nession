/**
 * Generate a unique ID using timestamp + random number.
 * Optional prefix for namespacing.
 */
export function generateId(prefix = ''): string {
  const id = `${Date.now()}-${Math.random()}`;
  return prefix ? `${prefix}-${id}` : id;
}
