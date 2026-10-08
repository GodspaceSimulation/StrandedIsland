// Inventory primitives — COMPATIBILITY RE-EXPORT.
//
// The pure `Record<item, count>` bag helpers (count/add/remove/entries/
// total/fits/has/affords/transfer/exchange + the Inventory type) are
// CANONICAL in @userfiction/core (packages/userfiction/core/src/inventory/
// inventory.ts — the engine-independent fiction layer, R1/R2). The island
// keeps this module as its local import path so every existing consumer
// ('./inventory', the plugin barrel) resolves the exact same names (R3);
// the helpers themselves have one owner and are never forked here.

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
} from '@userfiction/core';
export type { Inventory } from '@userfiction/core';
