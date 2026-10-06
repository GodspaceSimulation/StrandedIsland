// The inventory environment plugin.
//
// Gives every actor a personal inventory, fills the canvas with resource
// stocks by tile deposit (trees in the forests, berries AND mushrooms in
// the meadows and woods, fish AND seaweed in the sea, coconuts on beaches,
// stone/iron/flint on highlands, vines in the woods, and the UNLIMITED
// sands and dirts of beaches and meadows), grows them back over time, rains
// fresh water onto the land in scattered pools, and exposes the
// gathering + harvest + exchange actions that other plugins (behavior,
// lumber) and the god-view drive.
//
// TILE DEPOSITS: every canvas cell carries `resources` (engine/types.ts
// TileResources) — written by the terrain generator, kept in sync here. The
// survey seeds each cell's gatherable stock from its deposits; taking a
// deposit resource draws the tile's deposit down too (except the UNLIMITED
// sand/dirt — never depleted), and regrowth grows the deposit back. That
// keeps the tile's canvas appearance (scenario surfaceOf → tileSurfaceKey)
// reading the same truth the actors gather from.
//
// INSTALL ORDER: after the terrain plugin — setup scans the canvas to seed
// resources. Without a canvas it simply starts with no resources.

import { arrayEach } from '@presource/core';
import { randomKeyed, type Position3D } from '@godspace/core';
import type { Actor, TerrainCell, TileResource } from '../../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import { itemDef, itemLabel, MINED_ITEMS } from './items';
import {
    inventoryAdd,
    inventoryEntries,
    inventoryExchange,
    inventoryFits,
    inventoryRemove,
    inventoryTotal,
    inventoryTransfer,
    type Inventory,
} from './inventory';
import type { EntityProfiles } from '../entity/entityPlugin';

export type InventoryPluginOptions = {
    /** Chance per world-minute that rain sweeps the island and pools gather
     * on a scattered subset of the land. Default 0.0127 (≈ 0.76 rains per
     * world hour). */
    rainChancePerMinute?: number;
    /**
     * The entity profiles (plugins/entity/entityPlugin.ts) — the per-type
     * inventory SIZES (a bird carries 2–3 things, a human eight) and the
     * ability gates (the 'mine' unlock). Absent: bags are unlimited and
     * every hand may take everything (the pre-entity behavior).
     */
    profiles?: EntityProfiles;
};

/** Regrowth caps per item — stocks never exceed these counts. The tree cap
 * is the base grove's two; a DENSE grove (islandTerrain's dense moisture
 * band — six standing trees) regrows toward its own richer deposit: the
 * growDeposit cap below never shrinks a tile's stock, so a dense tile keeps
 * its six until felled, then recovers to the base three. */
const REGROW_CAPS: Record<string, number> = {
    berry: 3,
    tree: 3,
    fish: 1,
    coconut: 2,
    water: 2,
    // The richer map's foods: mushrooms sprout back in the woods,
    // seaweed washes back in every other tide
    mushroom: 2,
    seaweed: 1,
    // shell / stone / iron / flint / vine are finite — no regrowth
    // sand / dirt are unlimited — never depleted, never regrown
};

/**
 * Regrowth rhythm per item, in WORLD MINUTES: fires when
 * `minute % every === offset`. (The values pin the rhythm to WORLD MINUTES,
 * so the view scale never moves it.)
 */
const REGROW_RHYTHM: Record<string, { every: number; offset: number }> = {
    berry: { every: 30, offset: 20 },
    tree: { every: 60, offset: 40 },
    fish: { every: 40, offset: 0 },
    coconut: { every: 60, offset: 10 },
    mushroom: { every: 40, offset: 15 },
    seaweed: { every: 50, offset: 25 },
};

/**
 * Chance per rain event that ONE land cell gathers a drinking pool. Rain no
 * longer floods the whole island — pools form on a scattered subset, so
 * fresh water is a resource the cast must go and FIND (the behavior
 * plugin's thirst ladder travels to the nearest pool).
 */
const POOL_CHANCE_PER_CELL = 0.25;

