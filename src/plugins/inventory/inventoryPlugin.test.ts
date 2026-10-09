// Tests for the inventory environment plugin (plugins/inventory/inventoryPlugin.ts).
// Uses the default seed-7 island (25×17, centered coordinates) as fixture;
// the exact stock layouts below were captured from a reference run and must
// never drift.
//
// Tile DEPOSITS (TerrainCell.resources) seed the gatherable stocks: the
// UNLIMITED GROUND supply (dirt/grass/sand — every dry column carries its
// ground voxels, never drawn down), the FINITE STONE stock (R4: the
// localized highland rock sites only — 3 units each — it draws down with
// the mine gate and the 🪨 icon drops when it empties), and the TREE
// MIRROR under the neighborhood model (every forest seeds its
// 8-neighbor-counted coverage — the persistent fine-scale stand,
// plugins/terrain — and every meadow beside woods its localized edge
// ingress; the reference wood (−7,0) at the full 425 clamp, the meadow
// (1,−2) at its 14-spot fringe), plus iron lodes on the vein noise's
// picks. Cell stocks
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
import { inventoryPlugin, type InventoryPlugin } from './inventoryPlugin';
import { inventoryEntries, type Inventory } from './inventory';
import { ITEM_TYPE_GLYPHS, inventoryWeight } from './items';

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
//   (1,−2)    meadow  stock {tree:14, dirt:1, grass:1, berry:3}
//             (the meadow's localized edge ingress beside the woods — T2's
//             14-spot fringe; the 0.8 wetland pass turned the old (1,−4)
//             meadow into a lake, so the meadow pins moved to (1,−2); the
//             abundance tuning seeds 3 berries on every meadow — R7 leaves
//             the meadow seeding EXACTLY as it was)
//   (−7,0)    forest  stock {dirt:1, grass:1, tree:425, berry:4, mushroom:3,
//             bush:1, water:1} (R7 — the forest is the island's larder: the
//             woods seed berry 4 + mushroom 3, and the forest bush chance
//             0.6 puts a standing berry bush on this cell (its fold 0.408
//             clears the old 0.3); the vine draw's NEW outcome on this cell
//             is stream-determined — the stock pins normalize the vine key
//             away, see stockWithoutVine)
//   (−4,−7)   beach   stock {dirt:1, sand:1, coconut:2} (shell draw missed)
//   (−5,−7)   beach   stock {dirt:1, sand:1, coconut:2} (shell draw missed)
//   (−12,−8)  shallows stock {fish:2}                     (seaweed draw missed; R5 shoal)
//   (0,0)     highland stock {stone:3, dirt:1, flint:1}   (finite rock stock + 30% flint draw hit)
//   (−1,−1)   highland stock {stone:3, iron:1, dirt:1}    (the R5 iron lode + its rock stock)
//   (0,−1)    highland stock {stone:3, dirt:1}            (flint draw missed)
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

/**
 * R7 — VINE-KEY NORMALIZATION for the forest stock pins. The vine seeding is
 * a RANDOM-STREAM draw (one context.random() value per forest cell, row
 * major). Raising the chance 0.35 → 0.6 keeps the stream order IDENTICAL
 * (the draw count per cell is unchanged — the shell/flint/seaweed/rain pins
 * never move), but it can flip a cell's vine outcome from miss to hit, and
 * the exact per-cell results are only capturable from a reference run (this
 * pass authors against in-flux sibling modules and does not execute). The
 * forest stock pins below therefore normalize the vine key away — EVERY
 * other key stays pinned to its exact expected value — while the vine
 * enrichment itself is pinned exactly by the threshold constant and the
 * census monotonicity assertions (the drawn set is provably a superset of
 * the old 21-cell map: same stream, same order, higher threshold).
 */
const stockWithoutVine = (island: InventoryPlugin, x: number, y: number): Inventory => {
    const copy = { ...island.cellStock(x, y) };
    delete copy.vine;
    return copy;
};

