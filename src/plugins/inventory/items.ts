// Item catalog — the vocabulary of things that can exist on the island.
// Items are grouped by kind (the CATEGORY — see the generalization ladder
// at the bottom of this file) so the behavior plugin can reason about them
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
import { inventoryEntries, type Inventory } from './inventory';

/**
 * The island's shared material catalog — a @godspace/material registry.
 * Seeded below with the island-coined ids the stock catalog doesn't list;
 * engines can `define`/`remove` entries to reshape item identity.
 */
export const materials: ItemRegistry = createItemRegistry();

// Engine configuration of the shared catalog: the island coins ids the
// stock list doesn't carry (berry — the catalog lists the plural 'berries';
// water — the island's drinkable fresh water from the lake/pond basins;
// iron and dirt — the tile
// deposits the catalog only lists in compound form, 'iron-ore'; tree — the
// standing deposit the canvas paints green; frond — the palm undergrowth
// the construction chains shed beneath the trees; grass — the ground cover
// every grass-voxel column supplies infinitely, its own resource identity
// beside the dirt under it). Display-only definitions: the island's own
// stats stay in ITEM_CATALOG. 'sand' is already listed in the shared stock
// catalog, so it needs no definition here.
materials.define({ id: 'berry', name: 'Berry', kind: 'food' });
materials.define({ id: 'water', name: 'Water', kind: 'resource' });
materials.define({ id: 'iron', name: 'Iron', kind: 'resource' });
materials.define({ id: 'dirt', name: 'Dirt', kind: 'resource' });
materials.define({ id: 'tree', name: 'Tree', kind: 'resource' });
materials.define({ id: 'grass', name: 'Grass', kind: 'resource' });
materials.define({ id: 'frond', name: 'Frond', kind: 'resource' });

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
    // The forest floor's snack and the sea's greenery — the richer map's
    // new foods: mushrooms sprout in the woods (the survey seeds them),
    // seaweed washes ashore in the shallows and floats in the ocean
    mushroom: { name: 'Mushroom', kind: 'food', nutrition: 10 },
    seaweed: { name: 'Seaweed', kind: 'food', nutrition: 8, hydration: 2 },
    water: { name: 'Water', kind: 'drink', hydration: 35 },
    // Tile deposits — the standing natural features: trees (cut into wood
    // by the chop), FINITE stone (the localized rock sites it stands on —
    // the highland peaks, the boulder crowns — it draws down with the
    // stock and the 🪨 icon drops when it empties), and the iron lodes
    // hide in the highlands. Grass, sand and dirt are the UNLIMITED ground
    // supply — the voxel materials every dry column is built from
    // (engine/types.ts UNLIMITED_TILE_RESOURCES): gathering them never
    // empties the tile. (GRAVEL — the rock terrain itself — is NOT a
    // deposit: the old bedrock stone never mirrors into the stocks.)
    // WOOD IS NOT A DEPOSIT — it is the product of cutting a tree's wood
    // (the lumber behaviour's chop → inventory.harvest), a trade good like
    // stone.
    tree: { name: 'Tree', kind: 'material' },
    stone: { name: 'Stone', kind: 'material' },
    iron: { name: 'Iron', kind: 'material' },
    sand: { name: 'Sand', kind: 'material' },
    dirt: { name: 'Dirt', kind: 'material' },
    grass: { name: 'Grass', kind: 'material' },
    wood: { name: 'Wood', kind: 'material' },
    vine: { name: 'Vine', kind: 'material' },
    // The palm undergrowth the trees shed (the inventory plugin's frond
    // rhythm) — the raw stock the construction chains weave thatch and
    // cloth from (plugins/construction)
    frond: { name: 'Frond', kind: 'material' },
    // R2 — the BERRY BUSH: a concrete, standing berry plant that grows in the
    // meadow and forest undergrowth (the survey seeds it on a deterministic
    // coordinate hash). Its stock count is the berries it BEARS; foraging
    // plucks a berry off it (plugins/inventory gather) and the bush regrows
    // its berries on its own rhythm (REGROW_CAPS/RHYTHM). A visible,
    // inspectable feature — never an abstract bag item.
    bush: { name: 'Berry Bush', kind: 'material' },
    shell: { name: 'Shell', kind: 'material' },
    flint: { name: 'Flint', kind: 'tool' },
    // R4 — the early craftable hand tools (the axe's chop, the hammer's
    // build work). Both are listed in the shared @godspace/material catalog
    // (kind 'tool') so their display identity flows from there; the island
    // coins the game-specific tool kind here. The construction plugin
    // crafts them (ISLAND_RECIPES) before the long build projects.
    axe: { name: 'Axe', kind: 'tool' },
    hammer: { name: 'Hammer', kind: 'tool' },
};

/**
 * R5 — THE CARRYING WEIGHTS. Every item weighs a POSITIVE integer (minimum 1);
 * a bag's load is the SUM of `count × weight`, and each carrier's capacity is
 * a WEIGHT budget (a person carries 200 — see the entity profiles'
 * `inventorySize`, now read as weight). The weights are tuned to the item's
 * physical kind so the load reads honestly: a unit of WOOD is 20 (the
 * requirement's anchor — ten logs fill a person), stone/iron are heavy
 * (40/60), the unlimited ground (grass) is light (3), foods sit in the 5–30
 * band, and the hand tools weigh their raws (axe 30, hammer 35). Unknown ids
 * fall back to the minimum 1 (an unlisted thing is light, never free).
 */
