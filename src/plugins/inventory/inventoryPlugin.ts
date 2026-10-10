// The inventory environment plugin.
//
// Gives every actor a personal inventory, fills the canvas with resource
// stocks by tile deposit (the voxel-derived ground supply — grass, dirt,
// sand — mirrors every matching dry column; GRAVEL supplies nothing — it is
// terrain, not a resource; FINITE STONE stands only on the localized rock
// sites (the highland peaks + the generator's peak-fallback heap); trees
// stand in the forests' persistent fine-scale records; berries AND
// mushrooms in the meadows and woods, fish AND seaweed in the water (the
// sea AND the impassable fresh basins — R4/R5, fished from the dry shore),
// coconuts on beaches, iron lodes in the highlands, flints, vines, the
// sea's fish and seaweed), grows the living stocks back over time, keeps the
// rain as WEATHER (the event — R4: rain no longer scatters drinking-water
// pools onto the land; the fresh water stands in the lake/pond basins, the
// river courses and their dry shore rings — the basins refill on their own
// rhythm, and a RIVER'S WATER IS INEXHAUSTIBLE: the flowing course hands
// its drink out forever, never drawn down (the takeFromCell river branch)),
// and exposes the
// gathering + harvest + exchange actions that other plugins (behavior,
// lumber) and the god-view drive.
//
// TILE DEPOSITS: every canvas cell carries `resources` (engine/types.ts
// TileResources) — written by the terrain generator, kept in sync here. The
// survey seeds each cell's gatherable stock from its deposits; taking an
// UNLIMITED deposit (the ground supply: grass, dirt, sand) never decrements
// the tile — the ground hands it out forever; a FINITE deposit (stone — the
// localized rock sites, iron — the lodes) draws down with its stock and the
// canvas icon drops when it empties (drawDeposit deletes the entry at 0).
// The TREE deposit is the standing-tree
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
import { type Position3D } from '@godspace/core';
import type { Actor, TerrainCell, TileResource } from '../../engine/types';
import { TILE_RESOURCES, UNLIMITED_TILE_RESOURCES, isFreshBasin } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import { itemDef, itemLabel, itemWeight, inventoryWeight, MINED_ITEMS } from './items';
import {
    inventoryAdd,
    inventoryEntries,
    inventoryExchange,
    inventoryRemove,
    inventoryTransfer,
    type Inventory,
} from './inventory';
import type { EntityProfiles } from '../entity/entityPlugin';

export type InventoryPluginOptions = {
    /** Chance per world-minute that a rain WEATHER event sweeps the island
     * (the log/story read it). R4 — rain gathers no water any more: the
     * fresh-water supply is the basins + their shore ring, so this option
     * now shapes only the weather cadence. Default 0.0127 (≈ 0.76 rains
     * per world hour). */
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
 * gone — trees grow wood biologically, plugins/forest).
 *
 * ABUNDANCE — these are the island's harvestible foods and materials, and
 * the cast forages them constantly (the hunger ladder, the foraging birds,
 * the build chains). The old caps (berry 3 / mushroom 2 / coconut 2 / fish 1
 * / seaweed 1 / vine 1 / bush 2) left the map picked bare within a day —
 * the caps are raised so a harvested cell refills toward a stock that READS
 * abundant, while every rhythm, eligibility rule and finite resource stays
 * exactly as tuned before.
 *
 * R7 — the caps MATCH the enriched forest seeding (see BIOME_STOCKS): berry
 * 5 → 6 and mushroom 4 → 5 keep the equilibrium a clear step above the
 * forest's seeded 4 / 3 (a picked cell refills PAST its starting abundance),
 * and the vine cap 2 → 3 lets the denser 0.6-chance vine map re-hang richer
 * per cell for the build chains. EXPORTED for the resource-profile tests
 * (plugins/inventory/forest-resource.test.ts pins this tuning table). */
