// Item catalog — the vocabulary of things that can exist on the island.
// Items are grouped by kind so the behavior plugin can reason about them
// (food satisfies hunger, drinks satisfy thirst, materials are trade goods).

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

/** All items known to the simulation, keyed by item id. */
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

/** Safe item lookup — unknown ids resolve to a generic material. */
export const itemDef = (itemId: string): ItemDef =>
    ITEM_CATALOG[itemId] ?? { name: itemId, kind: 'material' };

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
