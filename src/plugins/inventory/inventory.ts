// Inventory primitives — COMPATIBILITY RE-EXPORT.
//
// The pure `Record<item, count>` bag helpers (count/add/remove/entries/
// total/fits/has/affords/transfer/exchange + the Inventory type) are
// CANONICAL in @userfiction/inventory (packages/userfiction/inventory/
// src/inventory.ts — that package now owns the whole old inventory API;
// @userfiction/core no longer exports any inventory). The island keeps
// this module as its local import path so every existing consumer
// ('./inventory', the plugin barrel) resolves the exact same names; the
// helpers themselves have one owner and are never forked here.
// Actor types still come from @userfiction/core (see src/engine/types.ts).

export {
    inventoryCount,
    inventoryAdd,
    inventoryRemove,
    inventoryEntries,
    inventoryTotal,
    inventoryFits,
    inventoryHas,
    inventoryAffords,
    inventoryTransfer,
    inventoryExchange,
} from '@userfiction/inventory';
export type { Inventory } from '@userfiction/inventory';