/** What each biome stocks when the island is surveyed — THE RICHER MAP.
 * The tile deposits (trees, stone, iron, sand, dirt) come from the cells
 * themselves — see the survey below; these are the biome's living stocks:
 * meadows berry, forests berry AND mushroom (the woods feed two ways),
 * beaches coconut. */
const BIOME_STOCKS: Record<string, Inventory> = {
    meadow: { berry: 2 },
    forest: { berry: 1, mushroom: 1 },
    beach: { coconut: 1 },
    // Water cells hold fish AND seaweed — the sea's two stocks (salt
    // water is never a drinking pool)
};

/** Chance a surveyed FOREST cell hangs a vine — the woods' finite material
 * (no regrowth: a harvested vine stays harvested). */
const VINE_CHANCE_PER_FOREST_CELL = 0.35;

/** Chance a surveyed SHALLOW cell keeps a washed-ashore seaweed — the
 * shallows' second sea stock beside the fish (seaweed regrows). */
const SHALLOW_SEAWEED_CHANCE = 0.5;

/** Whether an item id is a tile deposit resource (tree/stone/iron/sand/dirt). */
const isTileResource = (itemId: string): itemId is TileResource =>
    (TILE_RESOURCES as readonly string[]).includes(itemId);

/** Whether an item id is an UNLIMITED deposit (sand/dirt — never depleted). */
const isUnlimitedResource = (itemId: string): boolean =>
    (UNLIMITED_TILE_RESOURCES as readonly string[]).includes(itemId);

/** Human readable "1 Fish"/"2 Berries" fragment for log lines. */
const label = itemLabel;

/**
 * The minimal agent shape the inventory ACTIONS act through — a registry
 * castaway (the full Actor) or a coordinate-space creature planned through
 * the task ledger (a foraging seabird picks berries; the behavior plugin's
 * every-living-thing ladder passes its TaskEntity identity here). Id keys
 * the bag + events, position reads the cell, name writes the log lines.
 */
export type InventoryAgent = {
    id: string;
    name: string;
    position: Position3D;
};

export type InventoryPlugin = WorldPlugin<World> & {
    /** An actor's bag — auto-created (empty) on first touch. */
    of(actorId: string): Inventory;
    /**
     * The entity's bag capacity in UNITS — its species' inventory size from
     * the entity profiles. `Infinity` without profiles (unlimited legacy
     * bags); a species without a profile carries the stock human's eight.
     */
    capacityOf(entityId: string): number;
    /** Resource stock standing on a canvas cell. */
    cellStock(x: number, y: number): Inventory;
    /** Takes one `itemId` from the cell the agent stands on. */
    takeFromCell(agent: InventoryAgent, itemId: string): boolean;
    /**
     * Harvests a tile deposit into its PRODUCT: removes one unit of the
     * deposit resource (`depositId` — e.g. 'tree') standing on the agent's
     * cell and adds one unit of the produced item (`yieldId` — e.g. 'wood')
     * to the bag. Wood is not a natural resource — it exists only as the
     * product of cutting a tree down, so the deposit draws down and the
     * bag grows in one atomic step. Fails without side effects when the
     * cell holds none of the deposit (or the deposit is unlimited — those
     * are gathered raw with takeFromCell, never converted).
     */
    harvest(agent: InventoryAgent, depositId: string, yieldId: string): boolean;
    /** Gathers one available item from the agent's cell. Returns the item id. */
    gather(agent: InventoryAgent): string | null;
    /** Removes one `itemId` from the agent's bag (eating / drinking). */
    consume(agent: InventoryAgent, itemId: string): boolean;
    /** Agent-to-agent exchange: `giver` hands `offer`, receives `request`. */
    exchange(giver: InventoryAgent, receiver: InventoryAgent, offer: Inventory, request: Inventory): boolean;
    /** One-way transfer — the gift primitive. */
    give(giver: InventoryAgent, receiver: InventoryAgent, itemId: string, count: number): boolean;
    /** All cells whose stock currently holds `itemId`. */
    cellsWithItem(itemId: string): TerrainCell[];
    /** Seeds an actor's bag with starting items. */
    spawnKit(actorId: string, kit: Inventory): void;
    /** Wipes and re-seeds every cell stock from the current canvas (resize flow). */
    resurvey(): void;
};

