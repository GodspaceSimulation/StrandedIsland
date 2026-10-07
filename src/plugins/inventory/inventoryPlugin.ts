// The inventory environment plugin.
//
// Gives every actor a personal inventory, fills the canvas with resource
// stocks by tile deposit (the voxel-derived ground supply — grass, dirt,
// sand, stone — mirrors every matching dry column; trees stand in the
// forests' persistent fine-scale records; berries AND mushrooms in the
// meadows and woods, fish AND seaweed in the sea, coconuts on beaches,
// iron lodes in the highlands, flints, vines, the sea's fish and
// seaweed), grows the living stocks back over time, rains fresh water onto
// the land in scattered pools, and exposes the gathering + harvest +
// exchange actions that other plugins (behavior, lumber) and the god-view
// drive.
//
// TILE DEPOSITS: every canvas cell carries `resources` (engine/types.ts
// TileResources) — written by the terrain generator, kept in sync here. The
// survey seeds each cell's gatherable stock from its deposits; taking an
// UNLIMITED deposit (the ground supply: grass, dirt, sand, stone) never
// decrements the tile — the ground hands it out forever; a FINITE deposit
// (iron) draws down with its stock. The TREE deposit is the standing-tree
// MIRROR of the persistent fine-scale forest records (plugins/terrain
// ForestStand): it moves only when a tree is fully felled (its wood pool
// chopped to 0) or when the forest ecology recruits one — the wood itself
// comes off the trees' pools, one unit per chop (see harvest + the forest
// plugin mounted below).
//
// WOOD IS NOT A NATURAL RESOURCE — it exists only as the product of
// cutting a standing tree's wood pool.
//
// INSTALL ORDER: after the terrain plugin — setup scans the canvas to seed
// resources. Without a canvas it simply starts with no resources. The
// plugins/forest ecology MOUNTS its harvest provider here (mountForest) —
// without it, harvesting consumes whole tree deposit units (the
// pre-ecology behavior).

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

/** Regrowth caps per item — stocks never exceed these counts. The TREE is
 * no longer a regrowing stock: the standing-tree count is the MIRROR of the
 * persistent fine-scale forest records, moved only by full fells and the
 * plugins/forest ecology's recruitment (the old toy 60-minute tree clock is
 * gone — trees grow wood biologically, plugins/forest). */
const REGROW_CAPS: Record<string, number> = {
    berry: 3,
    fish: 1,
    coconut: 2,
    water: 2,
    // The richer map's foods: mushrooms sprout back in the woods,
    // seaweed washes back in every other tide
    mushroom: 2,
    seaweed: 1,
    // The construction materials replenish (the build projects consume
    // dozens of vines and fronds over a campaign — finite stocks would
    // starve the later blueprints): a vine re-hangs on its own rhythm,
    // a frond sheds beneath the standing trees (see the frond shed below)
    vine: 1,
    frond: 1,
    // R2 — the berry bush regrows the berries it bears (the stand itself is a
    // permanent meadow/forest feature; only its berry stock draws down and
    // refills, on the bush rhythm below)
    bush: 2,
    // shell / iron / flint are finite — no regrowth
    // grass / stone / sand / dirt are the unlimited ground supply — never
    // depleted, never regrown
};

/**
 * Regrowth rhythm per item, in WORLD MINUTES: fires when
 * `minute % every === offset`. (The values pin the rhythm to WORLD MINUTES,
 * so the view scale never moves it.) The vine rhythm fires late and
 * staggered so the early-game stock pins and the pre-construction runs are
 * untouched (a vine cell sits at its cap of 1 until harvested).
 */
