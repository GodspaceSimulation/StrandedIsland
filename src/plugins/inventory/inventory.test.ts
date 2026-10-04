// Tests for the inventory primitives (plugins/inventory/inventory.ts).
// The exchange primitive's atomicity is the critical contract.

import { describe, it, expect } from 'vitest';
import {
    inventoryAdd,
    inventoryCount,
    inventoryRemove,
    inventoryEntries,
    inventoryHas,
    inventoryAffords,
    inventoryTransfer,
    inventoryExchange,
    type Inventory,
} from './inventory';

describe('inventory primitives', () => {
    it('add / count round-trip', () => {
        const bag: Inventory = {};
        inventoryAdd(bag, 'berry', 2);
        inventoryAdd(bag, 'berry', 3);
        expect(inventoryCount(bag, 'berry')).toBe(5);
        expect(inventoryCount(bag, 'fish')).toBe(0);
    });

    it('remove is all-or-nothing', () => {
        const bag: Inventory = { berry: 3 };
        // Cannot afford 4 — nothing changes
        expect(inventoryRemove(bag, 'berry', 4)).toBe(false);
        expect(bag).toEqual({ berry: 3 });
        // Can afford 3 — exact removal drops the entry
        expect(inventoryRemove(bag, 'berry', 3)).toBe(true);
        expect(bag).toEqual({});
        expect(inventoryRemove(bag, 'berry', 1)).toBe(false);
    });

    it('entries lists only non-zero stacks', () => {
        const bag: Inventory = { berry: 2, wood: 0, fish: 1 };
        expect(inventoryEntries(bag)).toEqual([
            { item: 'berry', count: 2 },
            { item: 'fish', count: 1 },
        ]);
    });

    it('has and affords', () => {
        const bag: Inventory = { berry: 2, wood: 1 };
        expect(inventoryHas(bag, 'berry')).toBe(true);
        expect(inventoryHas(bag, 'berry', 3)).toBe(false);
        expect(inventoryAffords(bag, { berry: 2, wood: 1 })).toBe(true);
        expect(inventoryAffords(bag, { berry: 3 })).toBe(false);
        expect(inventoryAffords(bag, { berry: 2, wood: 2 })).toBe(false);
    });

    it('transfer moves atomically', () => {
        const from: Inventory = { wood: 1 };
        const to: Inventory = {};
        expect(inventoryTransfer(from, to, 'wood', 1)).toBe(true);
        expect(from).toEqual({});
        expect(to).toEqual({ wood: 1 });
        expect(inventoryTransfer(from, to, 'wood', 1)).toBe(false);
        expect(to).toEqual({ wood: 1 });
    });

    it('exchange swaps both ways atomically', () => {
        const a: Inventory = { berry: 2, fish: 1 };
        const b: Inventory = { shell: 2, wood: 1 };
        // A trades 2 berries for 1 shell
        expect(inventoryExchange(a, b, { berry: 2 }, { shell: 1 })).toBe(true);
        expect(a).toEqual({ fish: 1, shell: 1 });
        expect(b).toEqual({ shell: 1, wood: 1, berry: 2 });
    });

    it('exchange fails atomically when either side cannot afford', () => {
        const a: Inventory = { berry: 1 };
        const b: Inventory = { wood: 1 };
        // A cannot offer 2 berries — nothing moves
        expect(inventoryExchange(a, b, { berry: 2 }, { wood: 1 })).toBe(false);
        expect(a).toEqual({ berry: 1 });
        expect(b).toEqual({ wood: 1 });
        // B cannot pay 2 wood — nothing moves
        expect(inventoryExchange(a, b, { berry: 1 }, { wood: 2 })).toBe(false);
        expect(a).toEqual({ berry: 1 });
        expect(b).toEqual({ wood: 1 });
    });
});
