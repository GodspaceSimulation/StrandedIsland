// Tests for the inventory environment plugin (plugins/inventory/inventoryPlugin.ts).
// Uses the default seed-7 island (25×17, centered coordinates) as fixture;
// the exact stock layouts below were captured from a reference run and must
// never drift.
//
// Tile DEPOSITS (TerrainCell.resources) seed the gatherable stocks: the
// VOXEL-DERIVED ground supply (stone/dirt/grass/sand — every dry column
// carries what it is built from, unlimited) and the TREE MIRROR under the
// neighborhood model (every forest seeds its 8-neighbor-counted coverage —
// the persistent fine-scale stand, plugins/terrain — and every meadow
// beside woods its localized edge ingress; the reference wood (−7,0) at
// 298, the meadow (1,−4) at its 10-spot fringe), plus iron lodes on the
// vein noise's picks. Cell stocks
// list deposits first, then the biome's living stocks (meadow berries,
// forest berries + mushrooms, beach coconuts), then the chance draws
// (forest vines, shallows seaweed, beach shells, highland flints). Wood is
// NOT a deposit — it is cut off a tree's wood pool (with the forest
// ecology mounted) or taken as a whole tree deposit unit (the legacy path,
// no ecology mounted). Living trees are never bagged (takeFromCell 'tree'
// refuses).

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { entityPlugin } from '../entity/entityPlugin';
import type { Actor } from '../../engine/types';
import { inventoryPlugin } from './inventoryPlugin';
import { inventoryTotal, inventoryEntries } from './inventory';
import { ITEM_TYPE_GLYPHS } from './items';

// A standard actor fixture placed on a specific cell (ground plane, z = 0)
const actor = (id: string, name: string, x: number, y: number): Actor => ({
    id,
    name,
    kind: 'sentient',
    type: 'human',
    position: position3(x, y),
    marker: name.slice(0, 1),
    condition: 'well',
    profile: { sex: 'male' },
});

// Default island (25×17, seed 7) — has meadow, forest, beach and sea.
// Reference cells (captured, row-major order from the survey; deposits
// seed first, then the biome's living stocks, then the chance draws):
//   (1,−2)    meadow  stock {tree:10, stone:1, dirt:1, grass:1, berry:2}
//             (the meadow's localized edge ingress beside the woods; the
//             0.8 wetland pass turned the old (1,−4) meadow into a lake, so
//             the meadow pins moved to (1,−2))
//   (−7,0)    forest  stock {stone:1, dirt:1, grass:1, tree:425, berry:1, mushroom:1, water:1}
//   (−4,−7)   beach   stock {stone:1, dirt:1, sand:1, coconut:1} (shell draw missed)
//   (−5,−7)   beach   stock {stone:1, dirt:1, sand:1, coconut:1} (shell draw missed)
//   (−12,−8)  shallows stock {fish:1}                     (seaweed draw missed)
//   (0,0)     highland stock {stone:1, dirt:1, flint:1}   (30% flint draw hit)
//   (−1,−1)   highland stock {stone:1, dirt:1, flint:1}   (flint draw hit too)
//   (0,−1)    highland stock {stone:1, dirt:1}            (flint draw missed)
// The default island keeps every vein sample under IRON_LODE_THRESHOLD —
// no iron lodes on 25×17; the lode test below pins the 37×25 reference
// board (the pre-shrink default) where 3 of the 9 highlands lode.
const buildWorld = () => {
    const terrain = islandTerrainPlugin();
    const island = inventoryPlugin({ rainChancePerMinute: 0 });
    const world = createWorld({ seed: 7, plugins: [terrain, island] });
    return { world, island, terrain };
};

/**
 * The LEGACY fixture — an inventory world with NO terrain plugin resolved
 * (old terrain whose trees are plain tile deposits with no biological
 * records). The biological boundary reads the persistent stands through
 * the resolved terrain handle; with none, the legacy whole-tree path
 * serves. Cell stocks are hand-seeded (no canvas survey runs).
 */
const buildLegacyWorld = () => {
    const island = inventoryPlugin({ rainChancePerMinute: 0 });
    const world = createWorld({ seed: 7, plugins: [island] });
    return { world, island };
};