const REGROW_RHYTHM: Record<string, { every: number; offset: number }> = {
    berry: { every: 30, offset: 20 },
    fish: { every: 40, offset: 0 },
    coconut: { every: 60, offset: 10 },
    mushroom: { every: 40, offset: 15 },
    seaweed: { every: 50, offset: 25 },
    vine: { every: 80, offset: 30 },
    // R2 — the berry bush is NOT listed here: its stock would vanish from
    // this sweep once plucked to zero (the depletion-vanishing the frond
    // shed documents), so a DEDICATED pass (the BUSH_RHYTHM over the
    // bushCells registry, below) refills it instead
    // The frond shed runs on its own rhythm (FROND_RHYTHM below) — it is
    // keyed off the TREE stock, not the frond key, so it is not listed here
};

/**
 * The FROND SHED — palm fronds drop beneath the standing trees on this
 * rhythm (every 60 world minutes at offset 45): the thatch/cloth chains'
 * raw stock. Keyed off the cell's TREE stock (a treed cell sheds; a
 * harvested-bare one regrows its shed as long as trees stand), NOT the
 * frond key — the regrowth sweep iterates stock keys, and a frond taken to
 * zero would otherwise delete itself out of the sweep forever. The offset
 * pins the FIRST shed at minute 45, past every pre-construction stock pin
 * (the behavior and lumber plugin runs end at minutes 35/40).
 */
const FROND_RHYTHM = { every: 60, offset: 45 };
const FROND_SELLER = 'tree';

/**
 * R2 — THE FRESH-WATER REPLENISHMENT. Lakes and ponds (the interior
 * wetland basines the terrain generator carves) and the dry SHORE ring
 * beside them stock drinking water. The survey seeds that stock once; this
 * rhythm tops it back up (the basin never dries, so the stock refills on a
 * staggered world-minute cadence keyed off the same fine clock as the other
 * rhythms). `every` 30 with offset 15 staggers the refill away from the
 * rain-pool pulse (the rain runs on its own keyed streams).
 */
const FRESH_WATER_RHYTHM = { every: 30, offset: 15 };

/**
 * R2 — THE BERRY-BUSH REPLENISHMENT. A plucked berry bush refills its berry
 * stock on this staggered cadence (keyed off the fine clock, like the other
 * rhythms). The dedicated tick pass (the BUSH_RHYTHM sweep below) runs it
 * over the bushCells registry — the standing plants — so a fully-plucked
 * bush (its `bush` stock drawn to zero and out of the generic regrowth
 * sweep) still regrows. `every` 40 with offset 25 clears the
 * pre-construction stock pins (which end at minute 35) and staggers the
 * refills away from the berry (offset 20) and vine (offset 30) pulses.
 */
const BUSH_RHYTHM = { every: 40, offset: 25 };

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

/** Chance a surveyed FOREST cell hangs a vine — the woods' material
 * (regrowing on its own rhythm since the build projects consume it —
 * see REGROW_CAPS; a harvested vine re-hangs after the regrowth rest). */
const VINE_CHANCE_PER_FOREST_CELL = 0.35;

/** Chance a surveyed SHALLOW cell keeps a washed-ashore seaweed — the
 * shallows' second sea stock beside the fish (seaweed regrows). */
const SHALLOW_SEAWEED_CHANCE = 0.5;

/**
 * R2 — the BERRY BUSH: a standing berry plant that grows in the meadow and
 * forest undergrowth. Seeded on a fully DETERMINISTIC per-coordinate hash
 * (the fnv-1a mix of the cell address, folded to [0,1)) with NO random-stream
 * draw, so seeding it never shifts the survey's other pins (the vine/shell/
 * flint draws keep their exact stream order) and the placement is stable for
 * a given island (the same address carries the same bush, seed for seed).
 * A berry bush stands on the cell when its hash lands under the chance.
 */
const BUSH_CHANCE = 0.3;

/** The fnv-1a coordinate hash, folded to [0,1) — the bush's placement roll. */
const bushAt = (x: number, y: number): boolean => {
    let h = 2166136261;
    const mix = (n: number): void => {
        h ^= n + 0x9e3779b9 + (h << 6) + (h >>> 2);
    };
    mix(x);
    mix(y);
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 13;
    return ((h >>> 0) % 1000) / 1000 < BUSH_CHANCE;
};

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