export const REGROW_CAPS: Record<string, number> = {
    // Berries ripen in clusters — a berry patch refills past a handful
    // (R7: 5 → 6, matching the forest's richer 4-berry seeding)
    berry: 6,
    // The water's two stocks: a cell holds a small shoal, not a single fish,
    // and seaweed mats the shallows. R5 — the fish cap is raised so the
    // lakes and the sea read ABUNDANTLY stocked (the shore fishery the
    // hunger ladder now works — plugins/behavior); the shoal refills on the
    // fish rhythm below.
    fish: 3,
    seaweed: 2,
    // Nut-bearing palms carry a small crown
    coconut: 3,
    water: 2,
    // Mushrooms fruit in rings on the woods' floor (R7: 4 → 5, matching the
    // forest's richer 3-mushroom seeding — the woods' floor reads abundant)
    mushroom: 5,
    // The construction materials replenish (the build projects consume
    // dozens of vines and fronds over a campaign — finite stocks would
    // starve the later blueprints): a vine re-hangs on its own rhythm,
    // a frond sheds beneath the standing trees (see the frond shed below).
    // R7: vine 2 → 3 — the denser forest vine map (0.6 chance) re-hangs
    // richer per cell, feeding the rope chains without new item ids.
    vine: 3,
    frond: 1,
    // R2 — the berry bush regrows the berries it bears (the stand itself is a
    // permanent meadow/forest feature; only its berry stock draws down and
    // refills, on the bush rhythm below) — a laden bush carries three
    bush: 3,
    // shell / iron / flint / STONE are finite — no regrowth (stone draws
    // down with the localized rock-site stock; the 🪨 icon drops when it
    // empties — drawDeposit deletes the entry at 0)
    // grass / sand / dirt are the unlimited ground supply — never depleted,
    // never regrown (GRAVEL is terrain, not a resource — it supplies
    // nothing; the old bedrock stone never mirrored into the stocks)
};

/**
 * Regrowth rhythm per item, in WORLD MINUTES: fires when
 * `minute % every === offset`. (The values pin the rhythm to WORLD MINUTES,
 * so the view scale never moves it.) The vine rhythm fires late and
 * staggered so the early-game stock pins and the pre-construction runs are
 * untouched (a vine cell sits at its cap until harvested).
 *
 * R7 — the rhythms are PRESERVED exactly (the depletion/regrowth ecosystem
 * keeps its clock; only the seeding, chances and caps were enriched).
 * EXPORTED so the resource-profile tests can pin the untouched clock.
 */
export const REGROW_RHYTHM: Record<string, { every: number; offset: number }> = {
    berry: { every: 30, offset: 20 },
    fish: { every: 40, offset: 0 },
    coconut: { every: 60, offset: 10 },
    mushroom: { every: 40, offset: 15 },
    seaweed: { every: 50, offset: 25 },
    vine: { every: 80, offset: 30 },
    // R2 — the berry bush is NOT listed here: it is a permanent PLANT, not
    // a loose stock — a DEDICATED pass (the BUSH_RHYTHM over the bushCells
    // registry, below) refills the stand off the plant registry instead of
    // the seeded-stock registry the generic sweep uses
    // The frond shed runs on its own rhythm (FROND_RHYTHM below) — it is
    // keyed off the TREE stock, not the frond key, so it is not listed here
};

/**
 * The FROND SHED — palm fronds drop beneath the standing trees on this
 * rhythm (every 60 world minutes at offset 45): the thatch/cloth chains'
 * raw stock. Keyed off the cell's TREE stock (a treed cell sheds; a
 * harvested-bare one regrows its shed as long as trees stand), NOT the
 * frond key — the shed's eligibility is "trees stand here", which the
 * seeded-stock registry cannot express, so it keeps its dedicated pass.
 * The offset pins the FIRST shed at minute 45, past every pre-construction
 * stock pin (the behavior and lumber plugin runs end at minutes 35/40).
 */
const FROND_RHYTHM = { every: 60, offset: 45 };
const FROND_SELLER = 'tree';

/**
 * R2 — THE FRESH-WATER REPLENISHMENT. Lakes and ponds (the interior
 * wetland basins the terrain generator carves) and the dry SHORE ring
 * beside them stock drinking water. The survey seeds that stock once; this
 * rhythm tops it back up (the basin never dries, so the stock refills on a
 * staggered world-minute cadence keyed off the same fine clock as the other
 * rhythm). `every` 30 with offset 15 staggers the refill away from the
 * berry (offset 20) pulse. R4 — with the scattered rain pool gone this is
 * the island's ONLY water replenishment: the basin's standing fresh water,
 * gathered from the wetland or its dry shore.
 */
const FRESH_WATER_RHYTHM = { every: 30, offset: 15 };

/**
 * R2 — THE BERRY-BUSH REPLENISHMENT. A plucked berry bush refills its berry
 * stock on this staggered cadence (keyed off the fine clock, like the other
 * rhythms). The dedicated tick pass (the BUSH_RHYTHM sweep below) runs it
 * over the bushCells registry — the standing plants — so a fully-plucked
 * bush (its `bush` stock drawn to zero) still regrows: the plant stands in
 * the registry whatever its berry count. `every` 40 with offset 25 clears
 * the pre-construction stock pins (which end at minute 35) and staggers the
 * refills away from the berry (offset 20) and vine (offset 30) pulses.
 */