describe('inventoryPlugin', () => {
    it('seeds resources from tile deposits and biome living stocks on setup', () => {
        const { island } = buildWorld();
        // Meadow (1,−2) → the voxel ground supply (stone/dirt/grass ×∞) +
        // its 10-tree ingress fringe beside the woods + 2 berries
        expect(island.cellStock(1, -2)).toEqual({ tree: 10, stone: 1, dirt: 1, grass: 1, berry: 2 });
        // Forest (−7,0) → the ground supply + its neighborhood-counted
        // full 425-tree mirror (the persistent fine-scale stand) + 1 berry
        // + the woods' mushroom + the freshwater pass's pooled water
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425, berry: 1, mushroom: 1, water: 1 });
        // Beach (−4,−7) → the ground supply (stone/dirt/sand ×∞), coconut 1
        expect(island.cellStock(-4, -7)).toEqual({ stone: 1, dirt: 1, sand: 1, coconut: 1 });
        // Sea (−12,−8) → fish (the shallows seaweed draw missed; no tile
        // deposits under water — submerged columns supply nothing)
        expect(island.cellStock(-12, -8)).toEqual({ fish: 1 });
    });

    it('seeds stone (every dry column), iron lodes (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        // Reference highlands on the default island: (0,0) hid a flint
        // (30% draw hit); (−1,−1) holds the R5 iron lode (the 0.8 board
        // guarantees a single lode where the vein noise missed); (0,−1)
        // missed both
        expect(island.cellStock(0, 0)).toEqual({ stone: 1, dirt: 1, flint: 1 });
        expect(island.cellStock(-1, -1)).toEqual({ stone: 1, iron: 1, dirt: 1 });
        expect(island.cellStock(0, -1)).toEqual({ stone: 1, dirt: 1 });
        // THE GROUND SUPPLY IS EVERYWHERE its voxels are: all 282 dry land
        // cells carry stone (the bedrock under every column) and dirt (the
        // ground layer under every surface); grass covers meadows AND woods
        expect(island.cellsWithItem('stone').length).toBe(282);
        expect(island.cellsWithItem('dirt').length).toBe(282);
        expect(island.cellsWithItem('grass').length).toBe(135);
        // The unlimited sand stays beach-only (the R3 2-tile coastal band
        // shrank the sands from 160 to 138)
        expect(island.cellsWithItem('sand').length).toBe(138);
        // THE R5 GATE: the 0.8 board holds exactly ONE iron lode (at
        // (−1,−1)) — the finite mineable deposit the early tools need
        expect(island.cellsWithItem('iron').map((cell) => `${cell.x},${cell.y}`)).toEqual(['-1,-1']);
        // The 37×25 reference board lodes 3 highlands — the lodes carry
        // stone too (deposits seed in TILE_RESOURCES order: stone before
        // iron); (−5,2) hid a flint this run (30% draw hit)
        const big = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 37, height: 25 }), big] });
        expect(big.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1 });
        expect(big.cellStock(-5, 3)).toEqual({ stone: 1, dirt: 1, iron: 1 });
        // The other two lodes: (−7,1) and (−5,2) — the lodes carry stone too
        expect(big.cellStock(-7, 1)).toEqual({ stone: 1, dirt: 1, iron: 1 });
        expect(big.cellStock(-5, 2)).toEqual({ stone: 1, dirt: 1, iron: 1, flint: 1 });
        // The iron list is exactly the vein noise's picks
        expect(big.cellsWithItem('iron').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-7,1', '-5,2', '-5,3',
        ]);
        expect(big.cellsWithItem('flint').map((cell) => `${cell.x},${cell.y}`)).toEqual(['-5,2']);
    });

    it('gather moves the first available FOOD from the cell to the actor bag', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Forest cell: the berry seeds before the mushroom (the biome's
        // living stock order) — trees are a deposit material and never
        // picked by the food gather
        expect(island.gather(ael)).toBe('berry');
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425, mushroom: 1, water: 1 });
        // Gathering stays out of the log — foraging is a solo beat, not a
        // story between entities (the log is a story teller)
        expect(world.events.logFor('a').map((event) => event.kind)).toEqual(['spawn']);
    });

    it('gather returns null when only materials remain, without side effects', () => {
        const { world, island } = buildLegacyWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        // A stand-less fixture cell: 1 berry + 1 mushroom + a tree mirror —
        // after the foods are gone, trees stay
        island.cellStock(0, 0).tree = 3;
        island.cellStock(0, 0).berry = 1;
        island.cellStock(0, 0).mushroom = 1;
        expect(island.gather(ael)).toBe('berry');
        expect(island.gather(ael)).toBe('mushroom');
        expect(island.gather(ael)).toBe(null);
        // No tree entered the bag and no tree left the tile: materials are
        // NOT gathered by the hunger loop (agents must walk to real food
        // instead of farming a tile's ground supply forever)
        expect(island.of('a')).toEqual({ berry: 1, mushroom: 1 });
        expect(island.cellStock(0, 0)).toEqual({ tree: 3 });
        // Materials are fetched explicitly — trees by the harvest (the
        // legacy whole-tree conversion, tree → wood; the stand-less tile
        // carries no biological records to protect)
        expect(island.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(island.of('a')).toEqual({ berry: 1, mushroom: 1, wood: 1 });
        // The legacy path consumes WHOLE tree units — the mirror drops with
        // the pile
        expect(island.cellStock(0, 0)).toEqual({ tree: 2 });
    });

    it('harvest refuses whole-tree cuts on stand-bearing terrain without the ecology mounted', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Forest (−7,0) mirrors its neighborhood-counted full 425-tree stand
        expect(world.cellAt(-7, 0)?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425 });
        // THE BIOLOGICAL BOUNDARY — the tile carries a persistent stand,
        // no forest ecology is mounted (the legacy inventory-only fixture):
        // the whole-tree harvest is refused BEFORE any mutation — a living
        // tree harvests only through its owner (the remount-farm fix)
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(island.of('a')).toEqual({});
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425, berry: 1, mushroom: 1, water: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425 });
        // Unlimited deposits are raw ground — they are never converted
        const bram = world.spawn(actor('b', 'Bram', -4, -7));
        expect(island.harvest(bram, 'sand', 'glass')).toBe(false);
        expect(island.of('b')).toEqual({});
    });

    it('harvest serves the legacy whole-tree path on stand-less terrain (old fixtures)', () => {
        const { world, island } = buildLegacyWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        // A LEGACY TERRAIN SHAPE — no terrain plugin resolved (old terrain
        // whose trees are plain tile deposits with no biological records).
        // The whole-tree harvest serves: taking one unit draws the stock
        // down, nothing can resurrect it (no stand exists to restore from)
        island.cellStock(0, 0).tree = 3;
        expect(island.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(island.cellStock(0, 0)).toEqual({ tree: 2 });
        expect(island.of('a')).toEqual({ wood: 1 });
        // (the tile deposit draw no-ops — no terrain plugin carries the
        // canvas; the fixture's stock mirror is the whole truth)
        void world;
    });

    it('taking an iron lode draws the ore before the unlimited ground supply', () => {
        // The 37×25 reference board — the default island holds no lodes
        const island = inventoryPlugin({ rainChancePerMinute: 0 });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 37, height: 25 }), island] });
        const ael = world.spawn(actor('a', 'Ael', -5, 3));
        // Lode (−5,3): the ground supply + iron (+ a flint) — the cell also
        // hides a flint, which has no deposit
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1, dirt: 1, iron: 1 });
        expect(island.takeFromCell(ael, 'iron')).toBe(true);
        expect(island.of('a')).toEqual({ iron: 1 });
        // The ore is gone, the tile keeps its unlimited ground supply
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1, dirt: 1 });
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        // The mined-out highland still reads its plain biome surface (the
        // ground supply never depletes — the deposit stays, the look holds)
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1, dirt: 1 });
        expect(world.cellAt(-5, 3)?.biome).toBe('highland');
        expect(island.of('a')).toEqual({ iron: 1, stone: 1 });
    });

    it('unlimited ground supply (stone, grass, sand, dirt) never depletes', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -4, -7));
        // Scooping sand: the bag grows with every take…
        for (let index = 0; index < 5; index++) {
            expect(island.takeFromCell(ael, 'sand')).toBe(true);
        }
        expect(island.of('a')).toEqual({ sand: 5 });
        // …but the pile and the deposit stay intact forever
        expect(island.cellStock(-4, -7)).toEqual({ stone: 1, dirt: 1, sand: 1, coconut: 1 });
        expect(world.cellAt(-4, -7)?.resources).toEqual({ stone: 1, dirt: 1, sand: 1 });
        // Dirt works the same on meadows
        const bram = world.spawn(actor('b', 'Bram', 1, -2));
        expect(island.takeFromCell(bram, 'dirt')).toBe(true);
        expect(island.of('b')).toEqual({ dirt: 1 });
        expect(island.cellStock(1, -2)).toEqual({ tree: 10, stone: 1, dirt: 1, grass: 1, berry: 2 });
        expect(world.cellAt(1, -2)?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 10 });
        // The new grass identity: pulled off the meadow's grass cover,
        // never depleting
        expect(island.takeFromCell(bram, 'grass')).toBe(true);
        expect(island.of('b')).toEqual({ dirt: 1, grass: 1 });
        // Stone quarries off the same column — bedrock under everything,
        // never exhausted
        for (let index = 0; index < 3; index++) {
            expect(island.takeFromCell(bram, 'stone')).toBe(true);
        }
        expect(island.of('b')).toEqual({ dirt: 1, grass: 1, stone: 3 });
        expect(world.cellAt(1, -2)?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 10 });
    });

    it('taking from an empty stock fails without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 1, -2));
        // No water on the cell yet
        expect(island.takeFromCell(ael, 'water')).toBe(false);
        expect(island.of('a')).toEqual({});
        // Inject rain water manually (rain chance is disabled in the fixture)
        island.cellStock(1, -2).water = 1;
        expect(island.takeFromCell(ael, 'water')).toBe(true);
        expect(island.of('a')).toEqual({ water: 1 });
        expect(island.cellStock(1, -2).water).toBeUndefined();
    });

    it('exchange trades between actor bags atomically', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        island.spawnKit('a', { berry: 2 });
        island.spawnKit('b', { shell: 1 });
        // A trades 1 berry for 1 shell
        expect(island.exchange(ael, bram, { berry: 1 }, { shell: 1 })).toBe(true);
        expect(island.of('a')).toEqual({ berry: 1, shell: 1 });
        expect(island.of('b')).toEqual({ berry: 1 });
        // Trade event is logged (index 0 is the spawn event)
        const exchanges = world.events.log().filter((event) => event.kind === 'exchange');
        expect(exchanges[0].message).toBe('Ael and Bram trade: 1 Berry for 1 Shell.');
    });

    it('exchange refuses when either side cannot pay', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        island.spawnKit('a', { berry: 1 });
        island.spawnKit('b', { shell: 1 });
        // Bram has no fish to give
        expect(island.exchange(ael, bram, { berry: 1 }, { fish: 1 })).toBe(false);
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.of('b')).toEqual({ shell: 1 });
    });

    it('give transfers one-way and logs a gift', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        island.spawnKit('a', { fish: 1 });
        expect(island.give(ael, bram, 'fish', 1)).toBe(true);
        expect(island.of('a')).toEqual({});
        expect(island.of('b')).toEqual({ fish: 1 });
        const gifts = world.events.log().filter((event) => event.kind === 'exchange');
        expect(gifts[0].message).toBe('Ael gives Bram 1 Fish.');
        // Cannot give what is not held
        expect(island.give(ael, bram, 'fish', 1)).toBe(false);
    });

    it('cellsWithItem lists cells holding an item', () => {
        const { island } = buildWorld();
        // Only sea cells hold fish initially (143 water cells on the default island)
        const fishCells = island.cellsWithItem('fish');
        expect(fishCells.length).toBe(143);
        expect(fishCells.every((cell) => !cell.passable)).toBe(true);
        // The richer map's foods: every forest cell stocks a mushroom (the
        // 59 woods at the 0.8 wetland cutoff), and 21 of the woods hang a
        // vine (the 35% draw); the sea's seaweed covers the deep ocean plus
        // half the shallows — 94 cells
        expect(island.cellsWithItem('mushroom').length).toBe(59);
        expect(island.cellsWithItem('vine').length).toBe(21);
        expect(island.cellsWithItem('seaweed').length).toBe(94);
        // The tree mirror stands on the 59 woods AND the ingressed meadows
        // (104 treed tiles — the 0.8 wetlands lose treed grass; the
        // neighborhood model's counts move per tile)
        expect(island.cellsWithItem('tree').length).toBe(104);
        // The ground supply blankets the dry land (see the census pins)
        expect(island.cellsWithItem('stone').length).toBe(282);
        expect(island.cellsWithItem('dirt').length).toBe(282);
        expect(island.cellsWithItem('grass').length).toBe(135);
        expect(island.cellsWithItem('sand').length).toBe(138);
    });

    it('the standing tree is never bagged — trees are living things', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // takeFromCell('tree') refuses — the tree stock is the MIRROR of
        // the forest records, not a pile of loose lumber; a tree's wood
        // goes through the harvest (the chop) instead
        expect(island.takeFromCell(ael, 'tree')).toBe(false);
        expect(island.of('a')).toEqual({});
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425, berry: 1, mushroom: 1, water: 1 });
    });

    it('regrowth restores stocks on the staggered rhythm', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 1, -2));
        void ael;
        // Meadow cell (1,−4): cap 3, rhythm every 30 minutes at offset 20 —
        // the first 19 one-minute steps stay silent, minute 20 regrows
        island.cellStock(1, -2).berry = 0;
        for (let index = 0; index < 19; index++) {
            world.step(); // minutes 1-19 → no minute hits the offset
        }
        expect(island.cellStock(1, -2).berry ?? 0).toBe(0);
        world.step(); // minute 20 regrows one berry
        expect(island.cellStock(1, -2).berry).toBe(1);
        // Cap respected: parked at cap, regrowth does not exceed 3
        island.cellStock(1, -2).berry = 3;
        world.step();
        world.step();
        expect(island.cellStock(1, -2).berry).toBe(3);
    });

    it('R2: a lake and a pond both stock fresh water, and the basin refills on the rhythm', () => {
        const { world, island } = buildWorld();
        // The 0.8 interior basins — 5 lakes + 8 ponds (13 wetland cells). A
        // LAKE cell (1,−5) and a POND cell (−4,−3) EACH stock drinking water
        // on the survey (both read as fresh water, seeded like the dry shore
        // ring that stands beside a basin — a land cast collects from either)
        expect(island.cellStock(1, -5).water).toBe(1);
        expect(island.cellStock(-4, -3).water).toBe(1);
        // THE 13 BASINS + THEIR DRY SHORE RING = 64 FRESH-WATER CELLS (the
        // thirst ladder's collect can reach all of them)
        expect(island.cellsWithItem('water').length).toBe(64);
        // THE REPLENISHMENT: drain the lake's pool to dry and the
        // FRESH_WATER_RHYTHM (every 30 minutes at offset 15) tops it back up
        // toward the cap of 2 — the basin's standing fresh water, refilled
        // independent of the scattered rain-pool pulse
        island.cellStock(1, -5).water = 0;
        for (let index = 0; index < 15; index++) { world.step(); } // minute 15 → +1
        expect(island.cellStock(1, -5).water).toBe(1);
        for (let index = 0; index < 30; index++) { world.step(); } // minute 45 → +1, at the cap
        expect(island.cellStock(1, -5).water).toBe(2);
        for (let index = 0; index < 30; index++) { world.step(); } // minute 75 → clamped at the cap
        expect(island.cellStock(1, -5).water).toBe(2);
    });

    it('the tree mirror never regrows on a stock rhythm — the ecology owns the trees', () => {
        const { world, island } = buildLegacyWorld();
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        void ael;
        // The toy tree regrow clock is GONE: the standing-tree count moves
        // only through the plugins/forest ecology (recruitment/full fells).
        // A stand-less legacy fixture cut drops the mirror and nothing grows
        // it back on a 60-minute rhythm any more
        island.cellStock(0, 0).tree = 3;
        island.harvest(ael, 'tree', 'wood');
        expect(island.cellStock(0, 0).tree).toBe(2);
        for (let index = 0; index < 80; index++) {
            world.step();
        }
        expect(island.cellStock(0, 0).tree).toBe(2);
    });

    it('dispose wipes all bags and stocks', () => {
        const { world, island } = buildWorld();
        world.spawn(actor('a', 'Ael', -7, 0));
        island.spawnKit('a', { berry: 1 });
        world.plugins.remove('inventory');
        // Re-touching creates a fresh empty bag
        expect(island.of('a')).toEqual({});
        expect(island.cellStock(-7, 0)).toEqual({});
    });

    it('resurvey wipes and re-seeds cell stocks after a terrain regeneration', () => {
        const plugin = islandTerrainPlugin();
        const island = inventoryPlugin();
        const world = createWorld({ seed: 7, plugins: [plugin, island] });
        void world;
        // Shrink the island and re-survey the new canvas
        plugin.resize(21, 13);
        island.resurvey();
        // Reference cells on the 21×13 island (row-major survey order):
        // first beach (−3,−5) hit the shell draw this run; first forest
        // (−1,−3) mirrors its neighborhood-counted 205-tree stand
        // (the R3 coastal band shifted the first wood one row east)
        expect(island.cellStock(-3, -5)).toEqual({ stone: 1, dirt: 1, sand: 1, coconut: 1, shell: 1 });
        expect(island.cellStock(-1, -3)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 205, berry: 1, mushroom: 1 });
        // Stocks from the OLD canvas are gone: a cell that only existed on
        // the 25×17 island (0,−7) now has no stock (out of bounds)
        expect(island.cellStock(0, -7)).toEqual({});
        // Water cells stock fish again on the new canvas
        expect(island.cellsWithItem('fish').length).toBe(111);
    });

    it('rain gathers pools on a scattered subset of the land, on the seeded rhythm', () => {
        const island = inventoryPlugin();
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        const rains: number[] = [];
        const unsubscribe = world.events.subscribe((event) => {
            if (event.kind === 'weather') {
                rains.push(event.tick);
            }
        });
        for (let index = 0; index < 600; index++) {
            world.step(); // 600 one-minute steps — the same 600 world-minutes
        }
        unsubscribe();
        // Reference run: the per-minute rain roll (0.0127/min) fired on
        // minutes 8, 38, 331, 361, 369, 546, 567 — the roll stream is
        // untouched by the pool sweep (each cell's pool roll comes from its
        // own keyed stream; the 0.8 wetland pass changed the land-cell set
        // the rains wets, so the capture moved)
        expect(rains).toEqual([8, 38, 331, 361, 369, 546, 567]);
        // Beach (−5,−7): coconut regrew to cap 2; TWO rains pooled water
        // here (the patchwork — pools gather on a scattered subset of the
        // land, not under every foot; the pile clamps at the cap of 2);
        // the unlimited ground supply never moved
        expect(island.cellStock(-5, -7)).toEqual({ stone: 1, dirt: 1, sand: 1, coconut: 2, water: 2 });
        // The patchwork census: seven rains × 25% pool chance per cell —
        // 264 cells ever pooled (the 0.8 wetlands' shore cells pool too;
        // a fresh rain still only wets a fraction of the island; the cast
        // must travel to a pool and COLLECT before anything drinks)
        expect(island.cellsWithItem('water').length).toBe(264);
    });
});