/**
 * The FOREST HARVEST PROVIDER — the plugins/forest ecology mounts itself
 * into the inventory (mountForest) so the harvest action can cut wood off
 * the trees' pools. One method: take one wood from a tile's stand — the
 * exact fine spot's tree first, else the deterministic nearest standing
 * tree inside the same tile; folds the tree's lazy growth, removes the
 * record when the pool hits 0. `felled` reports whether the source tree
 * died (the caller syncs the standing-tree mirrors). Null: no standing
 * tree on the tile (nothing to cut — the harvest fails atomically).
 */
export type ForestEcology = {
    chop(parent: { x: number; y: number }, fine: { x: number; y: number } | undefined): { felled: boolean } | null;
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
     * Cuts one unit of wood off a standing tree (depositId 'tree') into the
     * agent's bag (yieldId 'wood'). With the forest ecology mounted: the
     * tree's pool shrinks by one (the actor's fine spot's tree first, else
     * the deterministic nearest in the tile) and the tree STANDS while wood
     * remains — a fully felled tree (pool 0) leaves the record and the
     * standing-tree mirrors. Without the provider: the legacy whole-tree
     * consumption (one deposit unit per wood). Fails without side effects
     * when the tile holds no trees (or the deposit is unlimited — those are
     * gathered raw with takeFromCell, never converted). Capacity is gated
     * BEFORE anything moves (atomicity: a full bag never fells).
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
    /** The forest ecology mounts its harvest provider (plugins/forest). */
    mountForest(provider: ForestEcology): void;
    /** The forest ecology unmounts (plugin swap) — legacy harvest resumes. */
    unmountForest(): void;
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
    // R2 — the fresh-water cells (key "x,y"): the lake/pond wetland cells AND
    // the dry shore ring beside them. The survey fills this from the canvas;
    // the tick's replenishment sweep tops their water stock back up on the
    // FRESH_WATER_RHYTHM (the basin's supply is the island's fresh water).
    const freshWaterCells = new Set<string>();

    // R2 — the BERRY-BUSH CELLS (key "x,y"): every meadow/forest cell the
    // survey seeded a standing berry bush on. The bush is a PERMANENT stand —
    // plucking its berries draws the `bush` stock to zero (and a zeroed stock
    // key would fall out of the generic regrowth sweep forever — the same
    // depletion-vanishing the frond shed documents), so the stand persists in
    // this registry and a dedicated tick pass (the BUSH_RHYTHM, below) tops
    // each bush's berry stock back up to the cap. Cleared + refilled by each
    // survey (resurvey rebuilds it from the regenerated canvas).
    const bushCells = new Set<string>();

    // The plugin's fine clock — one world-minute per tick hook call (the
    // world sub-steps its steps). The regrowth rhythm reads THIS, not the
    // ticker's step count: the ticker only counts steps, and within one
    // step every minute must see its own time.
    let minute = 0;

    // The world reference arrives with setup; action hooks (exchange/give)
    // need it for event emission and canvas lookups before any tick runs.
    let world: World | null = null;
    // The terrain handle — the biological boundary reads the persistent
    // stands through it (a tree harvest without the forest ecology mounted
    // is refused on stand-bearing tiles; see harvest)
    let terrain: { forestOf(x: number, y: number): unknown } | null = null;
    // The plugin context captured in setup — resurvey() re-runs the canvas
    // survey with the same deterministic random stream after a regeneration
    let surveyContext: PluginContext<World> | null = null;
    // The mounted forest ecology (plugins/forest) — the harvest provider
    // that cuts wood off the trees' pools. Null: the legacy whole-tree
    // harvest path — which serves ONLY stand-less terrain (see harvest).
    let forest: ForestEcology | null = null;

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
    // Finite deposits (iron — and the legacy tree path) follow the stock —
    // taking one draws the tile's deposit down (deleting the entry at 0
    // falls the surface derivation through to the tile's next landmark /
    // ground / voxel look through tileSurfaceKey: an exhausted iron lode
    // reads its stone ground, a clearcut wood KEEPS its forest canopy —
    // the forest voxel stands). Unlimited deposits are never touched: a
    // tile's ground supply cannot run out.
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
        // R2 — the fresh-water map: keyed by "x,y" it holds every cell that
        // stocks fresh water (the lake/pond wetland cells AND the dry shore
        // ring beside them). Rebuilt each survey (the canvas may have
        // regenerated). The half-extents are centered like the terrain grid.
        freshWaterCells.clear();
        // R2 — the berry-bush registry is rebuilt from the (re)generated
        // canvas: a cleared set so a resurvey never leaves stale stands
        bushCells.clear();
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const basinAt = (x: number, y: number): boolean => {
            if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
                return false;
            }
            const neighbor = canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
            return neighbor.biome === 'lake' || neighbor.biome === 'pond';
        };
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
            // R2 — the BERRY BUSH: a standing berry plant in the meadow and
            // forest undergrowth. Seeded on the deterministic coordinate hash
            // (bushAt — no random-stream draw, so the other pins are
            // untouched). The bush's stock is the berries it bears; foraging
            // plucks them and the regrowth sweep refills the stand.
            if ((cell.biome === 'meadow' || cell.biome === 'forest') && bushAt(cell.x, cell.y)) {
                stock.bush = (stock.bush ?? 0) + 1;
                // Track the standing plant (the regrow pass's registry)
                bushCells.add(`${cell.x},${cell.y}`);
            }
            // R2 — THE FRESH WATER: a lake/pond wetland cell stocks drinking
            // water, and so does the DRY SHORE ring beside one (a land actor
            // gathers the water from either the wetland or its shore — the
            // thirst ladder's collect reads the cell's water stock). The cell
            // is a fresh-water cell iff it is a basin OR any of its 8
            // neighbors is.
            const isBasin = cell.biome === 'lake' || cell.biome === 'pond';
            const nearBasin = isBasin ||
                basinAt(cell.x - 1, cell.y) || basinAt(cell.x + 1, cell.y) ||
                basinAt(cell.x, cell.y - 1) || basinAt(cell.x, cell.y + 1) ||
                basinAt(cell.x - 1, cell.y - 1) || basinAt(cell.x + 1, cell.y - 1) ||
                basinAt(cell.x - 1, cell.y + 1) || basinAt(cell.x + 1, cell.y + 1);
            if (nearBasin) {
                stock.water = (stock.water ?? 0) + 1;
                freshWaterCells.add(`${cell.x},${cell.y}`);
            }
            // The woods hang vines — a regrowing material (the trade goods
            // a neighbour might hold; the construction chains' rope stock)
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
            // A LIVING TREE IS NEVER BAGGED — the standing `tree` stock is
            // the mirror of the forest records (plugins/forest), not a
            // pile of loose lumber. A tree's wood is taken by the HARVEST
            // (the chop converts pool wood into the bag); picking the tree
            // itself up would treat a living thing as a material bag item.
            if (itemId === 'tree') {
                return false;
            }
            // THE MINE GATE — the 'mine' ability unlock: stone and iron come
            // off a tile only for species that can mine (a bird hopping onto
            // a highland picks up nothing). The gate limits WHO works the
            // ground — the stone supply itself is infinite (the ground
            // mirrors it, unlimited takes below)
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
            // UNLIMITED ground-supply deposits (grass, stone, sand, dirt)
            // cannot be exhausted: the pile never decrements, so the tile
            // hands them out forever — only the bag's capacity gates
            if (isUnlimitedResource(itemId)) {
                if ((stock[itemId] ?? 0) <= 0) {
                    return false;
                }
            } else if (!inventoryRemove(stock, itemId, 1)) {
                return false;
            }
            inventoryAdd(bagOf(actor.id), itemId, 1);
            // Finite deposits draw down with the pile — an exhausted
            // landmark falls through the surface derivation to the tile's
            // next look (an exhausted iron lode reads its stone ground)
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
            // THE CAPACITY GATE — checked BEFORE anything moves so a
            // full bag leaves the tile untouched (atomicity: a failed
            // cut never wounds a tree)
            if (!canHold(actor.id, { [yieldId]: 1 })) {
                return false;
            }
            const stock = stockOf(x, y);
            // ── The forest ecology path — wood comes off the tree's POOL ──
            // One chop takes one wood; the tree STANDS while wood remains
            // and only a fully felled tree (pool 0) leaves the record. The
            // standing-tree mirrors sync inside the chop itself (the
            // ecology owns them — no ghosts, no stale deposits). The exact
            // fine spot's tree is cut first; a bare fine cell cuts the
            // deterministic nearest tree inside the same tile.
            if (depositId === 'tree' && forest) {
                const fine = world?.subOf(actor.id);
                const outcome = forest.chop({ x, y }, fine);
                if (!outcome) {
                    // No standing tree on the tile — nothing moved
                    return false;
                }
                // The wood lands in the bag — wood exists only as a yield
                inventoryAdd(bagOf(actor.id), yieldId, 1);
                return true;
            }
            // ── THE BIOLOGICAL BOUNDARY — a living tree harvests ONLY
            // through its owner. On terrain carrying a persistent stand
            // (plugins/terrain ForestStand — the scenario's default
            // island), a tree harvest with NO mounted forest provider is
            // refused BEFORE any mutation: the legacy whole-tree path
            // would draw the standing-tree mirrors down without reaching
            // the records, and a later remount would restore the count —
            // the same wood reharvestable forever (the unbounded
            // remove/cut/remount farm). Wood conservation beats tool
            // availability: while the ecology is away, the woods simply
            // cannot be cut (agents re-plan; the lumber rung declines
            // through the failed harvest, no wedge).
            if (depositId === 'tree' && terrain?.forestOf(x, y)) {
                return false;
            }
            // ── The legacy path (no forest ecology mounted, NO persistent
            // stand underfoot) — one whole tree deposit unit per wood. This
            // serves fixtures and older terrain whose trees are plain tile
            // deposits with no biological records: taking one draws the
            // tile's deposit down with the stock (nothing can resurrect it
            // — no stand exists to restore from). The deposit must still be
            // standing (a co-worker may have taken the last unit during the
            // wait) — atomic: a failed check leaves stock, tile and bag
            // untouched
            if (!inventoryRemove(stock, depositId, 1)) {
                return false;
            }
            // The tree is gone from the tile — the deposit draws down. The
            // tile's LOOK keeps its forest canopy: tileSurfaceKey reads the
            // standing forest voxel, so even a legacy clearcut never
            // re-skins the wood to its plain biome
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
            // A loose food on the cell is picked first (the existing path)
            if (target !== undefined) {
                // THE CAPACITY GATE — a full bag cannot gather (checked
                // before the stock gives the food up)
                if (!canHold(actor.id, { [target]: 1 }) || !inventoryRemove(stock, target, 1)) {
                    return null;
                }
                inventoryAdd(bagOf(actor.id), target, 1);
                return target;
            }
            // R2 — THE BERRY BUSH: no loose food on the cell, but a berry
            // bush stands here → pluck a berry off it. The bush's stock is
            // the berries it bears; plucking draws the stand down (it
            // regrows on the bush rhythm) and the berry lands in the bag
            // (the bush FURNISHES the food — it is a concrete plant, not an
            // abstract item). The capacity gate checks the BERRY (the
            // gathered good), not the bush.
            if ((stock.bush ?? 0) > 0 && canHold(actor.id, { berry: 1 })) {
                if (inventoryRemove(stock, 'bush', 1)) {
                    inventoryAdd(bagOf(actor.id), 'berry', 1);
                    return 'berry';
                }
            }
            // No log line — foraging is a solo beat, not a story between
            // entities (the log is a story teller)
            return null;
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
            // The TERRAIN HANDLE — the biological boundary (harvest) reads
            // the persistent stands through it. Resolved through the plugin
            // roster so the boundary works regardless of mount order (the
            // forest plugin re-mounts its provider over this handle).
            const roster = context.world.plugins.list();
            const terrainPlugin = roster.find((plugin) => plugin.id === 'island-terrain') as
                | { forestOf(x: number, y: number): unknown }
                | undefined;
            terrain = terrainPlugin ?? null;
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

        mountForest: (provider) => {
            forest = provider;
        },

        unmountForest: () => {
            forest = null;
        },

        dispose: () => {
            // Dropping the plugin wipes all bags and stocks — the environment
            // is gone entirely, exactly what a plugin swap means
            bags.clear();
            stocks.clear();
            // R2 — the fresh-water cell set goes with the environment
            freshWaterCells.clear();
            // The fine clock resets with the environment; the mounted forest
            // provider and the terrain handle go with it (both re-resolve on
            // the next setup)
            minute = 0;
            world = null;
            surveyContext = null;
            forest = null;
            terrain = null;
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

            // R2 — THE FRESH-WATER REPLENISHMENT. Every fresh-water cell
            // (the lake/pond wetlands + their dry shore ring, tracked in
            // freshWaterCells by the survey) tops its water stock back up to
            // the cap on the FRESH_WATER_RHYTHM — the basin's supply is the
            // island's standing fresh water, so a drawn-down pool refills on
            // its own cadence (independent of the scattered rain-pool pulse).
            if (minute % FRESH_WATER_RHYTHM.every === FRESH_WATER_RHYTHM.offset) {
                freshWaterCells.forEach((key) => {
                    const [x, y] = key.split(',').map(Number);
                    const stock = stockOf(x, y);
                    const current = stock.water ?? 0;
                    if (current < (REGROW_CAPS.water ?? 0)) {
                        stock.water = current + 1;
                    }
                });
            }

            // THE FROND SHED — every treed cell (tree stock standing) sheds
            // one frond on the frond rhythm, up to the cap. Fronds are not
            // tile deposits (nothing re-skins; the shed is undergrowth), so
            // only the gatherable stock grows. Keyed off the TREE stock so a
            // harvested-bare frond pile regrows as long as trees stand.
             if (minute % FROND_RHYTHM.every === FROND_RHYTHM.offset) {
                 stocks.forEach((stock) => {
                     const trees = stock[FROND_SELLER] ?? 0;
                     if (trees > 0) {
                         const current = stock.frond ?? 0;
                         if (current < (REGROW_CAPS.frond ?? 0)) {
                             stock.frond = current + 1;
                         }
                     }
                 });
             }

            // R2 — THE BERRY-BUSH REPLENISHMENT. Every standing berry bush
            // (the surveyed meadow/forest plants, tracked in bushCells) tops
            // its berry stock back up to the cap on the BUSH_RHYTHM. Run over
            // the registry — NOT the generic regrowth sweep — so a fully
            // plucked bush (its `bush` stock down to zero, out of the sweep's
            // keyed iteration) still regrows: the stand persists in the
            // registry even when its berries are gathered away.
            if (minute % BUSH_RHYTHM.every === BUSH_RHYTHM.offset) {
                bushCells.forEach((key) => {
                    const [x, y] = key.split(',').map(Number);
                    const stock = stockOf(x, y);
                    const current = stock.bush ?? 0;
                    if (current < (REGROW_CAPS.bush ?? 0)) {
                        stock.bush = current + 1;
                    }
                });
            }
         },
     };
};
