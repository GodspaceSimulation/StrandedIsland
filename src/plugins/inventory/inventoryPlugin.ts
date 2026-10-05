// The inventory environment plugin.
//
// Gives every actor a personal inventory, fills the canvas with resource
// stocks by tile deposit (timber in forests, berries in meadows, fish in the
// sea, coconuts on beaches, stone/iron/flint on highlands, and the UNLIMITED
// sands and dirts of beaches and meadows), grows them back over time, rains
// fresh water onto land, and exposes the gathering + exchange actions that
// other plugins (behavior) and the god-view drive.
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
import type { Actor, TerrainCell, TileResource } from '../../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';
import type { World } from '../../engine/world';
import { itemDef, itemLabel } from './items';
import {
    inventoryAdd,
    inventoryEntries,
    inventoryExchange,
    inventoryRemove,
    inventoryTransfer,
    type Inventory,
} from './inventory';

export type InventoryPluginOptions = {
    /** Chance per tick that rain fills water stocks on all land. Default 0.12. */
    rainChance?: number;
};

/** Regrowth caps per item — stocks never exceed these counts. */
const REGROW_CAPS: Record<string, number> = {
    berry: 3,
    wood: 3,
    fish: 1,
    coconut: 2,
    water: 2,
    // shell / stone / iron / flint are finite — no regrowth
    // sand / dirt are unlimited — never depleted, never regrown
};

/** Regrowth rhythm per item: fires when `tick % every === offset`. */
const REGROW_RHYTHM: Record<string, { every: number; offset: number }> = {
    berry: { every: 3, offset: 2 },
    wood: { every: 6, offset: 4 },
    fish: { every: 4, offset: 0 },
    coconut: { every: 6, offset: 1 },
};

/** What each biome stocks as FOOD when the island is surveyed. The tile
 * deposits (wood, stone, iron, sand, dirt) come from the cells themselves —
 * see the survey below. */
const BIOME_STOCKS: Record<string, Inventory> = {
    meadow: { berry: 2 },
    forest: { berry: 1 },
    beach: { coconut: 1 },
    // Water cells hold fish, not drinking water (salt water)
};

/** Whether an item id is a tile deposit resource (wood/stone/iron/sand/dirt). */
const isTileResource = (itemId: string): itemId is TileResource =>
    (TILE_RESOURCES as readonly string[]).includes(itemId);

/** Whether an item id is an UNLIMITED deposit (sand/dirt — never depleted). */
const isUnlimitedResource = (itemId: string): boolean =>
    (UNLIMITED_TILE_RESOURCES as readonly string[]).includes(itemId);

/** Human readable "1 Fish"/"2 Berries" fragment for log lines. */
const label = itemLabel;

export type InventoryPlugin = WorldPlugin & {
    /** An actor's bag — auto-created (empty) on first touch. */
    of(actorId: string): Inventory;
    /** Resource stock standing on a canvas cell. */
    cellStock(x: number, y: number): Inventory;
    /** Takes one `itemId` from the cell the actor stands on. */
    takeFromCell(actor: Actor, itemId: string): boolean;
    /** Gathers one available item from the actor's cell. Returns the item id. */
    gather(actor: Actor): string | null;
    /** Removes one `itemId` from the actor's bag (eating / drinking). */
    consume(actor: Actor, itemId: string): boolean;
    /** Actor-to-actor exchange: `giver` hands `offer`, receives `request`. */
    exchange(giver: Actor, receiver: Actor, offer: Inventory, request: Inventory): boolean;
    /** One-way transfer — the gift primitive. */
    give(giver: Actor, receiver: Actor, itemId: string, count: number): boolean;
    /** All cells whose stock currently holds `itemId`. */
    cellsWithItem(itemId: string): TerrainCell[];
    /** Seeds an actor's bag with starting items. */
    spawnKit(actorId: string, kit: Inventory): void;
    /** Wipes and re-seeds every cell stock from the current canvas (resize flow). */
    resurvey(): void;
};