export const ITEM_WEIGHTS: Record<string, number> = {
    berry: 5,
    fish: 25,
    coconut: 30,
    mushroom: 8,
    seaweed: 5,
    water: 15,
    tree: 20,
    stone: 40,
    iron: 60,
    sand: 30,
    dirt: 25,
    grass: 3,
    wood: 20,
    vine: 6,
    frond: 4,
    bush: 1,
    shell: 5,
    flint: 15,
    axe: 30,
    hammer: 35,
};

/** The weight of ONE unit of an item — always ≥ 1 (unknown ids are light). */
export const itemWeight = (itemId: string): number => ITEM_WEIGHTS[itemId] ?? 1;

/**
 * The bag's total carried WEIGHT — `Σ count × itemWeight`. This is the
 * measure the R5 capacity gate compares against a carrier's weight capacity
 * (the count-based `inventoryTotal` stays for stack/display math only).
 */
export const inventoryWeight = (inventory: Inventory): number =>
    inventoryEntries(inventory).reduce((sum, stack) => sum + stack.count * itemWeight(stack.item), 0);

/**
 * The DEPOSIT resources only a miner may take — the 'mine' ability unlock
 * (plugins/entity/entityPlugin.ts). Taking stone or iron off a tile through
 * the inventory plugin's takeFromCell demands the entity's species to hold
 * the mine ability; every other item is free for any hand that reaches it.
 * The gate is about WHO may work the ROCK — the stone supply is FINITE now
 * (the localized rock-site stock draws down with the pile; the 🪨 icon and
 * the 'stone' surface key track it), the ability limits the hands.
 */
export const MINED_ITEMS: readonly string[] = ['stone', 'iron'];

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

// ── Item categories — the generalization ladder of the zoom scale ───────────
//
// Every item carries a category, and the category is the COARSEST level of
// the ground-item granularity ladder the zoom scales read (the ladder counts
// UP from the interior ground):
//   the island view (a length-1 path; scale 1 on this engine — and every
//     wider view above it) lists the CATEGORY ("Foods"), never the item;
//   scale 0 (the tile interior) lists the ITEM ("1 Berry") and draws it as a
//     canvas object at its subtile position;
//   deeper levels show WHERE each unit stands (canvas objects at exact
//     spots).
// Berries are foods: zoomed all the way out, the god still reads "foods".

/** The category kinds — fixed order, the display order of category lists. */
export const ITEM_KINDS: readonly ItemKind[] = ['food', 'drink', 'material', 'tool'];

/** Display label per category — what the coarse views list ("Foods"). */
export const ITEM_CATEGORY_LABELS: Record<ItemKind, string> = {
    food: 'Foods',
    drink: 'Drinks',
    material: 'Materials',
    tool: 'Tools',
};

/**
 * The category of an item — every item has one (unknown ids fall back to
 * the generic material, the same fallback itemDef applies).
 */
export const itemCategory = (itemId: string): ItemKind => itemDef(itemId).kind;

/** One aggregated category of a ground stock: "Foods ×2". */
export type ItemCategoryStack = {
    /** The category kind. */
    category: ItemKind;
    /** Display label ("Foods"). */
    label: string;
    /** Total units across every item of the category. */
    count: number;
};

/**
 * Aggregates an inventory into its category stacks, in ITEM_KINDS order —
 * the generalization the island-view Tile Inspector lists (and any wider
 * view above it). Zero categories drop out.
 */
export const inventoryCategories = (inventory: Inventory): ItemCategoryStack[] => {
    const totals = new Map<ItemKind, number>();
    inventoryEntries(inventory).forEach((stack) => {
        const category = itemCategory(stack.item);
        totals.set(category, (totals.get(category) ?? 0) + stack.count);
    });
    return ITEM_KINDS.filter((kind) => totals.has(kind)).map((kind) => ({
        category: kind,
        label: ITEM_CATEGORY_LABELS[kind],
        count: totals.get(kind) as number,
    }));
};

/**
 * Canvas type-glyphs for ground items — the unicode/svg canvases resolve an
 * entry's TYPE through their type map, so ground-item entries (typed with
 * the item id, kind 'item') draw these emoji. Merged into the canvas
 * plugins' type palettes by the scenario (scenario/island.ts); items not
 * listed fall back to the name-initial letter of the glyph ladder.
 */
export const ITEM_TYPE_GLYPHS: Record<string, string> = {
    berry: '🍒',
    coconut: '🥥',
    fish: '🐟',
    shell: '🐚',
    water: '💧',
    vine: '🌿',
    flint: '⛏️',
    mushroom: '🍄',
    seaweed: '🌱',
    frond: '🍃',
    // R2 — the berry bush's canvas glyph (the ground-item entries resolve a
    // bush unit's type through this, so a bush stands as its own visible
    // plant beside the 🍒 berries it bears)
    bush: '🪴',
    // R4 — the hand tools' canvas glyphs (the unicode/svg type palettes
    // resolve a tool entry's type through these)
    axe: '🪓',
    hammer: '🔨',
};