describe('inventoryPlugin — the entity profiles: bag sizes and the mine gate', () => {
    /** The stack with the entity profiles mounted (sizes + abilities). */
    const buildProfiled = () => {
        const profiles = entityPlugin();
        const island = inventoryPlugin({ profiles });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island, profiles] });
        return { world, island, profiles };
    };

    /** A CREATURE fixture (coordinate-space resident, not an actor). */
    const creature = (id: string, name: string, type: string, x: number, y: number) => ({
        id,
        position: position3(x, y),
        kind: 'creature' as const,
        type,
        name,
        marker: name.slice(0, 1),
        state: 'roaming',
    });

    it('capacityOf resolves the species sizes — a bird carries 2–3 things, a human eight', () => {
        const { world, island } = buildProfiled();
        world.spawn(actor('a', 'Ael', -7, 0));
        world.coordinates.place(creature('bird-1', 'Kiki', 'bird', 0, 0));
        world.coordinates.place(creature('shark-1', 'Finn', 'shark', -12, -8));
        world.coordinates.place(creature('boar-1', 'Tusk', 'boar', 4, 7));
        expect(island.capacityOf('a')).toBe(8);
        expect(island.capacityOf('bird-1')).toBe(3);
        expect(island.capacityOf('shark-1')).toBe(1);
        expect(island.capacityOf('boar-1')).toBe(2);
        // An unknown species carries the stock human's eight
        world.coordinates.place(creature('dog-1', 'Rex', 'dog', 1, 1));
        expect(island.capacityOf('dog-1')).toBe(8);
    });

    it('a full bag refuses more takes — the size is a hard clamp', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -4, -7));
        // The beach's unlimited sand piles fill the eight-unit bag
        for (let index = 0; index < 8; index++) {
            expect(island.takeFromCell(ael, 'sand')).toBe(true);
        }
        expect(inventoryTotal(island.of('a'))).toBe(8);
        // The ninth unit does not fit: the take fails, the bag is untouched
        expect(island.takeFromCell(ael, 'sand')).toBe(false);
        expect(inventoryTotal(island.of('a'))).toBe(8);
        // A coconut would fit only if a unit left first
        expect(island.of('a')).toEqual({ sand: 8 });
        island.consume(ael, 'sand'); // one unit freed
        expect(island.takeFromCell(ael, 'coconut')).toBe(true);
        expect(island.of('a')).toEqual({ sand: 7, coconut: 1 });
    });

    it('a bird beak holds three things and no more', () => {
        const { world, island } = buildProfiled();
        world.coordinates.place(creature('bird-1', 'Kiki', 'bird', -4, -7));
        // takeFromCell reads the entity's POSITION for the cell stock and
        // its TYPE (through the coordinate facet) for the capacity
        const birdActor = { id: 'bird-1', position: position3(-4, -7) } as Actor;
        for (let index = 0; index < 3; index++) {
            expect(island.takeFromCell(birdActor, 'sand')).toBe(true);
        }
        expect(island.of('bird-1')).toEqual({ sand: 3 });
        // A fourth unit does not fit the beak
        expect(island.takeFromCell(birdActor, 'sand')).toBe(false);
        expect(island.of('bird-1')).toEqual({ sand: 3 });
    });

    it('harvest respects the capacity atomically — a full bag never fells a tree', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Fill the eight-unit bag
        island.spawnKit('a', { sand: 8 });
        // The forest stands (425 trees) — but the bag cannot hold the wood
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        // The tree never came down: stock, deposit and bag all untouched
        expect(island.cellStock(-7, 0)).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425, berry: 1, mushroom: 1, water: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ stone: 1, dirt: 1, grass: 1, tree: 425 });
        expect(island.of('a')).toEqual({ sand: 8 });
    });

    it('gather respects the capacity — a full bag gathers nothing', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', 1, -2));
        for (let index = 0; index < 8; index++) {
            island.takeFromCell(ael, 'dirt');
        }
        // The meadow's two berries cannot fit — the gather is a no-op
        expect(island.gather(ael)).toBe(null);
        expect(island.cellStock(1, -2)).toEqual({ tree: 10, stone: 1, dirt: 1, grass: 1, berry: 2 });
        expect(island.of('a')).toEqual({ dirt: 8 });
    });

    it('exchange and give refuse when the receiver bag cannot hold the goods', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        island.spawnKit('a', { berry: 5 });
        // Bram's bag is full (eight flints)
        island.spawnKit('b', { flint: 8 });
        expect(inventoryTotal(island.of('b'))).toBe(8);
        // A one-berry offer does not fit Bram's bag — nothing moves
        expect(island.exchange(ael, bram, { berry: 1 }, { flint: 1 })).toBe(false);
        expect(island.of('a')).toEqual({ berry: 5 });
        expect(island.of('b')).toEqual({ flint: 8 });
        // The gift route refuses too
        expect(island.give(ael, bram, 'berry', 1)).toBe(false);
        // One unit of room: the trade goes through (Bram pays the flint)
        island.consume(bram, 'flint');
        expect(island.exchange(ael, bram, { berry: 1 }, { flint: 1 })).toBe(true);
        expect(island.of('b')).toEqual({ flint: 6, berry: 1 });
    });

    it('spawnKit clamps the starting kit to the bag size', () => {
        const { world, island } = buildProfiled();
        world.spawn(actor('a', 'Ael', -7, 0));
        // A twelve-berry kit overflows the eight-unit bag
        island.spawnKit('a', { berry: 12 });
        expect(island.of('a')).toEqual({ berry: 8 });
    });

    it('the mine gate: only miners take stone and iron — a bird picks up nothing', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', 0, 0)); // the highland stone
        // The human holds the mine ability — the stone comes off the tile
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        expect(island.of('a')).toEqual({ stone: 1 });
        // The bird hops onto the same highland — no mine ability, no ore
        const birdActor = { id: 'bird-1', position: position3(0, 0) } as Actor;
        expect(island.takeFromCell(birdActor, 'stone')).toBe(false);
        expect(island.of('bird-1')).toEqual({});
        // The GROUND SUPPLY never moved: the unlimited stone deposit stands
        // (the mine gate limits WHO quarries, not how much is there — the
        // human's own take drew nothing down either)
        expect(world.cellAt(0, 0)?.resources).toEqual({ stone: 1, dirt: 1 });
    });

    it('without profiles every hand may mine — the pre-entity behavior', () => {
        const island = inventoryPlugin({ rainChancePerMinute: 0 });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        const ael = world.spawn(actor('a', 'Ael', 0, 0));
        // The bird stands on a SECOND highland — each carries its own stone
        const birdActor = { id: 'bird-1', position: position3(1, 0) } as Actor;
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        expect(island.capacityOf('a')).toBe(Infinity);
        // No entity plugin → no ability system → the bird takes stone too
        expect(island.takeFromCell(birdActor, 'stone')).toBe(true);
        expect(island.of('bird-1')).toEqual({ stone: 1 });
    });
});

