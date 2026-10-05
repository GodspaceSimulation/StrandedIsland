// Tests for the item catalog's category system (plugins/inventory/items.ts).
// The category is the coarsest level of the ground-item granularity ladder
// the zoom scales read: the island view (and every wider one) lists categories,
// scale 1 lists items, scale 2+ shows positions.

import { describe, it, expect } from 'vitest';
import {
    ITEM_CATALOG,
    ITEM_CATEGORY_LABELS,
    ITEM_KINDS,
    ITEM_TYPE_GLYPHS,
    inventoryCategories,
    itemCategory,
    itemDef,
    itemLabel,
} from './items';

describe('item categories', () => {
    it('covers every catalog item with a category and label', () => {
        expect(ITEM_KINDS).toEqual(['food', 'drink', 'material', 'tool']);
        expect(ITEM_CATEGORY_LABELS).toEqual({
            food: 'Foods',
            drink: 'Drinks',
            material: 'Materials',
            tool: 'Tools',
        });
        // Every item resolves to a known category — the "all items have
        // categories" rule
        Object.keys(ITEM_CATALOG).forEach((itemId) => {
            expect(ITEM_KINDS).toContain(itemCategory(itemId));
        });
    });

    it('categorizes the catalog items exactly', () => {
        expect(itemCategory('berry')).toBe('food');
        expect(itemCategory('fish')).toBe('food');
        expect(itemCategory('coconut')).toBe('food');
        expect(itemCategory('water')).toBe('drink');
        expect(itemCategory('wood')).toBe('material');
        expect(itemCategory('stone')).toBe('material');
        expect(itemCategory('iron')).toBe('material');
        expect(itemCategory('sand')).toBe('material');
        expect(itemCategory('dirt')).toBe('material');
        expect(itemCategory('vine')).toBe('material');
        expect(itemCategory('shell')).toBe('material');
        expect(itemCategory('flint')).toBe('tool');
        // Unknown ids fall back to the generic material — every item has a
        // category, even ones the catalog does not know
        expect(itemCategory('unobtanium')).toBe('material');
        expect(itemDef('unobtanium')).toEqual({
            name: 'unobtanium',
            kind: 'material',
            nutrition: undefined,
            hydration: undefined,
        });
    });

    it('aggregates an inventory into category stacks in ITEM_KINDS order', () => {
        // The meadow stock: dirt (material) + 2 berries (food)
        expect(
            inventoryCategories({
                dirt: 1,
                berry: 2,
            }),
        ).toEqual([
            { category: 'food', label: 'Foods', count: 2 },
            { category: 'material', label: 'Materials', count: 1 },
        ]);
        // Ael's beach: coconut (food) + sand/shell (materials)
        expect(
            inventoryCategories({
                sand: 1,
                coconut: 1,
                shell: 1,
            }),
        ).toEqual([
            { category: 'food', label: 'Foods', count: 1 },
            { category: 'material', label: 'Materials', count: 2 },
        ]);
        // A rain pool: water is its own category (drink)
        expect(inventoryCategories({ water: 3 })).toEqual([
            { category: 'drink', label: 'Drinks', count: 3 },
        ]);
        // Zero and absent categories drop out; empty inventories list nothing
        expect(inventoryCategories({})).toEqual([]);
        expect(inventoryCategories({ berry: 0 })).toEqual([]);
        // An unknown item aggregates under the generic material category
        expect(inventoryCategories({ unobtanium: 2 })).toEqual([
            { category: 'material', label: 'Materials', count: 2 },
        ]);
    });

    it('keeps itemLabel naming intact alongside the categories', () => {
        expect(itemLabel('berry', 2)).toBe('2 Berries');
        expect(itemLabel('fish', 1)).toBe('1 Fish');
    });

    it('maps ground items to their canvas emoji', () => {
        expect(ITEM_TYPE_GLYPHS.berry).toBe('🍒');
        expect(ITEM_TYPE_GLYPHS.coconut).toBe('🥥');
        expect(ITEM_TYPE_GLYPHS.fish).toBe('🐟');
        expect(ITEM_TYPE_GLYPHS.shell).toBe('🐚');
        expect(ITEM_TYPE_GLYPHS.water).toBe('💧');
        expect(ITEM_TYPE_GLYPHS.vine).toBe('🌿');
        expect(ITEM_TYPE_GLYPHS.flint).toBe('⛏️');
    });
});
