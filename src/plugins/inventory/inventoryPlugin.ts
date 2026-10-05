// The inventory environment plugin.
//
// Gives every actor a personal inventory, fills the canvas with resource
// stocks by biome (berries in meadows, wood in forests, fish in the sea,
// coconuts on beaches, stone/flint on highlands), grows them back over time,
// rains fresh water onto land, and exposes the gathering + exchange actions
// that other plugins (behavior) and the god-view drive.
//
// INSTALL ORDER: after the terrain plugin — setup scans the canvas to seed
// resources. Without a canvas it simply starts with no resources.

import { arrayEach } from '@presource/core';
import type { Actor, TerrainCell } from '../../engine/types';
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
    // shell / stone / flint are finite — no regrowth
};

/** Regrowth rhythm per item: fires when `tick % every === offset`. */
const REGROW_RHYTHM: Record<string, { every: number; offset: number }> = {
    berry: { every: 3, offset: 2 },
    wood: { every: 6, offset: 4 },
    fish: { every: 4, offset: 0 },
    coconut: { every: 6, offset: 1 },
};

/** What each biome naturally stocks when the island is surveyed. */
const BIOME_STOCKS: Record<string, Inventory> = {
    meadow: { berry: 2 },
    forest: { berry: 1, wood: 2 },
    beach: { coconut: 1 },
    highland: { stone: 1 },
    // Water cells hold fish, not drinking water (salt water)
};

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

    // Internal: grows a stock toward its cap on the item's regrowth rhythm
    const regrow = (stock: Inventory, itemId: string, tick: number) => {
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
        }
    };

    /**
     * One canvas survey: seeds the cell stocks by biome. The canvas scan is
     * row-major and the random draws (shell/flint chances) run in that
     * order, so seeding is fully reproducible per seed. `canvas` is passed
     * explicitly so the routine works both in setup and after a terrain
     * regeneration (resurvey).
     */
    const survey = (context: PluginContext, canvas: World['canvas']) => {
        arrayEach(canvas.cells, ({ value: cell }) => {
            const biomeStock = BIOME_STOCKS[cell.biome];
            if (biomeStock) {
                const stock = stockOf(cell.x, cell.y);
                Object.entries(biomeStock).forEach(([item, count]) => {
                    stock[item] = (stock[item] ?? 0) + count;
                });
            }
            // Beaches occasionally hide a shell; highlands occasionally
            // hide flint — finite resources, no regrowth
            if (cell.biome === 'beach' && context.random() < 0.5) {
                const stock = stockOf(cell.x, cell.y);
                stock.shell = (stock.shell ?? 0) + 1;
            }
            if (cell.biome === 'highland' && context.random() < 0.3) {
                const stock = stockOf(cell.x, cell.y);
                stock.flint = (stock.flint ?? 0) + 1;
            }
            // The sea stocks fish
            if (!cell.passable) {
                const stock = stockOf(cell.x, cell.y);
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
            const stock = stockOf(actor.position.x, actor.position.y);
            if (!inventoryRemove(stock, itemId, 1)) {
                return false;
            }
            inventoryAdd(bagOf(actor.id), itemId, 1);
            return true;
        },

        gather: (actor) => {
            const stock = stockOf(actor.position.x, actor.position.y);
            // First available item — deterministic (insertion order)
            const available = inventoryEntries(stock).map((entry) => entry.item);
            const target = available[0];
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

            // Regrowth sweep over all stocked cells
            stocks.forEach((stock, key) => {
                arrayEach(Object.keys(stock), ({ value: itemId }) => {
                    regrow(stock, itemId, tick);
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
