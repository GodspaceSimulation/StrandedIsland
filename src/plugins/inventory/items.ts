// Item catalog — the vocabulary of things that can exist on the island.
// Items are grouped by kind so the behavior plugin can reason about them
// (food satisfies hunger, drinks satisfy thirst, materials are trade goods).
//
// Display identity is delegated to the @godspace/material catalog — the
// shared, engine-configurable item registry (plain data, define/patch/remove).
// The island keeps only its GAME-SPECIFIC stats locally (nutrition, thirst
// relief, the drink/food split behavior reasons about); names come from the
// shared catalog when the item is listed there, falling back to the local
// table for island-coined ids. The `materials` registry is exported so the
// game engine (and tests) can reconfigure the shared catalog live.

import { createItemRegistry, type ItemRegistry } from '@godspace/material';

/**
 * The island's shared material catalog — a @godspace/material registry.
 * Seeded below with the island-coined ids the stock catalog doesn't list;
 * engines can `define`/`remove` entries to reshape item identity.
 */
export const materials: ItemRegistry = createItemRegistry();

// Engine configuration of the shared catalog: the island coins two ids the
// stock list doesn't carry (berry — the catalog lists the plural 'berries';
// water — the island's drinkable rain pool). Display-only definitions: the
// island's own stats stay in ITEM_CATALOG.
materials.define({ id: 'berry', name: 'Berry', kind: 'food' });
materials.define({ id: 'water', name: 'Water', kind: 'resource' });

export type ItemKind = 'food' | 'drink' | 'material' | 'tool';

export type ItemDef = {
    /** Display name. */
    name: string;
    /** Category tag used by needs/behavior logic. */
    kind: ItemKind;
    /** Hunger points restored when eaten (food only). */
    nutrition?: number;
    /** Thirst points restored when consumed (drink only). */
    hydration?: number;
};

/** All items known to the simulation, keyed by item id (game stats only). */
export const ITEM_CATALOG: Record<string, ItemDef> = {
    berry: { name: 'Berry', kind: 'food', nutrition: 14 },
    fish: { name: 'Fish', kind: 'food', nutrition: 26 },
    coconut: { name: 'Coconut', kind: 'food', nutrition: 18, hydration: 10 },
    water: { name: 'Water', kind: 'drink', hydration: 35 },
    wood: { name: 'Wood', kind: 'material' },
    stone: { name: 'Stone', kind: 'material' },
    vine: { name: 'Vine', kind: 'material' },
    shell: { name: 'Shell', kind: 'material' },
    flint: { name: 'Flint', kind: 'tool' },
};

/**
 * Safe item lookup — unknown ids resolve to a generic material. The display
 * name comes from the shared @godspace/material catalog when the id is
 * listed there (so engine-side renames flow straight into the island UI);
 * the local table supplies it for island-only ids and always supplies the
 * game-specific stats.
 */
export const itemDef = (itemId: string): ItemDef => {
    const local = ITEM_CATALOG[itemId];
    const listed = materials.definitionOf(itemId);
    return {
        name: listed?.name ?? local?.name ?? itemId,
        kind: local?.kind ?? 'material',
        nutrition: local?.nutrition,
        hydration: local?.hydration,
    };
};

/** Irregular plurals — everything else pluralizes mechanically. */
const PLURAL_EXCEPTIONS: Record<string, string> = {
    Fish: 'Fish',
};

/** Human readable stack label: "1 Fish" / "2 Berries" — shared by plugins and UI. */
export const itemLabel = (itemId: string, count: number): string => {
    const name = itemDef(itemId).name;
    if (count === 1) {
        return `1 ${name}`;
    }
    const plural = PLURAL_EXCEPTIONS[name] ?? (name.endsWith('y') ? `${name.slice(0, -1)}ies` : `${name}s`);
    return `${count} ${plural}`;
};
