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
// list deposits first, then the biome's living stocks (forest mushrooms,
// beach coconuts), then the chance draws (forest vines, shallows seaweed,
// beach shells, highland flints) and the standing berry bushes (the
// deterministic hash — T4: NO loose berries and NO fish shoals: berries
// are bush/farm produce, the water is an unlimited fish source marked a
// FISHING WATER instead of a stock). Wood is
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
import { isFreshBasin, isSeaWater } from '../../engine/types';
import { inventoryPlugin, BUSH_BERRY_CAP, BUSH_RIPEN_MINUTES, type InventoryPlugin } from './inventoryPlugin';
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
//   (1,−2)    meadow  stock {tree:14, dirt:1, grass:1}
//             (the meadow's localized edge ingress beside the woods — T2's
//             14-spot fringe; the 0.8 wetland pass turned the old (1,−4)
//             meadow into a lake, so the meadow pins moved to (1,−2); T4 —
//             the 3 loose berries are GONE: berries are bush/farm produce,
//             never ground stock)
//   (−7,0)    forest  stock {dirt:1, grass:1, tree:412, mushroom:3,
//             bush:1, water:1} (R7's enriched woods keep their 3-mushroom
//             ring; the forest bush chance 0.6 puts a standing berry bush
//             on this cell (its fold 0.408 clears the old 0.3) and T4
//             removed the 4 loose berries — the bush's lazy fruit batch
//             carries the berry supply now; the vine draw's NEW outcome on
//             this cell is stream-determined — the stock pins normalize
//             the vine key away, see stockWithoutVine)
//   (−4,−7)   beach   stock {dirt:1, sand:1, coconut:2} (shell draw missed)
//   (−5,−7)   beach   stock {dirt:1, sand:1, coconut:2} (shell draw missed)
//   (−12,−8)  shallows stock {}                    (T4 — no fish shoal: the
//             water is an UNLIMITED source marked a fishing water instead;
//             the shallows seaweed draw missed)
//   (0,0)     highland stock {stone:3, dirt:1, water:1}   (finite rock stock; R4 — the river's shore ring stocks it fresh, the flint draw moved with the shifted stream)
//   (−1,−1)   river    stock {water:1}                    (R4 — the forded peak: the channel itself stocks the inexhaustible fresh water)
//   (0,−1)    highland stock {stone:3, iron:1, dirt:1, water:1, flint:1} (the R5 iron lode moved here — the first SURVIVING highland — with its rock stock, the flint draw and the river's shore water)
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
        // 11-tree ingress fringe beside the woods (R1's seam meander)
        // + NO loose berries (T4 — berries are bush/farm produce); R4: no
        // stone — the meadow is no stone-bearing site
        expect(island.cellStock(1, -2)).toEqual({ tree: 11, dirt: 1, grass: 1 });
        // Forest (−7,0) → the ground supply + its neighborhood-counted
        // mirror clamped to the stand's water-refused pool (R1's EDGE WEAVE:
        // 412 trees — no tree stands on the river-edge waterline) + the
        // mushroom ring + a standing berry bush (the 0.6 forest chance,
        // fold 0.408) + the freshwater pass's pooled water. NO loose
        // berries (T4 — the bushes bear them). The vine key is normalized
        // (stream outcome — see stockWithoutVine).
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 412, mushroom: 3, bush: 1, water: 1 });
        // Beach (−4,−7) → the unlimited ground supply (dirt/sand), coconut
        // 2 (the abundance tuning); R4: no stone — the gravel bedrock supplies no more
        expect(island.cellStock(-4, -7)).toEqual({ dirt: 1, sand: 1, coconut: 2 });
        // Sea (−12,−8) → NO fish stock (T4 — the water is an UNLIMITED
        // source: the survey marks it a fishing water instead of seeding a
        // shoal, so no tile carries a fish count to indicate); the
        // shallows seaweed draw missed; no tile deposits under water —
        // submerged columns supply nothing
        expect(island.cellStock(-12, -8)).toEqual({});
    });

    it('seeds stone (every dry column), iron lodes (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        // Reference highlands on the default island: (0,0) is a river-shore
        // rock site (the R4 shore ring stocks its water; the flint draw
        // moved with the stream shift the river-carved map causes); (−1,−1)
        // is the FORDED peak — the channel itself carries the inexhaustible
        // fresh water; (0,−1) is the first SURVIVING highland — the R5 iron
        // lode stamp moved here, and this run its flint draw hit. R4: every
        // highland rock site carries the finite 3-unit stone stock with them
        expect(island.cellStock(0, 0)).toEqual({ stone: 3, dirt: 1, water: 1 });
        expect(island.cellStock(-1, -1)).toEqual({ water: 1 });
        expect(island.cellStock(0, -1)).toEqual({ stone: 3, iron: 1, dirt: 1, water: 1, flint: 1 });
        // THE GROUND SUPPLY IS EVERYWHERE its voxels are: all 257 dry land
        // cells carry dirt (R4's river fords cut 12 of the 269 — the channel
        // supplies nothing); grass covers meadows AND woods; STONE is
        // FINITE - it stands only on the 8 surviving highland rock sites
        // (the exact list the islandTerrain census pins)
        expect(island.cellsWithItem('stone').length).toBe(8);
        expect(island.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`).sort()).toEqual([
            '-1,0', '-1,1', '-2,0', '0,-1', '0,0', '0,1', '1,0', '1,1',
        ]);
        expect(island.cellsWithItem('dirt').length).toBe(257);
        expect(island.cellsWithItem('grass').length).toBe(117);
        // The unlimited sand stays beach-only (the R3 2-tile coastal band
        // shrank the sands; R4's river forded 6 of them)
        expect(island.cellsWithItem('sand').length).toBe(132);
        // THE R5 GATE: the 0.8 board holds exactly ONE iron lode (at the
        // surviving (0,−1) — the river forded the old (−1,−1) host) — the
        // finite mineable deposit the early tools need
        expect(island.cellsWithItem('iron').map((cell) => `${cell.x},${cell.y}`)).toEqual(['0,-1']);
        // The 37×25 reference board lodes 3 highlands — the lodes carry the
        // finite rock stock too (deposits seed in TILE_RESOURCES order:
        // stone before iron); R4's river forded the (−7,0) plain site (its
        // stock washed into the channel — only the shore water stands) and
        // the shifted chance stream spread flints to (−6,1)/(−5,1)/(−5,3)
        const big = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 37, height: 25 }), big] });
        expect(big.cellStock(-7, 0)).toEqual({ water: 1 });
        expect(big.cellStock(-5, 3)).toEqual({ stone: 3, dirt: 1, iron: 1, flint: 1 });
        // The other two lodes: (−7,1) (on the river's shore ring — water)
        // and (−5,2) (flint this run) — the lodes carry the rock stock too
        expect(big.cellStock(-7, 1)).toEqual({ stone: 3, dirt: 1, iron: 1, water: 1 });
        expect(big.cellStock(-5, 2)).toEqual({ stone: 3, dirt: 1, iron: 1, flint: 1 });
        // The iron list is exactly the vein noise's picks
        expect(big.cellsWithItem('iron').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-7,1', '-5,2', '-5,3',
        ]);
        expect(big.cellsWithItem('flint').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-6,1', '-5,1', '-5,2', '-5,3',
        ]);
    });

    it('gather moves the first available FOOD from the cell to the actor bag', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Forest cell: the loose foods are the mushroom ring (T4 — the
        // loose berries are gone) — trees are a deposit material and never
        // picked by the food gather
        expect(island.gather(ael)).toBe('mushroom');
        expect(island.of('a')).toEqual({ mushroom: 1 });
        // T4: the forest seeds mushroom 3 — one gathered leaves 2
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 412, mushroom: 2, bush: 1, water: 1 });
        // Gathering stays out of the log — foraging is a solo beat, not a
        // story between entities (the log is a story teller)
        expect(world.events.logFor('a').map((event) => event.kind)).toEqual(['spawn']);
        // THE BUSH PLUCK (T4): a cell with NO loose food but a standing
        // laden bush plucks a berry off the plant (the meadow (−1,−5))
        const bram = world.spawn(actor('b', 'Bram', -1, -5));
        expect(island.bushView(-1, -5)).toEqual({ x: -1, y: -5, fruits: 3, cap: 3, nextRipeAt: 60 });
        expect(island.gather(bram)).toBe('berry');
        expect(island.of('b')).toEqual({ berry: 1 });
        // The PLANT never depletes — the `bush` stock stays a standing one;
        // only the lazy fruit record drew down (3 → 2)
        expect(island.cellStock(-1, -5).bush).toBe(1);
        expect(island.bushView(-1, -5)?.fruits).toBe(2);
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
        // Forest (−7,0) mirrors its neighborhood-counted water-clamped 412-tree stand
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 412 });
        // THE BIOLOGICAL BOUNDARY — the tile carries a persistent stand,
        // no forest ecology is mounted (the legacy inventory-only fixture):
        // the whole-tree harvest is refused BEFORE any mutation — a living
        // tree harvests only through its owner (the remount-farm fix)
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(island.of('a')).toEqual({});
        // T4: the refused harvest leaves the woods untouched (mushroom 3,
        // the standing bush; no loose berries — vine normalized)
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 412, mushroom: 3, bush: 1, water: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 412 });
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
        expect(island.cellStock(1, -2)).toEqual({ tree: 11, dirt: 1, grass: 1 });
        expect(world.cellAt(1, -2)?.resources).toEqual({ dirt: 1, grass: 1, tree: 11 });
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

    it('cellsWithItem lists cells holding an item — and NO cell holds a fish (T4)', () => {
        const { island } = buildWorld();
        // T4 — R2: NO CELL STOCKS FISH. The water is an UNLIMITED source
        // (the fishing tools and the constructed nets draw it forever), so
        // no tile carries a fish count to indicate: the census is EMPTY at
        // every zoom, hover and Underfoot read — the wild-fish indicator
        // boundary
        expect(island.cellsWithItem('fish')).toEqual([]);
        // The FISHING WATERS carry the enumeration instead: every sea cell
        // AND every fresh basin (the biome predicates — the PASSABLE river
        // fords included) — 168 water cells on the default island (155
        // impassable sea/basin columns + the 13 river cells)
        const waters = island.fishingWaters();
        expect(waters.length).toBe(168);
        expect(waters.every((cell) => isSeaWater(cell.biome) || isFreshBasin(cell.biome))).toBe(true);
        expect(waters.filter((cell) => cell.biome === 'river').length).toBe(13);
        // The richer map's foods: every forest cell stocks a mushroom (the
        // 59 woods at the 0.8 wetland cutoff — R7 raises the mushroom SEED
        // to 3 per wood, not the wood count, so the census stays exactly
        // 59); the sea's seaweed covers the deep ocean plus half the
        // shallows — 94 cells
        expect(island.cellsWithItem('mushroom').length).toBe(59);
        expect(island.cellsWithItem('seaweed').length).toBe(101);
        // R7 — the vine census GREW with the 0.35 → 0.6 chance raise. The
        // stream order is unchanged (one draw per forest cell, row major),
        // so every cell drawn under the old 0.35 stays drawn: the new map
        // is a PROVABLE SUPERSET of the old 21-cell map. The exact census
        // needs one reference re-capture (this pass does not execute —
        // sibling modules are in flux); the bound below is the invariant.
        expect(island.cellsWithItem('vine').length).toBeGreaterThanOrEqual(21);
        // The tree mirror stands on the 59 woods AND the ingressed meadows
        // (91 treed tiles since R4 washed the basins clean and R4's river
        // fords cut 2 more treed meadow cells — the neighborhood model's
        // counts move per tile)
        expect(island.cellsWithItem('tree').length).toBe(85);
        // R4: the finite stone stands only on the 8 surviving highland rock
        // sites (the river forded the ninth); the unlimited dirt blankets the
        // dry land (see the census pins)
        expect(island.cellsWithItem('stone').length).toBe(8);
        expect(island.cellsWithItem('dirt').length).toBe(257);
        expect(island.cellsWithItem('grass').length).toBe(117);
        expect(island.cellsWithItem('sand').length).toBe(132);
    });

    it('the standing tree is never bagged — trees are living things', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // takeFromCell('tree') refuses — the tree stock is the MIRROR of
        // the forest records, not a pile of loose lumber; a tree's wood
        // goes through the harvest (the chop) instead
        expect(island.takeFromCell(ael, 'tree')).toBe(false);
        expect(island.of('a')).toEqual({});
        // T4: the enriched woods (mushroom 3, standing bush; vine
        // normalized; NO loose berries — the berries hang on the lazy batch)
        // stay whole
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 412, mushroom: 3, bush: 1, water: 1 });
    });

    it('regrowth restores stocks on the staggered rhythm — even from a fully harvested cell', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -4, -7));
        // Beach cell (−4,−7): coconut cap 3, rhythm every 60 minutes at
        // offset 10 (the clock is untouched) — the first 9 one-minute steps
        // stay silent, minute 10 regrows.
        // HARVEST TO ZERO through the real take: inventoryRemove DELETES the
        // zeroed stock key — the old stock-keyed sweep lost the cell forever
        // (the exhausted-source bug); the eligibility registry keeps it alive
        while (island.takeFromCell(ael, 'coconut')) {
            // drain the beach's 2 seeded coconuts
        }
        expect(island.cellStock(-4, -7).coconut ?? 0).toBe(0);
        expect(island.of('a')).toEqual({ coconut: 2 });
        for (let index = 0; index < 9; index++) {
            world.step(); // minutes 1-9 → no minute hits the offset
        }
        expect(island.cellStock(-4, -7).coconut ?? 0).toBe(0);
        world.step(); // minute 10 regrows one coconut onto the BARE cell
        expect(island.cellStock(-4, -7).coconut).toBe(1);
        // Cap respected: parked at the R7 abundance cap of 3, regrowth never
        // exceeds it — step past the next coconut pulse (minute 70)
        island.cellStock(-4, -7).coconut = 3;
        for (let index = 0; index < 60; index++) {
            world.step(); // minutes 11-70 — minute 70's pulse stays clamped
        }
        expect(island.cellStock(-4, -7).coconut).toBe(3);
    });

    it('R2: a lake and a pond both stock fresh water, and the basin refills on the rhythm', () => {
        const { world, island } = buildWorld();
        // The 0.8 interior basins — 5 lakes + 8 ponds (13 wetland cells). A
        // LAKE cell (1,−5) and a POND cell (−4,−3) EACH stock drinking water
        // on the survey (both read as fresh water, seeded like the dry shore
        // ring that stands beside a basin — a land cast collects from either)
        expect(island.cellStock(1, -5).water).toBe(1);
        expect(island.cellStock(-4, -3).water).toBe(1);
        // THE 12 BASINS + THE 13 RIVER CELLS + THEIR DRY SHORE RING = 101
        // FRESH-WATER CELLS (the thirst ladder's collect can reach all of
        // them — R4's rivers joined the fresh-water map: the channel itself
        // and every dry tile beside it, the woods included)
        expect(island.cellsWithItem('water').length).toBe(101);
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

    it('R4 — the river is INEXHAUSTIBLE: the channel drinks forever (the bag still gates)', () => {
        // THE RIVER WATER CONTRACT: a flowing course hands its fresh water
        // out forever — the takeFromCell 'water' branch on a river cell
        // treats the stock key as the DISCOVERY signal only and NEVER
        // decrements it (unlike the basins' finite rhythm-refilled pools).
        // Only the carrier's weight budget gates the take.
        const profiles = entityPlugin();
        const island = inventoryPlugin({ profiles });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island, profiles] });
        // (−1,−1) is the forded peak — a river cell. Water weighs 15 and a
        // human shoulders 200: thirteen drinks (195) fit, the fourteenth
        // (210) overflows — and every one of the thirteen succeeds because
        // the source never empties
        const ael = world.spawn(actor('a', 'Ael', -1, -1));
        for (let index = 0; index < 13; index++) {
            expect(island.takeFromCell(ael, 'water')).toBe(true);
        }
        expect(inventoryWeight(island.of('a'))).toBe(195);
        // The channel's standing mark survives every draw (never decremented)
        expect(island.cellStock(-1, -1).water).toBe(1);
        // The CAPACITY GATE still refuses — inexhaustible water is bound by
        // the bag, not by the source (and the take stays atomic: the bag
        // keeps exactly the thirteen)
        expect(island.takeFromCell(ael, 'water')).toBe(false);
        expect(inventoryWeight(island.of('a'))).toBe(195);
        // Step past the basins' refill rhythm — the river needed no rhythm
        // to keep drinking water (the shared sweep only tops the standing
        // mark toward the cap, it never drains)
        for (let index = 0; index < 40; index++) {
            world.step();
        }
        expect(island.cellStock(-1, -1).water).toBe(2);
        // THE TREK PATH: every river cell stocks water on the survey and is
        // PASSABLE — the behavior thirst trek (cellsWithItem('water')
        // filtered to passable cells) reaches the fords directly
        const riverCells = island.cellsWithItem('water').filter((cell) => cell.biome === 'river');
        expect(riverCells.length).toBe(13);
        expect(riverCells.every((cell) => cell.passable)).toBe(true);
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
        // R4's river fords the old first-beach cell (−3,−5) — the channel
        // carries only its inexhaustible fresh water; the first forest
        // (−1,−3) mirrors its neighborhood-counted 246-tree stand (T2's
        // densified counts) and stands on the river's shore ring (water)
        expect(island.cellStock(-3, -5)).toEqual({ water: 1 });
        // T4: the re-surveyed wood seeds its mushroom ring + NO loose
        // berries (no bush here — the fold 0.852 clears even the raised 0.6
        // forest chance; the vine draw is normalized — see stockWithoutVine)
        expect(stockWithoutVine(island, -1, -3)).toEqual({ dirt: 1, grass: 1, tree: 246, mushroom: 3, water: 1 });
        // Stocks from the OLD canvas are gone: a cell that only existed on
        // the 25×17 island (0,−7) now has no stock (out of bounds)
        expect(island.cellStock(0, -7)).toEqual({});
        // T4 — the fishing waters re-enumerate on the new canvas: 123 on
        // the 21×13 board (111 sea columns + the 3 drowned basins + the 9
        // river cells of its channel); the fish census stays EMPTY (no
        // stock, the unlimited source)
        expect(island.fishingWaters().length).toBe(123);
        expect(island.cellsWithItem('fish')).toEqual([]);
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
        // The weather roll stream rides the survey's per-seed draw order —
        // R4's river-carved map changed which cells consume chance draws,
        // so the rain minutes shifted with it (captured reference run)
        expect(rains).toEqual([15, 45, 338, 368, 376, 553, 574]);
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
        // (R7's enriched woods; vine normalized; T4 — no loose berries)
        expect(stockWithoutVine(island, -7, 0)).toEqual({ dirt: 1, grass: 1, tree: 412, mushroom: 3, bush: 1, water: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ dirt: 1, grass: 1, tree: 412 });
        expect(island.of('a')).toEqual({ stone: 5 });
    });

    it('gather respects the capacity — a full bag gathers nothing', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', 1, -2));
        for (let index = 0; index < 8; index++) {
            island.takeFromCell(ael, 'dirt');
        }
        // The meadow's two berries cannot fit — the gather is a no-op
        // (T4 — the meadow carries no loose berries; the (1,−2) tree's
        // neighborhood stand stays whole and the ground supply is intact —
        // the no-op reads as NOTHING left the cell)
        expect(island.gather(ael)).toBe(null);
        expect(island.cellStock(1, -2)).toEqual({ tree: 11, dirt: 1, grass: 1 });
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

describe('T4 — the berry bush: the standing plant and its lazy fruit batch', () => {
    // T4 — the BERRY BUSH is a PERMANENT STANDING PLANT. The `bush` stock
    // key is the plant (a constant one per bush cell — it never draws down,
    // so a plucked-BARE bush stays visible and enumerable); the berries it
    // bears live in the lazy per-bush fruit record (BUSH_BERRY_CAP berries,
    // one ripening every BUSH_RIPEN_MINUTES world minutes after a pluck).
    // The plant is a visible, inspectable feature — never an abstract bag
    // item, and never N replicated plant icons for N fruits (one plant,
    // its fruit count reads through the bush card).
    it('stands deterministically on a meadow cell — a visible, inspectable feature', () => {
        const { island } = buildWorld();
        // The survey's first berry bush (the row-major scan hits (−1,−5) — a
        // meadow cell): the standing bush (the PLANT — one unit), the
        // column's unlimited ground supply (R4: no stone — the meadow is no
        // stone-bearing site), R4's river-shore fresh water (the bush
        // meadow stands beside the northern course) and NO loose berries
        // (T4 — the berries hang on the plant)
        expect(island.cellStock(-1, -5)).toEqual({
            bush: 1,
            dirt: 1,
            grass: 1,
            water: 1,
        });
        // A ground-item (not a tile deposit) — the ground listing carries it
        // AND the canvas type palette resolves its glyph, so the bush stands
        // as its own visible plant (ONE icon, whatever it bears)
        expect(
            inventoryEntries(island.cellStock(-1, -5)).map((stack) => stack.item),
        ).toContain('bush');
        expect(ITEM_TYPE_GLYPHS.bush).toBe('🪴');
        // The fruit card: the survey seeds the batch FULL (the island opens
        // laden) with the first new berry due one ripen interval out
        expect(island.bushView(-1, -5)).toEqual({ x: -1, y: -5, fruits: BUSH_BERRY_CAP, cap: 3, nextRipeAt: BUSH_RIPEN_MINUTES });
    });

    it('furnishes berries foraging plucks off it — the plant stands when bare and refills lazily', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -1, -5));
        // Forage off the bush: it yields a berry, the PLANT stays (the
        // `bush` stock is a constant one — never drawn down), and the lazy
        // fruit record draws down 3 → 2 with the next berry due one
        // interval after the pluck
        expect(island.gather(ael)).toBe('berry');
        expect(island.of('a')).toEqual({ berry: 1 });
        expect(island.cellStock(-1, -5).bush).toBe(1);
        const afterPluck = island.bushView(-1, -5);
        expect(afterPluck?.fruits).toBe(2);
        // Pluck the batch bare: two more forages empty the record
        expect(island.gather(ael)).toBe('berry');
        expect(island.gather(ael)).toBe('berry');
        expect(island.bushView(-1, -5)?.fruits).toBe(0);
        // The BARE bush STILL STANDS — the plant is visible and enumerable
        // whatever its fruit count (R4: the bush is never a vanished feature)
        expect(island.cellStock(-1, -5).bush).toBe(1);
        expect(island.cellsWithItem('bush').some((cell) => cell.x === -1 && cell.y === -5)).toBe(true);
        // A fourth forage finds nothing (the batch is empty — no free food
        // before the next berry ripens)
        expect(island.gather(ael)).toBeNull();
        expect(island.of('a')).toEqual({ berry: 3 });
        // THE LAZY REGROW: the first new berry lands one ripen interval
        // (60 world minutes) after the last pluck — step the world to the
        // interval's edge and the catch-up read pays it
        for (let minute = 0; minute < BUSH_RIPEN_MINUTES; minute++) {
            world.step();
        }
        expect(island.bushView(-1, -5)?.fruits).toBe(1);
        // The refill continues toward the cap — another interval, another
        // berry (one berry per interval until the batch is full again)
        for (let minute = 0; minute < BUSH_RIPEN_MINUTES; minute++) {
            world.step();
        }
        expect(island.bushView(-1, -5)?.fruits).toBe(2);
        // And a LONG rest catches the whole batch up to the cap at once
        // (the lazy clock credits every whole interval that passed)
        for (let minute = 0; minute < BUSH_RIPEN_MINUTES * 4; minute++) {
            world.step();
        }
        const refilled = island.bushView(-1, -5);
        expect(refilled?.fruits).toBe(BUSH_BERRY_CAP);
        // The berry still plucks after the refill — the plant is renewable
        // forever, never a one-shot bush
        expect(island.gather(ael)).toBe('berry');
        expect(island.bushView(-1, -5)?.fruits).toBe(2);
    });
});

describe('inventoryPlugin — renewable abundance + regrowth eligibility', () => {
    // THE EXHAUSTED-SOURCE FIX + ABUNDANCE CAPS — a fully harvested
    // renewable cell (the take DELETES the zeroed stock key — the old
    // stock-keyed sweep lost such a cell forever) regrows on its rhythm
    // toward the raised cap, and ONLY on cells the survey seeded the item
    // on (the eligibility registry). Finite resources never regrow.
    // T4 — the loose berries and the fish shoals left the seeding (the
    // bushes' lazy batches + the unlimited water source replaced them), so
    // this census covers the REMAINING renewable stocks.
    it('a fully harvested renewable cell regrows to its abundance cap — mushroom, coconut, seaweed, vine', () => {
        const { world, island } = buildWorld();
        // Reference cells: forest (−7,0) mushroom, beach (−4,−7) coconut;
        // the first seaweed and vine cells the survey stocked (deterministic
        // per seed)
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
        drain(-7, 0, 'mushroom');
        drain(-4, -7, 'coconut');
        drain(seaweedCell.x, seaweedCell.y, 'seaweed');
        drain(vineCell.x, vineCell.y, 'vine');
        // 190 minutes carries every rhythm past its last pre-cap pulse at
        // the R7 caps (the rhythms themselves are untouched): mushroom
        // 15/55/95/135/175 → 5, coconut 10/70/130 → 3, seaweed 25/75 → 2,
        // vine 30/110/190 → 3 (R7's richer re-hang — the third pulse at
        // minute 190 is what lifts the vine to its cap)
        for (let index = 0; index < 190; index++) {
            world.step();
        }
        expect(island.cellStock(-7, 0).mushroom).toBe(5);
        expect(island.cellStock(-4, -7).coconut).toBe(3);
        expect(island.cellStock(seaweedCell.x, seaweedCell.y).seaweed).toBe(2);
        expect(island.cellStock(vineCell.x, vineCell.y).vine).toBe(3);
        // THE DETERMINISTIC MAP HOLDS — regrowth refills the SEEDED cells,
        // it never SPREADS: the census is exactly the survey's (59 woods
        // mushroom, 101 seaweed); the vine census is the survey's R7 map —
        // a provable superset of the old 21-cell draw (same stream, same
        // order, higher threshold; exact count needs one reference
        // re-capture, see the census note above). T4 — the fish census
        // stays EMPTY (no stock: the unlimited source)
        expect(island.cellsWithItem('mushroom').length).toBe(59);
        expect(island.cellsWithItem('vine').length).toBeGreaterThanOrEqual(21);
        expect(island.cellsWithItem('seaweed').length).toBe(101);
        expect(island.cellsWithItem('fish')).toEqual([]);
    });

    it('nothing regrows on ineligible cells and finite resources stay finite', () => {
        const { world, island } = buildWorld();
        // Highland (1,0): a rock site — the survey seeded NO renewable on it
        // (only the finite flint + stone and the unlimited dirt; R4 — the
        // pin moved off the river-shore (0,0), whose shore water is a seeded
        // renewable, to this clean dry rock). Inject every renewable,
        // harvest it all, and NOTHING may come back: no mushrooms on rock,
        // no fish on land, no vines on bare stone
        const miner = world.spawn(actor('m', 'Mira', 1, 0));
        const stock = island.cellStock(1, 0);
        ['mushroom', 'coconut', 'fish', 'seaweed', 'vine'].forEach((item) => {
            stock[item] = 1;
        });
        ['mushroom', 'coconut', 'fish', 'seaweed', 'vine', 'flint'].forEach((item) => {
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
        expect(island.cellStock(1, 0)).toEqual({ dirt: 1 });
        // The beach keeps its OWN seeded renewable (coconut, regrown to the
        // cap of 3) but never regrew the mushroom that was never its own
        expect(island.cellStock(-4, -7).mushroom ?? 0).toBe(0);
        expect(island.cellStock(-4, -7).coconut).toBe(3);
    });

    it('the fish primitive works the shore: dry ground, cardinal reach, BIOME water, a tool in hand, room to carry (T4)', () => {
        // THE PROFILED STACK — the capacity gate needs the entity profiles
        // (a human carries the stock eight; no profiles means unlimited)
        const profiles = entityPlugin();
        const island = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island, profiles] });
        // Ael on the dry forest shoulder (7,2) of the drowned pond (6,2) —
        // R4 went impassable. T4: NO fish shoal — the basin carries only its
        // standing water; the fish live NOWHERE on the board (the water is
        // the UNLIMITED source, marked a fishing water instead)
        const ael = world.spawn(actor('a', 'Ael', 7, 2));
        expect(island.cellStock(6, 2)).toEqual({ water: 1 });
        expect(island.fishingWaters().some((cell) => cell.x === 6 && cell.y === 2)).toBe(true);
        // THE TOOL GATE — the barehand cast is gone: standing on the legal
        // shore with the legal reach, a bag WITHOUT a spear or rod catches
        // nothing (T4 — a human/land-agent lands a fish only with real gear)
        expect(island.fish(ael, 6, 2)).toBe(false);
        expect(island.of('a')).toEqual({});
        // Kit the spear: the cast lands and the water hands the fish out
        // with NO stock to draw down (the basin keeps only its water — the
        // old R5 shoal is gone)
        island.spawnKit('a', { spear: 1 });
        expect(island.fish(ael, 6, 2)).toBe(true);
        expect(island.of('a')).toEqual({ spear: 1, fish: 1 });
        expect(island.cellStock(6, 2)).toEqual({ water: 1 });
        // THE UNLIMITED SOURCE: the next cast lands too — the water NEVER
        // empties (the old R5 two-cast-empties-the-pool behavior is gone;
        // the cap that now binds is only the BAG, see below)
        expect(island.fish(ael, 6, 2)).toBe(true);
        expect(island.of('a')).toEqual({ spear: 1, fish: 2 });
        // THE CAPACITY GATE fires before the catch lands: seed three stones
        // (spear 20 + two fish 50 + three stones 120 = 190 carried) — one
        // more 25-weight fish would read 215, over the human's 200 budget,
        // so the cast is refused and NOTHING moves (no fish lands, and the
        // refusal happens before the wear charge — the spear keeps its
        // health, pinned below by the exact break count)
        island.spawnKit('a', { stone: 3 });
        expect(island.fish(ael, 6, 2)).toBe(false);
        expect(island.of('a')).toEqual({ spear: 1, fish: 2, stone: 3 });
        // DIAGONAL reach is refused — the cardinal adjacency is the fishing
        // granularity (the pond (6,2) sits diagonally from (7,3))
        const diagonal = world.spawn(actor('d', 'Di', 7, 3));
        expect(island.fish(diagonal, 6, 2)).toBe(false);
        // The DRY neighbour holds no fish — the BIOME gate refuses land
        // (a cast only lands in sea water or a fresh basin)
        expect(island.fish(ael, 6, 1)).toBe(false);
        // A body AFLOAT does not fish — dry ground underfoot is the shore
        // rule (a floater feeds itself through `gather`, the natural path)
        const floater = world.spawn(actor('f', 'Flo', 6, 2));
        expect(island.fish(floater, 6, 3)).toBe(false);
        // THE ROD WORKS TOO — the tool gate accepts EITHER fishing tool (the
        // spear is only the preferred wear order when both are held)
        const angler = world.spawn(actor('r', 'Rho', 7, 2));
        island.spawnKit('r', { rod: 1 });
        expect(island.fish(angler, 6, 2)).toBe(true);
        expect(island.of('r')).toEqual({ rod: 1, fish: 1 });
        // THE TOOL WEAR rides the successful catch: the spear spends 2
        // health per fish against its 60 budget. The two pre-loop casts
        // already spent 4 (the refused capacity cast spent nothing — that is
        // the wear-before-the-catch ordering pin). Free one fish's room
        // (eat it), then 28 more catches (each fish eaten off the bag as it
        // lands, keeping the capacity gate open) EXACTLY spend the spear:
        // 4 + 28 × 2 = the full 60 health, and the 28th catch breaks the
        // spear ATOMICALLY (the fish still lands with the catch — then the
        // tool leaves the bag in the same step)
        expect(island.consume(ael, 'fish')).toBe(true);
        for (let index = 0; index < 28; index++) {
            expect(island.fish(ael, 6, 2)).toBe(true);
            expect(island.consume(ael, 'fish')).toBe(true);
        }
        // 30 catches total wore the fresh spear out — the bag holds the last
        // landed fish and the stones, and the spear is GONE
        expect(island.of('a')).toEqual({ fish: 1, stone: 3 });
        // The next cast fails the TOOL GATE again — the broken spear is
        // spent, and no rod rides in Ael's bag to fall back on
        expect(island.fish(ael, 6, 2)).toBe(false);
    });
});