describe('R2 — the berry bush', () => {
    // R2 — the BERRY BUSH: a concrete, standing berry plant in the meadow and
    // forest undergrowth, seeded on a fully deterministic per-coordinate hash
    // (no random-stream draw, so the placement is stable for a given island).
    // Its stock count is the berries it BEARS: foraging plucks a berry off it
    // (the stand draws down) and a dedicated tick pass refills the plucked
    // stand (the bush regrows). It is a visible, inspectable feature — never
    // an abstract bag item.
    it('stands deterministically on a meadow cell — a visible, inspectable feature', () => {
        const { island } = buildWorld();
        // The survey's first berry bush (the row-major scan hits (−1,−5) — a
        // meadow cell): its two loose berries, the standing bush, and the
        // column's unlimited ground supply
        expect(island.cellStock(-1, -5)).toEqual({
            berry: 2,
            bush: 1,
            dirt: 1,
            grass: 1,
            stone: 1,
        });
        // A ground-item (not a tile deposit) — the ground listing carries it
        // AND the canvas type palette resolves its glyph, so the bush stands
        // as its own visible plant beside the berries it bears
        expect(
            inventoryEntries(island.cellStock(-1, -5)).map((stack) => stack.item),
        ).toContain('bush');
        expect(ITEM_TYPE_GLYPHS.bush).toBe('🪴');
    });

    it('furnishes berries foraging plucks off it — and the stand regrows', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -1, -5));
        // Clear the loose berries so the BUSH path (not the loose-food path)
        // is the one exercised
        const stock = island.cellStock(-1, -5);
        stock.berry = 0;
        expect(stock.bush).toBe(1);
        // Forage off the bush: it yields a berry (the bush's stock IS the
        // berries it bears), the stand draws down, and the berry lands in
        // the bag
        expect(island.gather(ael)).toBe('berry');
        // The stand is drawn to zero (the `bush` key falls out of the stock
        // at zero — the regrowth pass keys the plant off the registry, not
        // the stock key, so the depleted stand still regrows)
        expect(island.cellStock(-1, -5).bush ?? 0).toBe(0);
        expect(island.of('a')).toEqual({ berry: 1 });
        // THE REGROW: step the world to the bush rhythm (the 40-minute
        // cadence hits its offset at minute 25) — the plucked stand refills
        // its berry. The dedicated pass keeps the standing plant in the
        // regrowth sweep even at zero (no depletion-vanishing).
        let bush = 0;
        for (let minute = 0; minute < 40; minute++) {
            world.step();
            bush = island.cellStock(-1, -5).bush ?? 0;
        }
        expect(bush).toBe(1);
    });
});