export const inventoryPlugin = (options: InventoryPluginOptions = {}): InventoryPlugin => {
    const rainChance = options.rainChance ?? 0.12;

    // Actor bags and cell stocks, keyed by id / "x,y"
    const bags = new Map<string, Inventory>();
    const stocks = new Map<string, Inventory>();

    // The world reference arrives with setup; action hooks (exchange/give)
    // need it for event emission and canvas lookups before any tick runs.
    let world: World | null = null;
    // The plugin context captured in setup — resurvey() re-runs the canvas
    // survey with the same deterministic random stream after a regeneration
    let surveyContext: PluginContext | null = null;

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
    // Tile-deposit resources (wood) grow their tile's deposit back with the
    // stock — the forest regrows where the timber was cut.
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
    // Finite deposits (wood, stone, iron) follow the stock — taking one
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
     * (engine/types TerrainCell.resources — wood, stone, iron and the
     * unlimited sand/dirt) come first, then the biome's FOOD stock, then the
     * shell/flint chance draws and the sea's fish. The canvas scan is
     * row-major and the random draws run in that order, so seeding is fully
     * reproducible per seed. `canvas` is passed explicitly so the routine
     * works both in setup and after a terrain regeneration (resurvey).
     */
    const survey = (context: PluginContext, canvas: World['canvas']) => {
        arrayEach(canvas.cells, ({ value: cell }) => {
            const stock = stockOf(cell.x, cell.y);
            // The deposits ARE the tile's resources — seed their piles
            TILE_RESOURCES.forEach((resource) => {
                const count = cell.resources[resource] ?? 0;
                if (count > 0) {
                    stock[resource] = (stock[resource] ?? 0) + count;
                }
            });
            // Biome food: berries in meadows, berries under forests,
            // coconuts on beaches
            const biomeStock = BIOME_STOCKS[cell.biome];
            if (biomeStock) {
                Object.entries(biomeStock).forEach(([item, count]) => {
                    stock[item] = (stock[item] ?? 0) + count;
                });
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

        spawnKit: (actorId, kit) => {
            const bag = bagOf(actorId);
            Object.entries(kit).forEach(([item, count]) => {
                inventoryAdd(bag, item, count);
            });
        },

        takeFromCell: (actor, itemId) => {
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

        gather: (actor) => {
            const stock = stockOf(actor.position.x, actor.position.y);
            // Only FOOD is gathered by the hunger loop — materials (wood,
            // stone, iron, and the unlimited sand/dirt) stay on the tile:
            // an agent must not stand farming dirt forever when it could
            // walk toward real food. Deterministic: the first food in the
            // stock's insertion order.
            const available = inventoryEntries(stock).map((entry) => entry.item);
            const target = available.find((item) => itemDef(item).kind === 'food');
            if (target === undefined || !inventoryRemove(stock, target, 1)) {
                return null;
            }
            inventoryAdd(bagOf(actor.id), target, 1);
            if (world) {
                world.events.emit({
                    kind: 'gather',
                    actorId: actor.id,
                    message: `${actor.name} gathers ${label(target, 1)}.`,
                });
            }
            return target;
        },

        consume: (actor, itemId) => {
            if (!inventoryRemove(bagOf(actor.id), itemId, 1)) {
                return false;
            }
            if (world) {
                // Food is eaten, drinks are drunk — flavor follows the kind
                const verb = itemDef(itemId).kind === 'drink' ? 'drinks' : 'eats';
                world.events.emit({
                    kind: 'consume',
                    actorId: actor.id,
                    message: `${actor.name} ${verb} ${label(itemId, 1)}.`,
                });
            }
            return true;
        },

        exchange: (giver, receiver, offer, request) => {
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

        setup: (context: PluginContext) => {
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
            world = null;
            surveyContext = null;
        },

        tick: (context: PluginContext) => {
            const { world: active } = context;
            const tick = active.ticker.ticks();

            // Regrowth sweep over all stocked cells (deposits grow back
            // with their stocks — see regrow/growDeposit)
            stocks.forEach((stock, key) => {
                const [x, y] = key.split(',').map(Number);
                arrayEach(Object.keys(stock), ({ value: itemId }) => {
                    regrow(stock, itemId, tick, x, y);
                });
            });

            // Rain — fresh water pools on every walkable cell
            if (context.random() < rainChance) {
                arrayEach(active.canvas.cells, ({ value: cell }) => {
                    if (cell.passable) {
                        const stock = stockOf(cell.x, cell.y);
                        stock.water = Math.min(REGROW_CAPS.water, (stock.water ?? 0) + 1);
                    }
                });
                active.events.emit({ kind: 'weather', message: 'Rain sweeps the island.' });
            }
        },
    };
};
