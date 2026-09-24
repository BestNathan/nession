/**
 * Consumer-side protocol resolution (`#678`, Phase 4).
 *
 * The client half of the Protocol Kernel: it holds what a target advertises
 * ([`ProtocolDirectory`]), answers what this client can speak about one unit
 * ([`resolveContract`]), and names both sides when the answer is nothing
 * ([`refusalMessage`]).
 *
 * Framework-level and React-free, like `platform/terminal-runtime`: these are
 * rules about wire contracts, not about the product. Which versions this client
 * *speaks* is the capability's own declaration and lives with the capability,
 * next to the wire strings it already owns.
 */
export { manifestsOf, ProtocolDirectory } from './directory';
export {
  addressedPayload,
  refusalMessage,
  resolveContract,
  selectVersion,
} from './resolve';
export type { TargetProtocols } from './directory';
export type { Resolution } from './resolve';
export type { ContractSupport, ProtocolManifest } from './types';