const BUSH_RHYTHM = { every: 40, offset: 25 };

/** What each biome stocks when the island is surveyed — THE RICHER MAP,
 * ABUNDANCE-TUNED. The tile deposits (trees, stone, iron, sand, dirt) come
 * from the cells themselves — see the survey below; these are the biome's
 * living stocks: meadows berry, forests berry AND mushroom (the woods feed
 * two ways), beaches coconut. The starting counts are raised so the island
 * reads abundant from the first minute (the old berry 2 / berry 1 +
 * mushroom 1 / coconut 1 left the foods nearly impossible to FIND — the
 * cast spent its days foraging); every regrowth cap above bounds how far
 * each stock refills, and the finite draws (shells, flints, stone, iron)
 * stay exactly as sparse as they were.
 *
 * R7 — THE FOREST IS THE ISLAND'S LARDER: the woods' per-cell seeding is
 * enriched to berry 4 + mushroom 3 (from 2 + 2) so a surveyed forest reads
 * FILLED with berries and more from the first minute; the meadow (3) and
 * beach (2 coconuts) seeding stay exactly as tuned (the biome topology and
 * the non-forest stocks are untouched). The regrowth caps above sit a clear
 * step above these seeds, so a picked forest refills past its starting
 * abundance. EXPORTED for the resource-profile tests. */
export const BIOME_STOCKS: Record<string, Inventory> = {
    meadow: { berry: 3 },
    forest: { berry: 4, mushroom: 3 },
    beach: { coconut: 2 },
    // Water cells hold fish AND seaweed — the sea's two stocks (salt
    // water is never a drinking pool)
};

/** Chance a surveyed FOREST cell hangs a vine — the woods' material
 * (regrowing on its own rhythm since the build projects consume it —
 * see REGROW_CAPS; a harvested vine re-hangs after the regrowth rest).
 * R7: 0.35 → 0.6 — the woods hang vines THICK (the rope chains' stock);
 * the draw still consumes exactly one stream value per forest cell in
 * row-major order, so the shell/flint/seaweed pins downstream keep their
 * exact stream positions — only the vine OUTCOMES multiply. */
export const VINE_CHANCE_PER_FOREST_CELL = 0.6;

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
 *
 * R7 — the chance is BIOME-SPECIFIC: the forest undergrowth is THICK with
 * berry bushes (0.6, the woods' standing berry reserve beside the enriched
 * loose berries), while the meadow keeps its original 0.3 (the meadow stocks
 * are untouched). The hash fold is unchanged, so every meadow bush that
 * stood before still stands (0.3 ⊂ 0.6 — the forest raise only ADDS bushes,
 * it never moves one), and the fold values are stable per address.
 * EXPORTED for the resource-profile tests.
 */
export const BUSH_CHANCE_PER_MEADOW_CELL = 0.3;
export const BUSH_CHANCE_PER_FOREST_CELL = 0.6;

/** The fnv-1a coordinate hash, folded to [0,1) — the bush's placement roll.
 * EXPORTED so the placement map is independently testable (exact fold per
 * address, seed for seed). */
export const bushHash = (x: number, y: number): number => {
    let h = 2166136261;
    const mix = (n: number): void => {
        h ^= n + 0x9e3779b9 + (h << 6) + (h >>> 2);
    };
    mix(x);
    mix(y);
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 13;
    return ((h >>> 0) % 1000) / 1000;
};

/** Whether a bush stands at (x, y) under the biome's seeding chance. */
export const bushAt = (x: number, y: number, chance: number): boolean =>
    bushHash(x, y) < chance;

/** Whether an item id is a tile deposit resource (tree/stone/iron/sand/dirt). */
const isTileResource = (itemId: string): itemId is TileResource =>
    (TILE_RESOURCES as readonly string[]).includes(itemId);

/**
 * Whether an item id is an UNLIMITED deposit (grass/sand/dirt — never
 * depleted; stone left the list when it became a finite rock-site stock).
 */
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
 * the trees' pools. One method: cut UP TO `units` wood (default 1) off a
 * tile's stand — the exact fine spot's tree first, else the deterministic
 * nearest standing tree inside the same tile; folds the tree's lazy growth,
 * removes the record when the pool hits 0. `taken` reports how many units
 * actually left the tree (a pool shorter than `units` pays only what stood
 * — the conservation rule behind the R2 chop payout), `felled` whether the
 * source tree died (the caller syncs the standing-tree mirrors). Null: no
 * standing tree on the tile (nothing to cut — the harvest fails atomically).
 */
