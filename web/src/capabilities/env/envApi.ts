import { EnvPlugin } from './EnvPlugin';

/**
 * The capability's process-wide binding (#1202).
 *
 * Kept out of the barrel so the capability's own hooks can depend on the
 * singleton without importing the barrel that also exports them. A hook that
 * imports `@/capabilities/env` from inside the capability closes a module cycle
 * (`index → hook → index`) and makes the public hook export order-sensitive
 * under `vi.mock`; the barrel re-exports this one instance instead.
 */
export const envApi = new EnvPlugin();
