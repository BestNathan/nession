/**
 * Commands wire types. The item type lives today in
 * `components/quickCommands/types.ts` and is re-exported by
 * `web/src/types.ts` (shared with the legacy facade); this module is the
 * feature's stable import point.
 */
export type {
  CommandsAddResponse,
  CommandsListResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
  QuickCommandItem,
} from '@/types';