export type ForestEcology = {
    chop(
        parent: { x: number; y: number },
        fine: { x: number; y: number } | undefined,
        units?: number,
    ): { felled: boolean; taken: number } | null;
};

export type InventoryPlugin = WorldPlugin<World> & {
    /** An actor's bag — auto-created (empty) on first touch. */
    of(actorId: string): Inventory;
    /**
     * R5 — the entity's bag capacity in WEIGHT — its species' carry budget
     * from the entity profiles (a person 200). `Infinity` without profiles
     * (unlimited legacy bags); a species without a profile carries the stock
     * human's 200. The load compared against it is `Σ count × itemWeight`.
     */
    capacityOf(entityId: string): number;
    /** Resource stock standing on a canvas cell. */
    cellStock(x: number, y: number): Inventory;
    /** Takes one `itemId` from the cell the agent stands on. */
    takeFromCell(agent: InventoryAgent, itemId: string): boolean;
    /**
     * Cuts wood off a standing tree (depositId 'tree') into the agent's bag
     * (yieldId 'wood'). `yieldCount` (default 1, the R2 chop payout passes
     * 3) is the WANTED bundle — the harvest takes UP TO that many units and
     * pays exactly what it cut (conservation: one pool unit = one wood item,
     * so a sapling's pool-1 tree still yields exactly 1 wood and the
     * inspector's standing-wood read never lies). With the forest ecology
     * mounted: up to `yieldCount` units leave ONE tree's pool (the actor's
     * fine spot's tree first, else the deterministic nearest in the tile)
     * and the tree STANDS while wood remains — a fully felled tree (pool 0)
     * leaves the record and the standing-tree mirrors. Without the
     * provider: the legacy whole-tree consumption (one deposit unit per
     * wood, up to `yieldCount` standing units). Fails without side effects
     * when the tile holds no trees (or the deposit is unlimited — those are
     * gathered raw with takeFromCell, never converted) or when the bag
     * holds no room for even ONE unit. Capacity is gated BEFORE anything
     * moves (atomicity: a full bag never fells).
     */
    harvest(agent: InventoryAgent, depositId: string, yieldId: string, yieldCount?: number): boolean;
    /** Gathers one available item from the agent's cell. Returns the item id. */
    gather(agent: InventoryAgent): string | null;
    /**
     * R5 — THE FISHING SHORE: takes one FISH from the water cell at (x, y)
     * into the agent's bag WITHOUT entering the water. Legal only when the
     * agent stands on DRY ground and the water cell is CARDINAL-adjacent to
     * the agent's tile (the castaway works the water at its feet — never a
     * diagonal, never at distance, never from the water itself; a body
     * afloat gathers the fish underfoot through `gather` instead). Capacity
     * is gated before anything moves; the behavior plugin's 'fish' effect
     * re-validates at completion (the shoal may have been drawn down).
     */
    fish(agent: InventoryAgent, x: number, y: number): boolean;
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
    // plucking its berries draws the `bush` stock to zero, and the plant is
    // a PLANT, not a loose stock, so the stand persists in this registry
    // whatever its berry count and a dedicated tick pass (the BUSH_RHYTHM,
    // below) tops each bush's berry stock back up to the cap. Cleared +
    // refilled by each survey (resurvey rebuilds it from the regenerated
    // canvas).
    const bushCells = new Set<string>();

    // RENEWABLE ELIGIBILITY REGISTRY — itemId → every cell the survey seeded
    // that renewable item on (the generic-sweep items: berry, fish, coconut,
    // mushroom, seaweed, vine). The regrowth sweep iterates THIS, NOT the
    // stock keys: inventoryRemove DELETES a stock key at zero, so a
    // stock-keyed sweep loses every fully-harvested cell forever — a picked-
    // bare berry cell, a fished-out sea cell and a stripped vine never
    // regrew (the exhausted-source bug; the frond shed and the bush pass
    // were the first two sightings of it and carry their own registries).
    // The registry is the ORIGINAL-SOURCE eligibility: only cells the survey
    // seeded the item on ever regrow it, so mushrooms never sprout on a
    // beach, fish never strand on land and vines never hang on bare rock —
    // the deterministic placement map is preserved cell for cell. Rebuilt by
    // each survey (a resurvey regenerates the canvas); bush / frond / water
    // keep their dedicated registries (specialized ecologies).
    const regrowCells = new Map<string, Set<string>>();

    /** Register a seeded renewable cell — only for items the generic sweep
     * owns (a REGROW_RHYTHM entry); bush/frond/water route through their
     * dedicated passes and are deliberately skipped here. */
    const markRegrowable = (itemId: string, x: number, y: number): void => {
        if (!(itemId in REGROW_RHYTHM)) {
            return;
        }
        const cells = regrowCells.get(itemId);
        if (cells) {
            cells.add(`${x},${y}`);
        } else {
            regrowCells.set(itemId, new Set([`${x},${y}`]));
        }
    };

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
     * R5 — the entity's bag capacity in WEIGHT — its species' carry budget
     * (the entity profiles' `inventorySize`, now a weight: a person 200).
     * Infinity without profiles; a species without a profile carries the
     * stock human's 200 (the island's shoulders).
     */
    const capacityOf = (entityId: string): number => {
        const type = typeOf(entityId);
        const size = type ? profiles?.inventorySizeOf(type) : undefined;
        return size ?? (profiles ? 200 : Infinity);
    };

    /**
     * R5 — whether the bag can still hold a bundle WITHIN ITS WEIGHT CAPACITY.
     * The load is `Σ count × itemWeight`; the gate adds the bundle's weight to
     * the carried weight and compares against the carrier's budget. (The
     * count-based `inventoryFits` is no longer the gate — capacity is weight,
     * not item count.)
     */
    const canHold = (entityId: string, additions: Inventory): boolean =>
        inventoryWeight(bagOf(entityId)) + inventoryWeight(additions) <= capacityOf(entityId);

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

    // Internal: grows a stock toward its cap by one unit. The CALLER gates
    // the rhythm (the tick's regrowth sweep fires this only on the item's
    // minute and only on registry-eligible cells — see regrowCells).
    // Tile-deposit resources (trees) grow their tile's deposit back with the
    // stock — the forest regrows where the trees were felled.
    const regrow = (stock: Inventory, itemId: string, x: number, y: number) => {
        const current = stock[itemId] ?? 0;
        const cap = REGROW_CAPS[itemId] ?? 0;
        if (current < cap) {
            stock[itemId] = current + 1;
            growDeposit(x, y, itemId);
        }
    };

    // Internal: keeps a tile's deposit in step with its gatherable stock.
    // Finite deposits (iron — stone the localized rock-site stock — and
    // the legacy tree path) follow the stock — taking one draws the tile's
    // deposit down (deleting the entry at 0 falls the surface derivation
    // through to the tile's next landmark / ground / voxel look through
    // tileSurfaceKey: an exhausted rock site falls off its 'stone' surface
    // (gravel is excluded from the ground scan — it supplies nothing) down
    // to the plain highland / ground key, a clearcut wood KEEPS its forest
    // canopy — the forest voxel stands). Unlimited deposits are never
    // touched: a tile's ground supply cannot run out.
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
        // The renewable eligibility registry is rebuilt the same way — the
        // regrowth sweep's source of truth for WHERE each item may regrow
        regrowCells.clear();
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        // R4 — the fresh-water family is isFreshBasin (engine/types): the
        // lake/pond basins AND the river courses. The shore-ring read below
        // and the cell's own seeding both follow it, so a river banks its
        // water onto the adjacent dry tiles exactly like a basin does.
        const basinAt = (x: number, y: number): boolean => {
            if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
                return false;
            }
            const neighbor = canvas.cells[(y + halfY) * canvas.width + (x + halfX)];
            return isFreshBasin(neighbor.biome);
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
                    // The seeded cell is where the item may regrow (the
                    // eligibility registry — see regrowCells)
                    markRegrowable(item, cell.x, cell.y);
                });
            }
            // R2 — the BERRY BUSH: a standing berry plant in the meadow and
            // forest undergrowth. Seeded on the deterministic coordinate hash
            // (bushAt — no random-stream draw, so the other pins are
            // untouched). The bush's stock is the berries it bears; foraging
            // plucks them and the regrowth sweep refills the stand.
            // R7 — the chance is BIOME-SPECIFIC: the forest undergrowth seeds
            // bushes at 0.6 (the woods' standing berry reserve beside the
            // enriched loose berries), the meadow keeps its original 0.3.
            // The fold is unchanged, so the raise only ADDS forest bushes.
            const bushChance = cell.biome === 'forest'
                ? BUSH_CHANCE_PER_FOREST_CELL
                : BUSH_CHANCE_PER_MEADOW_CELL;
            if ((cell.biome === 'meadow' || cell.biome === 'forest') && bushAt(cell.x, cell.y, bushChance)) {
                stock.bush = (stock.bush ?? 0) + 1;
                // Track the standing plant (the regrow pass's registry)
                bushCells.add(`${cell.x},${cell.y}`);
            }
            // R2 — THE FRESH WATER: a lake/pond wetland cell stocks drinking
            // water, and so does the DRY SHORE ring beside one (a land actor
            // gathers the water from either the wetland or its shore — the
            // thirst ladder's collect reads the cell's water stock). The cell
            // is a fresh-water cell iff it is a basin OR any of its 8
            // neighbors is. R4 — the river courses join the family: the cell
            // itself fords (a thirsty actor drinks IN the river, standing in
            // the shallows) and its banks stock the ring; the takeFromCell
            // branch below makes the river's own supply inexhaustible while
            // the basins and their shores keep the rhythm refill.
            const isBasin = isFreshBasin(cell.biome);
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
            // a neighbour might hold; the construction chains' rope stock).
            // Only the DRAWN cells join the eligibility registry — a wood
            // that missed the draw never grows a vine (the deterministic
            // vine map is preserved cell for cell)
            if (cell.biome === 'forest' && context.random() < VINE_CHANCE_PER_FOREST_CELL) {
                stock.vine = (stock.vine ?? 0) + 1;
                markRegrowable('vine', cell.x, cell.y);
            }
            // The shallows keep washed-ashore seaweed (regrowing); the deep
            // sea grows its own — every open-water cell stocks one. Each
            // seeded cell joins the eligibility registry (the shallows'
            // missed draws stay bare — the deterministic seaweed map)
            if (cell.biome === 'shallows' && context.random() < SHALLOW_SEAWEED_CHANCE) {
                stock.seaweed = (stock.seaweed ?? 0) + 1;
                markRegrowable('seaweed', cell.x, cell.y);
            }
            if (cell.biome === 'ocean') {
                stock.seaweed = (stock.seaweed ?? 0) + 1;
                markRegrowable('seaweed', cell.x, cell.y);
            }
            // Beaches occasionally hide a shell; highlands occasionally
            // hide flint — finite resources, no regrowth
            if (cell.biome === 'beach' && context.random() < 0.5) {
                stock.shell = (stock.shell ?? 0) + 1;
            }
            if (cell.biome === 'highland' && context.random() < 0.3) {
                stock.flint = (stock.flint ?? 0) + 1;
            }
            // The water stocks fish — every water cell (the sea AND the
            // impassable fresh basins, R4/R5) joins the eligibility registry
            // (fish regrow in the water, never on the dry land) and seeds a
            // two-unit shoal so the lakes and shallows read abundant (the
            // cap above bounds the refill; the shore fishery draws them from
            // dry ground — the fish primitive below)
            if (!cell.passable) {
                stock.fish = (stock.fish ?? 0) + 2;
                markRegrowable('fish', cell.x, cell.y);
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
                // R5 — the kit fills the bag up to its WEIGHT budget; an
                // overfull kit is clamped to the units that still fit (never
                // spilled past the entity's carry). The room is measured in
                // weight and divided by the item's unit weight.
                const room = capacity - inventoryWeight(bag);
                const fits = Math.floor(room / itemWeight(item));
                if (fits <= 0) {
                    return;
                }
                inventoryAdd(bag, item, Math.min(count, fits));
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
            // ROCK — the stone stock is FINITE now (the localized rock-site
            // deposit below draws down with the pile; the ground-supply
            // takes below never touch it)
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
            // R4 — RIVER WATER IS INEXHAUSTIBLE: a flowing course hands its
            // fresh water out forever, exactly like the unlimited ground
            // supply below — the stock key is the DISCOVERY signal (the
            // survey seeds it; cellsWithItem('water') and the thirst trek
            // read it), never a pool to drain. The capacity gate above
            // still applies (a full hand cannot take — the take stays
            // atomic), and the lake/pond basins keep their FINITE rhythm-
            // refilled pools (the FRESH_WATER_RHYTHM sweep is unchanged).
            const riverWater = itemId === 'water' && world?.cellAt(x, y)?.biome === 'river';
            // UNLIMITED ground-supply deposits (grass, sand, dirt) cannot be
            // exhausted: the pile never decrements, so the tile hands them
            // out forever — only the bag's capacity gates (stone is FINITE:
            // it rides the stock branch and draws down with the pile)
            if (isUnlimitedResource(itemId) || riverWater) {
                if ((stock[itemId] ?? 0) <= 0) {
                    return false;
                }
            } else if (!inventoryRemove(stock, itemId, 1)) {
                return false;
            }
            inventoryAdd(bagOf(actor.id), itemId, 1);
            // Finite deposits draw down with the pile — an exhausted
            // landmark falls through the surface derivation to the tile's
            // next look (an exhausted rock site loses its 'stone' surface —
            // the depleted gravel top supplies nothing — an exhausted iron
            // lode on a stocked highland still reads 'stone' through the
            // live-stock rule, otherwise the plain highland)
            drawDeposit(x, y, itemId);
            return true;
        },

        harvest: (actor, depositId, yieldId, yieldCount) => {
            const x = actor.position.x;
            const y = actor.position.y;
            // Unlimited deposits are raw ground — they are taken as
            // themselves, never converted into a product
            if (isUnlimitedResource(depositId)) {
                return false;
            }
            // THE CAPACITY GATE — checked BEFORE anything moves so a
            // full bag leaves the tile untouched (atomicity: a failed
            // cut never wounds a tree). R2 — the gate wants the whole
            // bundle but never blocks a partial cut. R5 — the room is the
            // bag's remaining WEIGHT, converted to how many YIELD units fit
            // (`floor(roomWeight / itemWeight(yield))`); the wanted count is
            // clamped to that, and only a bag with no room for even ONE unit
            // refuses. Conservation holds: the chop takes at most `want` and
            // pays exactly what it cut, so a nearly-full bag cuts fewer logs
            // and the tree keeps the rest standing.
            const roomWeight = capacityOf(actor.id) - inventoryWeight(bagOf(actor.id));
            const fitUnits = Math.floor(roomWeight / itemWeight(yieldId));
            const wanted = Math.max(1, Math.floor(yieldCount ?? 1));
            const want = Math.min(wanted, fitUnits);
            if (want < 1) {
                return false;
            }
            const stock = stockOf(x, y);
            // ── The forest ecology path — wood comes off the tree's POOL ──
            // One completed chop cuts UP TO `want` units off ONE tree; the
            // tree STANDS while wood remains and only a fully felled tree
            // (pool 0) leaves the record. The payout is exactly what was
            // CUT (conservation — a pool shorter than `want` pays less),
            // the standing-tree mirrors sync inside the chop itself (the
            // ecology owns them — no ghosts, no stale deposits). The exact
            // fine spot's tree is cut first; a bare fine cell cuts the
            // deterministic nearest tree inside the same tile.
            if (depositId === 'tree' && forest) {
                const fine = world?.subOf(actor.id);
                const outcome = forest.chop({ x, y }, fine, want);
                if (!outcome) {
                    // No standing tree on the tile — nothing moved
                    return false;
                }
                // The wood lands in the bag — wood exists only as a yield
                // (exactly the units the chop took — never more)
                inventoryAdd(bagOf(actor.id), yieldId, outcome.taken);
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
            // stand underfoot) — one whole tree deposit unit per wood, up
            // to `want` standing units. This serves fixtures and older
            // terrain whose trees are plain tile deposits with no
            // biological records: taking one draws the tile's deposit down
            // with the stock (nothing can resurrect it — no stand exists
            // to restore from). The deposit must still be standing (a
            // co-worker may have taken the last unit during the wait) —
            // atomic: nothing moves unless at least ONE unit stands, and
            // the payout is exactly the units drawn (never more)
            const standing = stock[depositId] ?? 0;
            const taken = Math.min(want, standing);
            if (taken < 1 || !inventoryRemove(stock, depositId, taken)) {
                return false;
            }
            // The trees are gone from the tile — the deposit draws down
            // with them. The tile's LOOK keeps its forest canopy:
            // tileSurfaceKey reads the standing forest voxel, so even a
            // legacy clearcut never re-skins the wood to its plain biome
            for (let unit = 0; unit < taken; unit++) {
                drawDeposit(x, y, depositId);
            }
            // The product lands in the bag — wood exists only as a yield
            inventoryAdd(bagOf(actor.id), yieldId, taken);
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

        fish: (agent, x, y) => {
            const active = world;
            if (!active) {
                return false;
            }
            // DRY GROUND underfoot — the shore rule: a body fishes from the
            // land (a body afloat gathers the fish underfoot via `gather`)
            const ground = active.cellAt(agent.position.x, agent.position.y);
            if (!ground || !ground.passable) {
                return false;
            }
            // CARDINAL ADJACENCY — the reach at the body's feet (the tile
            // grid is the fishing granularity, like every other stock read)
            if (Math.abs(x - agent.position.x) + Math.abs(y - agent.position.y) !== 1) {
                return false;
            }
            // The water — fish stand only in the impassable cells (the
            // survey seeds them there and only there)
            const water = active.cellAt(x, y);
            if (!water || water.passable) {
                return false;
            }
            // THE CAPACITY GATE — checked before the shoal gives the fish up
            if (!canHold(agent.id, { fish: 1 })) {
                return false;
            }
            if (!inventoryRemove(stockOf(x, y), 'fish', 1)) {
                return false;
            }
            inventoryAdd(bagOf(agent.id), 'fish', 1);
            // No log line — fishing is a solo beat, not a story between
            // entities (the log is a story teller)
            return true;
        },

        consume: (actor, itemId) => {
            if (!inventoryRemove(bagOf(actor.id), itemId, 1)) {
                return false;
            }
            // No log line — eating/drinking is a solo beat too
            return true;
        },

        exchange: (giver, receiver, offer, request) => {
            // R5 — THE TWO-SIDED NET WEIGHT GATE. A trade moves `offer`
            // giver→receiver and `request` receiver→giver, so BOTH bags
            // change and BOTH must be checked (the old gate only guarded the
            // receiver taking the offer — a giver whose bag overflows on the
            // request slipped through). Each side is measured by its FINAL
            // net weight: current − what it hands over + what it takes in.
            // Netting the outgoing FIRST is deliberate — the naive `canHold`
            // (current + incoming) would reject a capacity-NEUTRAL swap (the
            // unit handed over frees exactly the room the unit received
            // needs). `inventoryExchange` stays the atomic authority: if a
            // side doesn't actually hold what it offers, it fails and nothing
            // moves (the gate is a pre-check, never a partial commit).
            if (profiles) {
                const offerWeight = inventoryWeight(offer);
                const requestWeight = inventoryWeight(request);
                const giverNet = inventoryWeight(bagOf(giver.id)) - offerWeight + requestWeight;
                const receiverNet = inventoryWeight(bagOf(receiver.id)) - requestWeight + offerWeight;
                if (giverNet > capacityOf(giver.id) || receiverNet > capacityOf(receiver.id)) {
                    return false;
                }
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
            // The standing berry bushes and the renewable eligibility
            // registries go too — a stale registry would let a dedicated
            // pass refill stocks on cells of a disposed canvas
            bushCells.clear();
            regrowCells.clear();
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

            // Regrowth sweep — per renewable item, on its staggered rhythm,
            // every cell the survey seeded that item on regrows one unit
            // toward its cap (deposits grow back with their stocks — see
            // regrow/growDeposit). Registry-keyed, NOT stock-keyed (see
            // regrowCells): inventoryRemove deletes a zeroed stock key, so
            // the old stock-keyed sweep never saw a fully-harvested source
            // again — picked-bare berry cells, fished-out sea cells and
            // stripped vines stayed barren forever. The registry keeps the
            // deterministic placement: an item never regrows on a cell the
            // survey did not seed it on (no mushrooms on the beach, no fish
            // on land, no vines on bare rock).
            Object.entries(REGROW_RHYTHM).forEach(([itemId, rhythm]) => {
                // Staggered rhythms so resources don't all pulse on the same tick
                if (minute % rhythm.every !== rhythm.offset) {
                    return;
                }
                const cells = regrowCells.get(itemId);
                if (!cells) {
                    return;
                }
                cells.forEach((key) => {
                    const [x, y] = key.split(',').map(Number);
                    regrow(stockOf(x, y), itemId, x, y);
                });
            });

            // R4 — RAIN IS WEATHER, NOT A WATER PICKUP. The rain roll still
            // sweeps the island (the weather event stands — the story feed
            // reads it), but it no longer scatters drinking-water pools
            // onto ordinary inland tiles: the island's fresh water lives
            // where the terrain HOLDS it — the lake/pond basins and their
            // dry shore ring (the survey's freshWaterCells + the
            // FRESH_WATER_RHYTHM replenishment below). No per-cell pool
            // rolls, no scattered pickups the god never asked for.
            if (context.random() < rainChance) {
                active.events.emit({ kind: 'weather', message: 'Rain sweeps the island.' });
            }

            // R2 — THE FRESH-WATER REPLENISHMENT. Every fresh-water cell
            // (the lake/pond wetlands + their dry shore ring, tracked in
            // freshWaterCells by the survey) tops its water stock back up to
            // the cap on the FRESH_WATER_RHYTHM — the basin's supply is the
            // island's standing fresh water, so a drawn-down basin refills on
            // its own cadence (R4 — with the rain pool gone this is the ONLY
            // water replenishment on the island).
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
            // the PLANT registry — not the seeded-stock registry — so a
            // fully-plucked bush (its `bush` stock down to zero) still
            // regrows: the stand persists in the registry even when its
            // berries are gathered away.
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