export const inventoryPlugin = (options: InventoryPluginOptions = {}): InventoryPlugin => {
    // Rain chance per world-minute — each tick hook call covers exactly one
    // world-minute (engine/world.ts sub-steps), so the roll applies directly
    const rainChance = options.rainChancePerMinute ?? 0.0127;
    // The entity profiles — inventory sizes + ability gates. Null: unlimited
    // bags, no gates (the pre-entity behavior).
    const profiles = options.profiles ?? null;

    // Actor bags and cell stocks, keyed by id / "x,y"
    const bags = new Map<string, Inventory>();
    const stocks = new Map<string, Inventory>();

    // The plugin's fine clock — one world-minute per tick hook call (the
    // world sub-steps its steps). The regrowth rhythm reads THIS, not the
    // ticker's step count: the ticker only counts steps, and within one
    // step every minute must see its own time.
    let minute = 0;

    // The world reference arrives with setup; action hooks (exchange/give)
    // need it for event emission and canvas lookups before any tick runs.
    let world: World | null = null;
    // The plugin context captured in setup — resurvey() re-runs the canvas
    // survey with the same deterministic random stream after a regeneration
    let surveyContext: PluginContext<World> | null = null;

    /** WHICH an entity is — the profile key. Castaways carry their type in
     * the actor registry, creatures in the coordinate space's facet. */
    const typeOf = (entityId: string): string | undefined =>
        world?.actors.get(entityId)?.type ?? world?.coordinates.entryOf(entityId)?.type;

    /**
     * The entity's bag capacity in units — its species' inventory size.
     * Infinity without profiles; a species without a profile carries the
     * stock human's eight (the island's shoulders).
     */
    const capacityOf = (entityId: string): number => {
        const type = typeOf(entityId);
        const size = type ? profiles?.inventorySizeOf(type) : undefined;
        return size ?? (profiles ? 8 : Infinity);
    };

    /** Whether the bag can still hold a bundle (the capacity gate). */
    const canHold = (entityId: string, additions: Inventory): boolean =>
        inventoryFits(bagOf(entityId), additions, capacityOf(entityId));

    /** Whether the entity's species may take a mined deposit — the 'mine'
     * ability unlock (plugins/entity). Gated on profiles being mounted: no
     * entity plugin, no ability system, every hand takes everything. */
    const mayMine = (actorId: string): boolean => {
        if (!profiles) {
            return true;
        }
        const type = typeOf(actorId);
        return type !== undefined && profiles.hasAbility(type, 'mine');
    };

    const bagOf = (actorId: string): Inventory => {
        const existing = bags.get(actorId);
        if (existing) {
            return existing;
        }
        const fresh: Inventory = {};
        bags.set(actorId, fresh);
        return fresh;
    };

    const stockOf = (x: number, y: number): Inventory => {
        const key = `${x},${y}`;
        const existing = stocks.get(key);
        if (existing) {
            return existing;
        }
        const fresh: Inventory = {};
        stocks.set(key, fresh);
        return fresh;
    };

    // Internal: grows a stock toward its cap on the item's regrowth rhythm.
    // Tile-deposit resources (trees) grow their tile's deposit back with the
    // stock — the forest regrows where the trees were felled.
    const regrow = (stock: Inventory, itemId: string, tick: number, x: number, y: number) => {
        const rhythm = REGROW_RHYTHM[itemId];
        if (!rhythm) {
            return;
        }
        // Staggered rhythms so resources don't all pulse on the same tick
        if (tick % rhythm.every !== rhythm.offset) {
            return;
        }
        const current = stock[itemId] ?? 0;
        const cap = REGROW_CAPS[itemId] ?? 0;
        if (current < cap) {
            stock[itemId] = current + 1;
            growDeposit(x, y, itemId);
        }
    };

    // Internal: keeps a tile's deposit in step with its gatherable stock.
    // Finite deposits (trees, stone, iron) follow the stock — taking one
    // draws the tile's deposit down (deleting the entry at 0, which re-skins
    // the tile to its plain biome through tileSurfaceKey). Unlimited
    // deposits (sand, dirt) are never touched: a tile's sand cannot run out.
    const drawDeposit = (x: number, y: number, itemId: string) => {
        if (!isTileResource(itemId) || isUnlimitedResource(itemId)) {
            return;
        }
        const cell = world?.cellAt(x, y);
        if (!cell) {
            return;
        }
        const remaining = (cell.resources[itemId] ?? 0) - 1;
        if (remaining > 0) {
            cell.resources[itemId] = remaining;
        } else {
            delete cell.resources[itemId];
        }
    };

    // Internal: grows a tile's deposit back with its regrowing stock
    // (capped by the same REGROW_CAPS the stock obeys).
    const growDeposit = (x: number, y: number, itemId: string) => {
        if (!isTileResource(itemId) || isUnlimitedResource(itemId)) {
            return;
        }
        const cell = world?.cellAt(x, y);
        if (!cell) {
            return;
        }
        const cap = REGROW_CAPS[itemId] ?? 0;
        const current = cell.resources[itemId] ?? 0;
        if (current < cap) {
            cell.resources[itemId] = current + 1;
        }
    };

    /**
     * One canvas survey: seeds the cell stocks from the tiles. Tile DEPOSITS
     * (engine/types TerrainCell.resources — trees, stone, iron and the
     * unlimited sand/dirt) come first, then the biome's living stocks
     * (berries, mushrooms, coconuts), then the chance draws (forest vines,
     * shallows seaweed, beach shells, highland flints) and the sea's fish.
     * The canvas scan is row-major and the random draws run in that order,
     * so seeding is fully reproducible per seed. `canvas` is passed
     * explicitly so the routine works both in setup and after a terrain
     * regeneration (resurvey).
     */
    const survey = (context: PluginContext<World>, canvas: World['canvas']) => {
        arrayEach(canvas.cells, ({ value: cell }) => {
            const stock = stockOf(cell.x, cell.y);
            // The deposits ARE the tile's resources — seed their piles
            TILE_RESOURCES.forEach((resource) => {
                const count = cell.resources[resource] ?? 0;
                if (count > 0) {
                    stock[resource] = (stock[resource] ?? 0) + count;
                }
            });
            // Biome living stocks: berries in meadows, berries AND
            // mushrooms under forests, coconuts on beaches
            const biomeStock = BIOME_STOCKS[cell.biome];
            if (biomeStock) {
                Object.entries(biomeStock).forEach(([item, count]) => {
                    stock[item] = (stock[item] ?? 0) + count;
                });
            }
            // The woods hang vines — a finite material (the trade goods a
            // neighbour might hold; no regrowth)
            if (cell.biome === 'forest' && context.random() < VINE_CHANCE_PER_FOREST_CELL) {
                stock.vine = (stock.vine ?? 0) + 1;
            }
            // The shallows keep washed-ashore seaweed (regrowing); the deep
            // sea grows its own — every open-water cell stocks one
            if (cell.biome === 'shallows' && context.random() < SHALLOW_SEAWEED_CHANCE) {
                stock.seaweed = (stock.seaweed ?? 0) + 1;
            }
            if (cell.biome === 'ocean') {
                stock.seaweed = (stock.seaweed ?? 0) + 1;
            }
            // Beaches occasionally hide a shell; highlands occasionally
            // hide flint — finite resources, no regrowth
            if (cell.biome === 'beach' && context.random() < 0.5) {
                stock.shell = (stock.shell ?? 0) + 1;
            }
            if (cell.biome === 'highland' && context.random() < 0.3) {
                stock.flint = (stock.flint ?? 0) + 1;
            }
            // The sea stocks fish
            if (!cell.passable) {
                stock.fish = (stock.fish ?? 0) + 1;
            }
        });
    };

    return {
        id: 'inventory',
        label: 'Inventories & Exchange',

        of: bagOf,
        cellStock: stockOf,
        capacityOf: (entityId) => capacityOf(entityId),

        spawnKit: (actorId, kit) => {
            const bag = bagOf(actorId);
            const capacity = capacityOf(actorId);
            Object.entries(kit).forEach(([item, count]) => {
                // The kit fills the bag up to its SIZE — an overfull kit is
                // clamped, never spilled past the entity's carry
                const room = capacity - inventoryTotal(bag);
                if (room <= 0) {
                    return;
                }
                inventoryAdd(bag, item, Math.min(count, room));
            });
        },

        takeFromCell: (actor, itemId) => {
            // THE MINE GATE — the 'mine' ability unlock: stone and iron come
            // off a tile only for species that can mine (a bird hopping onto
            // a highland picks up nothing)
            if (MINED_ITEMS.includes(itemId) && !mayMine(actor.id)) {
                return false;
            }
            // THE CAPACITY GATE — the bag must hold one more unit; a full
            // hand cannot take (the caller re-plans)
            if (!canHold(actor.id, { [itemId]: 1 })) {
                return false;
            }
            const x = actor.position.x;
            const y = actor.position.y;
            const stock = stockOf(x, y);
            // UNLIMITED deposits (sand, dirt) cannot be exhausted: the pile
            // never decrements, so the tile hands them out forever
            if (isUnlimitedResource(itemId)) {
                if ((stock[itemId] ?? 0) <= 0) {
                    return false;
                }
            } else if (!inventoryRemove(stock, itemId, 1)) {
                return false;
            }
            inventoryAdd(bagOf(actor.id), itemId, 1);
            // Finite deposits draw down with the pile — the tile re-skins
            // when its last unit is taken
            drawDeposit(x, y, itemId);
            return true;
        },

        harvest: (actor, depositId, yieldId) => {
            const x = actor.position.x;
            const y = actor.position.y;
            // Unlimited deposits are raw ground — they are taken as
            // themselves, never converted into a product
            if (isUnlimitedResource(depositId)) {
                return false;
            }
            // THE CAPACITY GATE — checked BEFORE the deposit comes down so a
            // full bag leaves the tile untouched (atomicity: a failed felling
            // never drops a tree)
            if (!canHold(actor.id, { [yieldId]: 1 })) {
                return false;
            }
            const stock = stockOf(x, y);
            // The deposit must still be standing (a co-worker may have
            // felled the last tree during the wait) — atomic: a failed
            // check leaves stock, tile and bag untouched
            if (!inventoryRemove(stock, depositId, 1)) {
                return false;
            }
            // The tree is gone from the tile — the deposit draws down and
            // the last felled tree re-skins the tile to its plain biome
            drawDeposit(x, y, depositId);
            // The product lands in the bag — wood exists only as a yield
            inventoryAdd(bagOf(actor.id), yieldId, 1);
            // No log line — felling a tree is a solo beat, not a story
            // between entities (the log is a story teller)
            return true;
        },

        gather: (actor) => {
            const stock = stockOf(actor.position.x, actor.position.y);
            // Only FOOD is gathered by the hunger loop — materials (trees,
            // stone, iron, and the unlimited sand/dirt) stay on the tile:
            // an agent must not stand farming dirt forever when it could
            // walk toward real food. Trees are felled explicitly by the
            // lumber behaviour's chop (harvest, tree → wood).
            // Deterministic: the first food in the stock's insertion order.
            const available = inventoryEntries(stock).map((entry) => entry.item);
            const target = available.find((item) => itemDef(item).kind === 'food');
            // THE CAPACITY GATE — a full bag cannot gather (checked before
            // the stock gives the food up)
            if (target === undefined || !canHold(actor.id, { [target]: 1 })) {
                return null;
            }
            if (!inventoryRemove(stock, target, 1)) {
                return null;
            }
            inventoryAdd(bagOf(actor.id), target, 1);
            // No log line — foraging is a solo beat, not a story between
            // entities (the log is a story teller)
            return target;
        },

        consume: (actor, itemId) => {
            if (!inventoryRemove(bagOf(actor.id), itemId, 1)) {
                return false;
            }
            // No log line — eating/drinking is a solo beat too
            return true;
        },

        exchange: (giver, receiver, offer, request) => {
            // THE CAPACITY GATE — the receiver's bag must hold the whole
            // offer before anything moves (a full-handed trader takes
            // nothing)
            if (profiles && !canHold(receiver.id, offer)) {
                return false;
            }
            const succeeded = inventoryExchange(bagOf(giver.id), bagOf(receiver.id), offer, request);
            if (!succeeded) {
                return false;
            }
            if (world) {
                const offerParts = inventoryEntries(offer).map((entry) => label(entry.item, entry.count)).join(', ');
                const requestParts = inventoryEntries(request).map((entry) => label(entry.item, entry.count)).join(', ');
                world.events.emit({
                    kind: 'exchange',
                    actorId: giver.id,
                    message: `${giver.name} and ${receiver.name} trade: ${offerParts} for ${requestParts}.`,
                });
            }
            return true;
        },

        give: (giver, receiver, itemId, count) => {
            // THE CAPACITY GATE — the receiver must hold the gift before the
            // giver's hand opens
            if (profiles && !canHold(receiver.id, { [itemId]: count })) {
                return false;
            }
            const succeeded = inventoryTransfer(bagOf(giver.id), bagOf(receiver.id), itemId, count);
            if (succeeded && world) {
                world.events.emit({
                    kind: 'exchange',
                    actorId: giver.id,
                    message: `${giver.name} gives ${receiver.name} ${label(itemId, count)}.`,
                });
            }
            return succeeded;
        },

        cellsWithItem: (itemId) => {
            const found: TerrainCell[] = [];
            stocks.forEach((stock, key) => {
                if ((stock[itemId] ?? 0) > 0) {
                    const [x, y] = key.split(',').map(Number);
                    const cell = world?.cellAt(x, y);
                    if (cell) {
                        found.push(cell);
                    }
                }
            });
            return found;
        },

        setup: (context: PluginContext<World>) => {
            // Remember the context — resurvey() re-runs the survey with the
            // same deterministic stream after the terrain regenerates
            world = context.world;
            surveyContext = context;
            survey(context, world.canvas);
        },

        // After a terrain regeneration (World Size resize) the cell stocks no
        // longer match the canvas: wipes every stock and re-seeds from the
        // current canvas. Same seed + same row-major draw order → the survey
        // is reproducible, and the plugin's random stream keeps advancing
        // (stock shells/flint stay deterministic per canvas state).
        resurvey: () => {
            if (!world || !surveyContext) {
                return;
            }
            stocks.clear();
            survey(surveyContext, world.canvas);
        },

        dispose: () => {
            // Dropping the plugin wipes all bags and stocks — the environment
            // is gone entirely, exactly what a plugin swap means
            bags.clear();
            stocks.clear();
            // The fine clock resets with the environment
            minute = 0;
            world = null;
            surveyContext = null;
        },

        tick: (context: PluginContext<World>) => {
            const { world: active } = context;
            // One tick hook call = one world-minute — advance the fine clock
            minute = minute + 1;

            // Regrowth sweep over all stocked cells (deposits grow back
            // with their stocks — see regrow/growDeposit)
            stocks.forEach((stock, key) => {
                const [x, y] = key.split(',').map(Number);
                arrayEach(Object.keys(stock), ({ value: itemId }) => {
                    regrow(stock, itemId, minute, x, y);
                });
            });

            // Rain — fresh water pools gather on a SCATTERED subset of the
            // land. Each cell's pool roll comes from its own keyed stream
            // (world seed + minute + address), so the patchwork is fully
            // deterministic per seed and the plugin's roll stream stays
            // untouched by the sweep (the rain minute pins never drift).
            // Water never appears under every foot at once — the cast must
            // go and find the pools.
            if (context.random() < rainChance) {
                arrayEach(active.canvas.cells, ({ value: cell }) => {
                    if (!cell.passable) {
                        return;
                    }
                    const poolRoll = randomKeyed(
                        active.seed,
                        `pool:${minute}:${cell.x},${cell.y}`,
                    )();
                    if (poolRoll < POOL_CHANCE_PER_CELL) {
                        const stock = stockOf(cell.x, cell.y);
                        stock.water = Math.min(REGROW_CAPS.water, (stock.water ?? 0) + 1);
                    }
                });
                active.events.emit({ kind: 'weather', message: 'Rain sweeps the island.' });
            }
        },
    };
};