describe('inventoryPlugin', () => {
    it('seeds resources from tile deposits and biome living stocks on setup', () => {
        const { island } = buildWorld();
        // Meadow (1,−2) → the unlimited ground supply (dirt/grass) + its
        // 14-tree ingress fringe beside the woods (T2's densified fringe)
        // + 3 berries (the abundance tuning); R4: no stone — the meadow is
        // no stone-bearing site
        expect(island.cellStock(1, -2)).toEqual({ tree: 14, dirt: 1, grass: 1, berry: 3 });
        // Forest (−7,0) → the ground supply + its neighborhood-counted
        // full 425-tree mirror (the persistent fine-scale stand) + R7's
        // enriched woods: 4 berries + 3 mushrooms (the forest is the
        // island's larder) + a standing berry bush (the 0.6 forest chance,
        // fold 0.408) + the freshwater pass's pooled water. The vine key is
        // normalized (stream outcome — see stockWithoutVine).
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 425, berry: 4, mushroom: 3, bush: 1, water: 1 });
        // Beach (−4,−7) → the unlimited ground supply (dirt/sand), coconut
        // 2 (the abundance tuning); R4: no stone — the gravel bedrock supplies no more
        expect(island.cellStock(-4, -7)).toEqual({ dirt: 1, sand: 1, coconut: 2 });
        // Sea (−12,−8) → fish shoal 2 (R5's abundant seeding — a cell holds
        // a shoal, not a lone fish; the shallows seaweed draw missed; no
        // tile deposits under water — submerged columns supply nothing)
        expect(island.cellStock(-12, -8)).toEqual({ fish: 2 });
    });

    it('seeds stone (every dry column), iron lodes (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        // Reference highlands on the default island: (0,0) hid a flint
        // (30% draw hit); (−1,−1) holds the R5 iron lode (the 0.8 board
        // guarantees a single lode where the vein noise missed); (0,−1)
        // missed the flint. R4: every highland rock site carries the
        // finite 3-unit stone stock with them
        expect(island.cellStock(0, 0)).toEqual({ stone: 3, dirt: 1, flint: 1 });
        expect(island.cellStock(-1, -1)).toEqual({ stone: 3, iron: 1, dirt: 1 });
        expect(island.cellStock(0, -1)).toEqual({ stone: 3, dirt: 1 });
        // THE GROUND SUPPLY IS EVERYWHERE its voxels are: all 269 dry land
        // cells carry dirt (the ground layer under every surface; R4's 13
        // drowned basins left the land census); grass covers meadows AND
        // woods; STONE is FINITE - it stands only on the 9 highland rock
        // sites (the exact list the islandTerrain census pins)
        expect(island.cellsWithItem('stone').length).toBe(9);
        expect(island.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`).sort()).toEqual([
            '-1,-1', '-1,0', '-1,1', '-2,0', '0,-1', '0,0', '0,1', '1,0', '1,1',
        ]);
        expect(island.cellsWithItem('dirt').length).toBe(269);
        expect(island.cellsWithItem('grass').length).toBe(122);
        // The unlimited sand stays beach-only (the R3 2-tile coastal band
        // shrank the sands from 160 to 138)
        expect(island.cellsWithItem('sand').length).toBe(138);
        // THE R5 GATE: the 0.8 board holds exactly ONE iron lode (at
        // (−1,−1)) — the finite mineable deposit the early tools need
        expect(island.cellsWithItem('iron').map((cell) => `${cell.x},${cell.y}`)).toEqual(['-1,-1']);
        // The 37×25 reference board lodes 3 highlands — the lodes carry the
        // finite rock stock too (deposits seed in TILE_RESOURCES order:
        // stone before iron); (−5,2) hid a flint this run (30% draw hit)
        const big = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 37, height: 25 }), big] });
        expect(big.cellStock(-7, 0)).toEqual({ stone: 3, dirt: 1 });
        expect(big.cellStock(-5, 3)).toEqual({ stone: 3, dirt: 1, iron: 1 });
        // The other two lodes: (−7,1) and (−5,2) — the lodes carry the
        // rock stock too
        expect(big.cellStock(-7, 1)).toEqual({ stone: 3, dirt: 1, iron: 1 });
        expect(big.cellStock(-5, 2)).toEqual({ stone: 3, dirt: 1, iron: 1, flint: 1 });
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
        // R7: the forest seeds berry 4 — one gathered leaves 3 (the berry
        // still seeds before the mushroom in the stock's insertion order)
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 425, berry: 3, mushroom: 3, bush: 1, water: 1 });
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
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 425 });
        // THE BIOLOGICAL BOUNDARY — the tile carries a persistent stand,
        // no forest ecology is mounted (the legacy inventory-only fixture):
        // the whole-tree harvest is refused BEFORE any mutation — a living
        // tree harvests only through its owner (the remount-farm fix)
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(island.of('a')).toEqual({});
        // R7: the refused harvest leaves the enriched woods untouched (berry
        // 4, mushroom 3, the standing bush; vine normalized)
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 425, berry: 4, mushroom: 3, bush: 1, water: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 425 });
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
        // Lode (−5,3): the finite rock stock + iron — the ore and the rock
        // both stand on this local site (R4: stone is the mined resource,
        // not the ground)
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 3, dirt: 1, iron: 1 });
        expect(island.takeFromCell(ael, 'iron')).toBe(true);
        expect(island.of('a')).toEqual({ iron: 1 });
        // The ore is gone, the tile keeps its rock stock + unlimited ground
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 3, dirt: 1 });
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        // R4: the STONE TAKE DRAWS THE SITE DOWN (3 → 2) — the finite
        // resource depletes with the stock, and the tile keeps reading its
        // highland surface while the rock stock stands
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 2, dirt: 1 });
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
        expect(island.cellStock(-4, -7)).toEqual({ dirt: 1, sand: 1, coconut: 2 });
        expect(world.cellAt(-4, -7)?.resources).toEqual({ dirt: 1, sand: 1 });
        // Dirt works the same on meadows (T2's densified 14-spot stand
        // stands beside the pile)
        const bram = world.spawn(actor('b', 'Bram', 1, -2));
        expect(island.takeFromCell(bram, 'dirt')).toBe(true);
        expect(island.of('b')).toEqual({ dirt: 1 });
        expect(island.cellStock(1, -2)).toEqual({ tree: 14, dirt: 1, grass: 1, berry: 3 });
        expect(world.cellAt(1, -2)?.resources).toEqual({ dirt: 1, grass: 1, tree: 14 });
        // The new grass identity: pulled off the meadow's grass cover,
        // never depleting
        expect(island.takeFromCell(bram, 'grass')).toBe(true);
        expect(island.of('b')).toEqual({ dirt: 1, grass: 1 });
    });

    it('the finite stone stock draws down with every mine — the site exhausts', () => {
        const { world, island } = buildWorld();
        const miner = world.spawn(actor('a', 'Ael', 0, 0)); // the highland site
        // R4: stone is the FINITE rock-site stock (3 units on (0,0)) —
        // every take draws the deposit down, the meadow-style unlimited
        // supply it was before the gravel conversion is gone
        expect(island.takeFromCell(miner, 'stone')).toBe(true);
        expect(world.cellAt(0, 0)?.resources).toEqual({ stone: 2, dirt: 1 });
        expect(island.takeFromCell(miner, 'stone')).toBe(true);
        expect(world.cellAt(0, 0)?.resources).toEqual({ stone: 1, dirt: 1 });
        expect(island.takeFromCell(miner, 'stone')).toBe(true);
        // The third take empties the site — the stone deposit drops out of
        // the record (0 is no stock), the unlimited dirt underlayer stays
        expect(world.cellAt(0, 0)?.resources).toEqual({ dirt: 1 });
        expect(island.of('a')).toEqual({ stone: 3 });
        // An exhausted site REFUSES further takes (the stock is gone — the
        // mine gate's hands have nothing left to work)
        expect(island.takeFromCell(miner, 'stone')).toBe(false);
        expect(island.of('a')).toEqual({ stone: 3 });
        expect(world.cellAt(0, 0)?.resources).toEqual({ dirt: 1 });
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
        // Only water cells hold fish initially — the sea AND the impassable
        // fresh basins (156 water cells on the default island since R4
        // drowned the 13 basins; every one of them stocks a fish shoal)
        const fishCells = island.cellsWithItem('fish');
        expect(fishCells.length).toBe(156);
        expect(fishCells.every((cell) => !cell.passable)).toBe(true);
        // The richer map's foods: every forest cell stocks a mushroom (the
        // 59 woods at the 0.8 wetland cutoff — R7 raises the mushroom SEED
        // to 3 per wood, not the wood count, so the census stays exactly
        // 59); the sea's seaweed covers the deep ocean plus half the
        // shallows — 94 cells
        expect(island.cellsWithItem('mushroom').length).toBe(59);
        expect(island.cellsWithItem('seaweed').length).toBe(94);
        // R7 — the vine census GREW with the 0.35 → 0.6 chance raise. The
        // stream order is unchanged (one draw per forest cell, row major),
        // so every cell drawn under the old 0.35 stays drawn: the new map
        // is a PROVABLE SUPERSET of the old 21-cell map. The exact census
        // needs one reference re-capture (this pass does not execute —
        // sibling modules are in flux); the bound below is the invariant.
        expect(island.cellsWithItem('vine').length).toBeGreaterThanOrEqual(21);
        // The tree mirror stands on the 59 woods AND the ingressed meadows
        // (93 treed tiles since R4 washed the 13 drowned basins clean — the
        // neighborhood model's counts move per tile)
        expect(island.cellsWithItem('tree').length).toBe(93);
        // R4: the finite stone stands only on the 9 highland rock sites;
        // the unlimited dirt blankets the dry land (see the census pins)
        expect(island.cellsWithItem('stone').length).toBe(9);
        expect(island.cellsWithItem('dirt').length).toBe(269);
        expect(island.cellsWithItem('grass').length).toBe(122);
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
        // R7: the enriched woods (berry 4, mushroom 3, standing bush; vine
        // normalized) stay whole
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 425, berry: 4, mushroom: 3, bush: 1, water: 1 });
    });

    it('regrowth restores stocks on the staggered rhythm — even from a fully harvested cell', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 1, -2));
        // Meadow cell (1,−2): R7 cap 6, rhythm every 30 minutes at offset
        // 20 (the clock is untouched) — the first 19 one-minute steps stay
        // silent, minute 20 regrows.
        // HARVEST TO ZERO through the real take: inventoryRemove DELETES the
        // zeroed stock key — the old stock-keyed sweep lost the cell forever
        // (the exhausted-source bug); the eligibility registry keeps it alive
        while (island.takeFromCell(ael, 'berry')) {
            // drain the meadow's 3 seeded berries
        }
        expect(island.cellStock(1, -2).berry ?? 0).toBe(0);
        expect(island.of('a')).toEqual({ berry: 3 });
        for (let index = 0; index < 19; index++) {
            world.step(); // minutes 1-19 → no minute hits the offset
        }
        expect(island.cellStock(1, -2).berry ?? 0).toBe(0);
        world.step(); // minute 20 regrows one berry onto the BARE cell
        expect(island.cellStock(1, -2).berry).toBe(1);
        // Cap respected: parked at the R7 abundance cap of 6, regrowth never
        // exceeds it — step past the next berry pulse (minute 50)
        island.cellStock(1, -2).berry = 6;
        for (let index = 0; index < 30; index++) {
            world.step(); // minutes 21-50 — minute 50's pulse stays clamped
        }
        expect(island.cellStock(1, -2).berry).toBe(6);
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
        // (−1,−3) mirrors its neighborhood-counted 246-tree stand (T2's
        // densified counts; the R3 coastal band shifted the first wood one
        // row east)
        expect(island.cellStock(-3, -5)).toEqual({ dirt: 1, sand: 1, coconut: 2, shell: 1 });
        // R7: the re-surveyed wood seeds berry 4 + mushroom 3 (no bush here
        // — the fold 0.852 clears even the raised 0.6 forest chance; the
        // vine draw is normalized — see stockWithoutVine)
        expect(stockWithoutVine(island, -1, -3)).toEqual({ dirt: 1, grass: 1, tree: 246, berry: 4, mushroom: 3 });
        // Stocks from the OLD canvas are gone: a cell that only existed on
        // the 25×17 island (0,−7) now has no stock (out of bounds)
        expect(island.cellStock(0, -7)).toEqual({});
        // Water cells stock fish again on the new canvas (114 on the 21×13
        // board — R4's 3 drowned basins joined the sea's 111)
        expect(island.cellsWithItem('fish').length).toBe(114);
    });

    it('rain is WEATHER only — it gathers no drinking pools (R4)', () => {
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
        // The weather roll stream is UNTOUCHED by removing the pool sweep —
        // the old per-cell pool rolls rode their OWN keyed stream, so the
        // rain minutes are identical to the pre-R4 reference run
        expect(rains).toEqual([8, 38, 331, 361, 369, 546, 567]);
        // R4 — rain scatters NO water: an ordinary beach tile that is not a
        // basin holds no water stock (the old run pooled water:2 here)
        expect(island.cellStock(-5, -7).water ?? 0).toBe(0);
        // The water census is ONLY the survey's fresh-water basins + their
        // dry shore ring — identical to a rain-off island (rain contributes
        // nothing to the water supply any more)
        const dry = inventoryPlugin({ rainChancePerMinute: 0 });
        const dryWorld = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), dry] });
        for (let index = 0; index < 600; index++) {
            dryWorld.step();
        }
        expect(island.cellsWithItem('water').length).toBe(dry.cellsWithItem('water').length);
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

    it('capacityOf resolves the species WEIGHT budgets — a bird 75, a human 200', () => {
        const { world, island } = buildProfiled();
        world.spawn(actor('a', 'Ael', -7, 0));
        world.coordinates.place(creature('bird-1', 'Kiki', 'bird', 0, 0));
        world.coordinates.place(creature('shark-1', 'Finn', 'shark', -12, -8));
        world.coordinates.place(creature('boar-1', 'Tusk', 'boar', 4, 7));
        expect(island.capacityOf('a')).toBe(200);
        expect(island.capacityOf('bird-1')).toBe(75);
        expect(island.capacityOf('shark-1')).toBe(25);
        expect(island.capacityOf('boar-1')).toBe(50);
        // An unknown species carries the stock human's 200
        world.coordinates.place(creature('dog-1', 'Rex', 'dog', 1, 1));
        expect(island.capacityOf('dog-1')).toBe(200);
    });

    it('a full bag refuses more takes — the WEIGHT budget is a hard clamp', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -4, -7));
        // Sand weighs 30 — a 200-weight person shoulders SIX (180), the
        // seventh (210) overflows and the take fails
        for (let index = 0; index < 6; index++) {
            expect(island.takeFromCell(ael, 'sand')).toBe(true);
        }
        expect(inventoryWeight(island.of('a'))).toBe(180);
        // The seventh unit does not fit: the take fails, the bag is untouched
        expect(island.takeFromCell(ael, 'sand')).toBe(false);
        expect(inventoryWeight(island.of('a'))).toBe(180);
        // A coconut (30) fits only once a unit leaves first
        expect(island.of('a')).toEqual({ sand: 6 });
        island.consume(ael, 'sand'); // 150 now — a coconut (30) fits at 180
        expect(island.takeFromCell(ael, 'coconut')).toBe(true);
        expect(island.of('a')).toEqual({ sand: 5, coconut: 1 });
    });

    it('a bird beak holds its 75 weight and no more', () => {
        const { world, island } = buildProfiled();
        world.coordinates.place(creature('bird-1', 'Kiki', 'bird', -4, -7));
        // takeFromCell reads the entity's POSITION for the cell stock and
        // its TYPE (through the coordinate facet) for the capacity
        const birdActor = { id: 'bird-1', position: position3(-4, -7) } as Actor;
        // Sand 30 — the beak (75) holds two (60); a third (90) overflows
        for (let index = 0; index < 2; index++) {
            expect(island.takeFromCell(birdActor, 'sand')).toBe(true);
        }
        expect(island.of('bird-1')).toEqual({ sand: 2 });
        // A third unit does not fit the beak
        expect(island.takeFromCell(birdActor, 'sand')).toBe(false);
        expect(island.of('bird-1')).toEqual({ sand: 2 });
    });

    it('harvest respects the capacity atomically — a full bag never fells a tree', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Fill the bag to its 200 WEIGHT budget (five 40-weight stones)
        island.spawnKit('a', { stone: 5 });
        // The forest stands (425 trees) — but the bag has no weight room for
        // even one 20-weight log
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        // The tree never came down: stock, deposit and bag all untouched
        // (R7's enriched woods; vine normalized)
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 425, berry: 4, mushroom: 3, bush: 1, water: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 425 });
        expect(island.of('a')).toEqual({ stone: 5 });
    });

    it('gather respects the capacity — a full bag gathers nothing', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', 1, -2));
        for (let index = 0; index < 8; index++) {
            island.takeFromCell(ael, 'dirt');
        }
        // The meadow's two berries cannot fit — the gather is a no-op
        expect(island.gather(ael)).toBe(null);
        expect(island.cellStock(1, -2)).toEqual({ tree: 14, dirt: 1, grass: 1, berry: 3 });
        expect(island.of('a')).toEqual({ dirt: 8 });
    });

    it('exchange refuses when the RECEIVER overflows on the net (R5 two-sided gate)', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        // Ael offers a 60-weight iron, Bram pays one 40-weight stone: Bram's
        // full 200 bag nets 200 − 40 + 60 = 220 — OVER, so nothing moves
        island.spawnKit('a', { iron: 1 });
        island.spawnKit('b', { stone: 5 });
        expect(island.exchange(ael, bram, { iron: 1 }, { stone: 1 })).toBe(false);
        expect(island.of('a')).toEqual({ iron: 1 });
        expect(island.of('b')).toEqual({ stone: 5 });
    });

    it('exchange refuses when the GIVER overflows on the net (the gate the old receiver-only check missed)', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        // Ael's full 200 bag hands a 40-weight stone for a 60-weight iron:
        // Ael nets 200 − 40 + 60 = 220 — OVER. Bram (60 carried) nets fine, so
        // the ONLY reason to refuse is the giver's overflow (the old gate
        // checked just the receiver and let this through).
        island.spawnKit('a', { stone: 5 });
        island.spawnKit('b', { iron: 1 });
        expect(island.exchange(ael, bram, { stone: 1 }, { iron: 1 })).toBe(false);
        expect(island.of('a')).toEqual({ stone: 5 });
        expect(island.of('b')).toEqual({ iron: 1 });
    });

    it('exchange ACCEPTS a capacity-neutral swap between two full bags (net, not naive canHold)', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        // Ael hands two 20-weight logs (40) for one 40-weight stone. Bram's
        // bag is FULL (200) but the stone he pays frees exactly the room the
        // logs need: net 200 − 40 + 40 = 200 ≤ 200. The naive canHold
        // (carried + incoming = 240) would wrongly refuse this equal-weight
        // swap; the net gate lets it through.
        island.spawnKit('a', { wood: 2, stone: 3 }); // 40 + 120 = 160
        island.spawnKit('b', { stone: 5 }); // 200
        expect(island.exchange(ael, bram, { wood: 2 }, { stone: 1 })).toBe(true);
        // Ael hands BOTH logs away for one stone: {wood:2, stone:3} → {stone:4}
        expect(island.of('a')).toEqual({ stone: 4 });
        expect(island.of('b')).toEqual({ stone: 4, wood: 2 });
        // Conservation: the weight is unchanged on both sides
        expect(inventoryWeight(island.of('a'))).toBe(160);
        expect(inventoryWeight(island.of('b'))).toBe(200);
    });

    it('exchange ACCEPTS an imbalance that stays within the cap (a full bag trading DOWN in weight)', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        const bram = world.spawn(actor('b', 'Bram', -7, 1));
        island.spawnKit('a', { berry: 5 });
        // Bram's bag is full to 200 (five stones) but he pays a 40-weight
        // stone for a 5-weight berry: net 200 − 40 + 5 = 165 ≤ 200 — the
        // trade frees room, so it goes through (the old gate refused it).
        island.spawnKit('b', { stone: 5 });
        expect(island.exchange(ael, bram, { berry: 1 }, { stone: 1 })).toBe(true);
        expect(island.of('a')).toEqual({ berry: 4, stone: 1 });
        expect(island.of('b')).toEqual({ stone: 4, berry: 1 });
        // The one-way GIFT still guards the receiver alone (no incoming to
        // net). Bram now carries 165 (four stones + a berry), so a 5-weight
        // berry gift fits (170 ≤ 200) — but a full 200 bag would refuse it.
        expect(island.give(ael, bram, 'berry', 1)).toBe(true);
        expect(island.of('b')).toEqual({ stone: 4, berry: 2 });
    });

    it('spawnKit clamps the starting kit to the WEIGHT budget', () => {
        const { world, island } = buildProfiled();
        world.spawn(actor('a', 'Ael', -7, 0));
        // A fifteen-log kit (300 weight) overflows the 200-weight bag — only
        // ten logs (200) land, the rest never enter the hand
        island.spawnKit('a', { wood: 15 });
        expect(island.of('a')).toEqual({ wood: 10 });
    });

    it('the mine gate: only miners take stone and iron — a bird picks up nothing', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', 0, 0)); // the highland stone site
        // The human holds the mine ability — the stone comes off the tile
        // and draws the finite site down (R4: 3 → 2)
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        expect(island.of('a')).toEqual({ stone: 1 });
        // The bird hops onto the same highland — no mine ability, no ore
        const birdActor = { id: 'bird-1', position: position3(0, 0) } as Actor;
        expect(island.takeFromCell(birdActor, 'stone')).toBe(false);
        expect(island.of('bird-1')).toEqual({});
        // R4: the STONE STOCK drew down with the human's take (the finite
        // resource — the mine gate limits WHO quarries, and the quarry has
        // a real bottom now); the unlimited dirt underlayer never moved
        expect(world.cellAt(0, 0)?.resources).toEqual({ stone: 2, dirt: 1 });
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
        // meadow cell): its three loose berries (the abundance tuning), the
        // standing bush, and the column's unlimited ground supply (R4: no
        // stone — the meadow is no stone-bearing site)
        expect(island.cellStock(-1, -5)).toEqual({
            berry: 3,
            bush: 1,
            dirt: 1,
            grass: 1,
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

describe('inventoryPlugin — renewable abundance + regrowth eligibility', () => {
    // THE EXHAUSTED-SOURCE FIX + ABUNDANCE CAPS — a fully harvested
    // renewable cell (the take DELETES the zeroed stock key — the old
    // stock-keyed sweep lost such a cell forever) regrows on its rhythm
    // toward the raised cap, and ONLY on cells the survey seeded the item
    // on (the eligibility registry). Finite resources never regrow.
    it('a fully harvested renewable cell regrows to its abundance cap — berry, mushroom, coconut, fish, seaweed, vine', () => {
        const { world, island } = buildWorld();
        // Reference cells: meadow (1,−2) berry, forest (−7,0) mushroom,
        // beach (−4,−7) coconut, shallows (−12,−8) fish; the first seaweed
        // and vine cells the survey stocked (deterministic per seed)
        const seaweedCell = island.cellsWithItem('seaweed')[0];
        const vineCell = island.cellsWithItem('vine')[0];
        // Drain each cell BARE through the real take path
        const drain = (x: number, y: number, item: string) => {
            const forager = world.spawn(actor(`drain-${item}`, 'Drain', x, y));
            while (island.takeFromCell(forager, item)) {
                // drain the cell bare — the zeroed key leaves the stock
            }
            expect(island.cellStock(x, y)[item] ?? 0).toBe(0);
        };
        drain(1, -2, 'berry');
        drain(-7, 0, 'mushroom');
        drain(-4, -7, 'coconut');
        drain(-12, -8, 'fish');
        drain(seaweedCell.x, seaweedCell.y, 'seaweed');
        drain(vineCell.x, vineCell.y, 'vine');
        // 190 minutes carries every rhythm past its last pre-cap pulse at
        // the R7 caps (the rhythms themselves are untouched): berry
        // 20/50/80/110/140/170 → 6, mushroom 15/55/95/135/175 → 5, coconut
        // 10/70/130 → 3, fish 40/80/120 → 3 (R5's raised shoal cap),
        // seaweed 25/75 → 2, vine 30/110/190 → 3 (R7's richer re-hang — the
        // third pulse at minute 190 is what lifts the vine to its cap)
        for (let index = 0; index < 190; index++) {
            world.step();
        }
        expect(island.cellStock(1, -2).berry).toBe(6);
        expect(island.cellStock(-7, 0).mushroom).toBe(5);
        expect(island.cellStock(-4, -7).coconut).toBe(3);
        expect(island.cellStock(-12, -8).fish).toBe(3);
        expect(island.cellStock(seaweedCell.x, seaweedCell.y).seaweed).toBe(2);
        expect(island.cellStock(vineCell.x, vineCell.y).vine).toBe(3);
        // THE DETERMINISTIC MAP HOLDS — regrowth refills the SEEDED cells,
        // it never SPREADS: the census is exactly the survey's (59 woods
        // mushroom, 94 seaweed, 156 fish cells); the vine census is the
        // survey's R7 map — a provable superset of the old 21-cell draw
        // (same stream, same order, higher threshold; exact count needs one
        // reference re-capture, see the census note above)
        expect(island.cellsWithItem('mushroom').length).toBe(59);
        expect(island.cellsWithItem('vine').length).toBeGreaterThanOrEqual(21);
        expect(island.cellsWithItem('seaweed').length).toBe(94);
        expect(island.cellsWithItem('fish').length).toBe(156);
    });

    it('nothing regrows on ineligible cells and finite resources stay finite', () => {
        const { world, island } = buildWorld();
        // Highland (0,0): a rock site — the survey seeded NO renewable on
        // it (only the finite flint + stone and the unlimited dirt). Inject
        // every renewable, harvest it all, and NOTHING may come back: no
        // mushrooms on rock, no fish on land, no vines on bare stone
        const miner = world.spawn(actor('m', 'Mira', 0, 0));
        const stock = island.cellStock(0, 0);
        ['berry', 'mushroom', 'coconut', 'fish', 'seaweed', 'vine'].forEach((item) => {
            stock[item] = 1;
        });
        ['berry', 'mushroom', 'coconut', 'fish', 'seaweed', 'vine', 'flint'].forEach((item) => {
            expect(island.takeFromCell(miner, item)).toBe(true);
        });
        // Mine the FINITE rock site bare as well (3 units)
        expect(island.takeFromCell(miner, 'stone')).toBe(true);
        expect(island.takeFromCell(miner, 'stone')).toBe(true);
        expect(island.takeFromCell(miner, 'stone')).toBe(true);
        // Beach (−4,−7): a mushroom injected onto sand is harvested and
        // never returns (the mushroom registry holds woods, not beaches)
        const bram = world.spawn(actor('b', 'Bram', -4, -7));
        island.cellStock(-4, -7).mushroom = 1;
        expect(island.takeFromCell(bram, 'mushroom')).toBe(true);
        // Past every rhythm of the day
        for (let index = 0; index < 160; index++) {
            world.step();
        }
        // The highland keeps ONLY its unlimited ground supply — the finite
        // flint and the finite stone stayed exhausted (neither has a
        // regrowth entry), and none of the injected renewables regrew on
        // rock (the eligibility registry never listed this cell)
        expect(island.cellStock(0, 0)).toEqual({ dirt: 1 });
        // The beach keeps its OWN seeded renewable (coconut, regrown to the
        // cap of 3) but never regrew the mushroom that was never its own
        expect(island.cellStock(-4, -7).mushroom ?? 0).toBe(0);
        expect(island.cellStock(-4, -7).coconut).toBe(3);
    });

    it('the fish primitive works the shore: dry ground, cardinal reach, live shoal, room to carry (R5)', () => {
        // THE PROFILED STACK — the capacity gate needs the entity profiles
        // (a human carries the stock eight; no profiles means unlimited)
        const profiles = entityPlugin();
        const island = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island, profiles] });
        // Ael on the dry forest shoulder (7,2) of the drowned pond (6,2) —
        // R4 went impassable and the survey seeds every water cell with a
        // fish shoal (R5), fresh basins included
        const ael = world.spawn(actor('a', 'Ael', 7, 2));
        expect(island.cellStock(6, 2)).toEqual({ water: 1, fish: 2 });
        // THE CARDINAL CAST into the fresh basin: the take lands in the bag
        expect(island.fish(ael, 6, 2)).toBe(true);
        expect(island.of('a')).toEqual({ fish: 1 });
        expect(island.cellStock(6, 2).fish).toBe(1);
        // THE CAPACITY GATE fires before the shoal gives anything up: Ael's
        // hand (one 25-weight fish + four 40-weight stones = 185) has no room
        // for another 25-weight fish, so the last fish stays in the pool
        island.spawnKit('a', { stone: 4 });
        expect(island.fish(ael, 6, 2)).toBe(false);
        expect(island.cellStock(6, 2).fish).toBe(1);
        // DIAGONAL reach is refused — the tile at the body's feet is the
        // fishing granularity (the pond (6,2) sits diagonally from (7,3))
        const diagonal = world.spawn(actor('d', 'Di', 7, 3));
        expect(island.fish(diagonal, 6, 2)).toBe(false);
        // The dry neighbour holds no fish — the cast only lands in water
        expect(island.fish(ael, 6, 1)).toBe(false);
        // A body AFLOAT does not fish — dry ground underfoot is the shore
        // rule (a floater gathers the fish underfoot through `gather`)
        const floater = world.spawn(actor('f', 'Flo', 6, 2));
        expect(island.fish(floater, 6, 3)).toBe(false);
        // The shoal gives only what it holds: the next cast on the shore
        // takes the last fish, the one after faces an empty pool
        const bram = world.spawn(actor('b', 'Bram', 7, 2));
        expect(island.fish(bram, 6, 2)).toBe(true);
        expect(island.fish(bram, 6, 2)).toBe(false);
        expect(island.cellStock(6, 2).fish ?? 0).toBe(0);
    });
});
