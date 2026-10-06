// Tests for the inventory environment plugin (plugins/inventory/inventoryPlugin.ts).
// Uses the default seed-7 island (25×17, centered coordinates) as fixture;
// the exact stock layouts below were captured from a reference run and must
// never drift.
//
// Tile DEPOSITS (TerrainCell.resources) seed the gatherable stocks: forests
// carry tree ×2 (tree ×6 on a DENSE grove — the terrain generator's dense
// moisture band), highlands stone ×1 (+ iron ×1 on vein lodes), and the
// UNLIMITED deposits — sand ×1 on beaches, dirt ×1 on meadows — never
// deplete when gathered. Cell stocks list deposits first, then the biome's
// living stocks (meadow berries, forest berries + mushrooms, beach
// coconuts), then the chance draws (forest vines, shallows seaweed, beach
// shells, highland flints). Wood is NOT a deposit — it is the
// product of harvesting (felling) a tree, tree → wood.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { entityPlugin } from '../entity/entityPlugin';
import type { Actor } from '../../engine/types';
import { inventoryPlugin } from './inventoryPlugin';
import { inventoryTotal } from './inventory';

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
//   (1,−4)    meadow  stock {dirt:1, berry:2}            (dirt unlimited)
//   (−7,0)    forest  stock {tree:2, berry:1, mushroom:1} (mushroom = the woods' snack)
//   (−4,−7)   beach   stock {sand:1, coconut:1}          (sand unlimited, shell draw missed)
//   (−5,−7)   beach   stock {sand:1, coconut:1}          (shell draw missed)
//   (−12,−8)  shallows stock {fish:1}                    (seaweed draw missed)
//   (0,0)     highland stock {stone:1, flint:1}          (30% flint draw hit)
//   (−1,−1)   highland stock {stone:1, flint:1}          (flint draw hit too)
//   (0,−1)    highland stock {stone:1}                   (flint draw missed)
// The default island keeps every vein sample under IRON_LODE_THRESHOLD —
// no iron lodes on 25×17; the lode test below pins the 37×25 reference
// board (the pre-shrink default) where 3 of the 9 highlands lode.
const buildWorld = () => {
    const island = inventoryPlugin({ rainChancePerMinute: 0 });
    const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
    return { world, island };
};

describe('inventoryPlugin', () => {
    it('seeds resources from tile deposits and biome living stocks on setup', () => {
        const { island } = buildWorld();
        // Meadow (1,−4) → unlimited dirt + 2 berries
        expect(island.cellStock(1, -4)).toEqual({ dirt: 1, berry: 2 });
        // Forest (−7,0) → 2 trees (the standing deposit) + 1 berry + the
        // woods' mushroom (the forest biome's second living stock)
        expect(island.cellStock(-7, 0)).toEqual({ tree: 2, berry: 1, mushroom: 1 });
        // Beach (−4,−7) → unlimited sand, coconut 1 (the shell draw missed)
        expect(island.cellStock(-4, -7)).toEqual({ sand: 1, coconut: 1 });
        // Sea (−12,−8) → fish (the shallows seaweed draw missed; no tile
        // deposits under water)
        expect(island.cellStock(-12, -8)).toEqual({ fish: 1 });
    });

    it('seeds stone, iron lodes (and sometimes flint) on highlands', () => {
        const island = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin(), island] });
        // Reference highlands on the default island: (0,0) and (−1,−1) hid
        // a flint each (30% draw hit); (0,−1) missed
        expect(island.cellStock(0, 0)).toEqual({ stone: 1, flint: 1 });
        expect(island.cellStock(-1, -1)).toEqual({ stone: 1, flint: 1 });
        expect(island.cellStock(0, -1)).toEqual({ stone: 1 });
        // Full reference list — every highland carries stone (the 9 cells
        // around the canvas center); the default island holds NO iron
        // lodes: all 9 vein samples sit under IRON_LODE_THRESHOLD
        expect(island.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-1,-1', '0,-1', '-2,0', '-1,0', '0,0', '1,0', '-1,1', '0,1', '1,1',
        ]);
        expect(island.cellsWithItem('iron')).toEqual([]);
        // The 37×25 reference board lodes 3 highlands — the lodes carry
        // stone too (deposits seed in TILE_RESOURCES order: stone before
        // iron); (−5,2) hid a flint this run (30% draw hit)
        const big = inventoryPlugin();
        createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 37, height: 25 }), big] });
        expect(big.cellStock(-7, 0)).toEqual({ stone: 1 });
        expect(big.cellStock(-5, 3)).toEqual({ stone: 1, iron: 1 });
        // The other two lodes: (−7,1) and (−5,2) — the lodes carry stone too
        expect(big.cellStock(-7, 1)).toEqual({ stone: 1, iron: 1 });
        expect(big.cellStock(-5, 2)).toEqual({ stone: 1, iron: 1, flint: 1 });
        // The iron list is exactly the vein noise's picks
        expect(big.cellsWithItem('stone').map((cell) => `${cell.x},${cell.y}`)).toEqual([
            '-7,0', '-6,0', '-7,1', '-6,1', '-5,1', '-6,2', '-5,2', '-6,3', '-5,3',
        ]);
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
        expect(island.cellStock(-7, 0)).toEqual({ tree: 2, mushroom: 1 });
        // Gathering stays out of the log — foraging is a solo beat, not a
        // story between entities (the log is a story teller)
        expect(world.events.logFor('a').map((event) => event.kind)).toEqual(['spawn']);
    });

    it('gather returns null when only materials remain, without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // The forest cell's foods are 1 berry + 1 mushroom — after they are
        // gone, trees stay
        expect(island.gather(ael)).toBe('berry');
        expect(island.gather(ael)).toBe('mushroom');
        expect(island.gather(ael)).toBe(null);
        // No tree entered the bag and no tree left the tile: materials are
        // NOT gathered by the hunger loop (agents must walk to real food
        // instead of farming a tile's dirt/sand/stone forever)
        expect(island.of('a')).toEqual({ berry: 1, mushroom: 1 });
        expect(island.cellStock(-7, 0)).toEqual({ tree: 2 });
        // Materials are fetched explicitly — trees by the harvest (the
        // felling converts the deposit into its product, tree → wood)
        expect(island.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(island.of('a')).toEqual({ berry: 1, mushroom: 1, wood: 1 });
        expect(island.cellStock(-7, 0)).toEqual({ tree: 1 });
    });

    it('harvest converts one tree deposit into one wood item, atomically', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Forest (−7,0) starts with tree ×2 standing on it
        expect(world.cellAt(-7, 0)?.resources).toEqual({ tree: 2 });
        // Felling one tree: the stock AND the tile deposit drop together,
        // the wood lands in the bag — wood never stood on the tile
        expect(island.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(island.cellStock(-7, 0)).toEqual({ tree: 1, berry: 1, mushroom: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ tree: 1 });
        expect(island.of('a')).toEqual({ wood: 1 });
        // Felling the last tree empties the deposit — the tile re-skins to
        // its plain biome through tileSurfaceKey (scenario surfaceOf)
        expect(island.harvest(ael, 'tree', 'wood')).toBe(true);
        expect(island.cellStock(-7, 0)).toEqual({ berry: 1, mushroom: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({});
        expect(island.of('a')).toEqual({ wood: 2 });
        // Nothing left to fell
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        expect(island.of('a')).toEqual({ wood: 2 });
        // Unlimited deposits are raw ground — they are never converted
        const bram = world.spawn(actor('b', 'Bram', -4, -7));
        expect(island.harvest(bram, 'sand', 'glass')).toBe(false);
        expect(island.of('b')).toEqual({});
    });

    it('taking an iron lode draws the ore before the stone around it', () => {
        // The 37×25 reference board — the default island holds no lodes
        const island = inventoryPlugin({ rainChancePerMinute: 0 });
        const world = createWorld({ seed: 7, plugins: [islandTerrainPlugin({ width: 37, height: 25 }), island] });
        const ael = world.spawn(actor('a', 'Ael', -5, 3));
        // Lode (−5,3): stone ×1 + iron ×1 (+ a flint) — the cell also hides
        // a flint, which has no deposit
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1, iron: 1 });
        expect(island.takeFromCell(ael, 'iron')).toBe(true);
        expect(island.of('a')).toEqual({ iron: 1 });
        // The ore is gone, the tile still shows its stone deposit
        expect(world.cellAt(-5, 3)?.resources).toEqual({ stone: 1 });
        expect(island.takeFromCell(ael, 'stone')).toBe(true);
        expect(world.cellAt(-5, 3)?.resources).toEqual({});
        // The mined-out highland falls back to its plain biome surface
        expect(world.cellAt(-5, 3)?.biome).toBe('highland');
    });

    it('unlimited deposits (sand, dirt) never deplete', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -4, -7));
        // Scooping sand: the bag grows with every take…
        for (let index = 0; index < 5; index++) {
            expect(island.takeFromCell(ael, 'sand')).toBe(true);
        }
        expect(island.of('a')).toEqual({ sand: 5 });
        // …but the pile and the deposit stay intact forever
        expect(island.cellStock(-4, -7)).toEqual({ sand: 1, coconut: 1 });
        expect(world.cellAt(-4, -7)?.resources).toEqual({ sand: 1 });
        // Dirt works the same on meadows
        const bram = world.spawn(actor('b', 'Bram', 1, -4));
        expect(island.takeFromCell(bram, 'dirt')).toBe(true);
        expect(island.of('b')).toEqual({ dirt: 1 });
        expect(island.cellStock(1, -4)).toEqual({ dirt: 1, berry: 2 });
        expect(world.cellAt(1, -4)?.resources).toEqual({ dirt: 1 });
    });

    it('taking from an empty stock fails without side effects', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 1, -4));
        // No water on the cell yet
        expect(island.takeFromCell(ael, 'water')).toBe(false);
        expect(island.of('a')).toEqual({});
        // Inject rain water manually (rain chance is disabled in the fixture)
        island.cellStock(1, -4).water = 1;
        expect(island.takeFromCell(ael, 'water')).toBe(true);
        expect(island.of('a')).toEqual({ water: 1 });
        expect(island.cellStock(1, -4).water).toBeUndefined();
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
        // The richer map's foods: every forest cell stocks a mushroom, and
        // 29 of the woods hang a vine (the 35% draw); the sea's seaweed
        // covers the deep ocean plus half the shallows — 95 cells
        expect(island.cellsWithItem('mushroom').length).toBe(75);
        expect(island.cellsWithItem('vine').length).toBe(29);
        expect(island.cellsWithItem('seaweed').length).toBe(95);
        // The unlimited deposits blanket their biomes: 160 beaches carry
        // sand, 38 meadows carry dirt
        expect(island.cellsWithItem('sand').length).toBe(160);
        expect(island.cellsWithItem('dirt').length).toBe(38);
    });

    it('regrowth restores stocks on the staggered rhythm', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', 1, -4));
        void ael;
        // Meadow cell (1,−4): cap 3, rhythm every 30 minutes at offset 20 —
        // the first 19 one-minute steps stay silent, minute 20 regrows
        island.cellStock(1, -4).berry = 0;
        for (let index = 0; index < 19; index++) {
            world.step(); // minutes 1-19 → no minute hits the offset
        }
        expect(island.cellStock(1, -4).berry ?? 0).toBe(0);
        world.step(); // minute 20 regrows one berry
        expect(island.cellStock(1, -4).berry).toBe(1);
        // Cap respected: parked at cap, regrowth does not exceed 3
        island.cellStock(1, -4).berry = 3;
        world.step();
        world.step();
        expect(island.cellStock(1, -4).berry).toBe(3);
    });

    it('tree regrowth grows the tile deposit back with the stock', () => {
        const { world, island } = buildWorld();
        const ael = world.spawn(actor('a', 'Ael', -7, 0));
        // Fell ONE tree off the forest (−7,0): the pile keeps its
        // last tree (the key a regrowth sweep needs — a fully deleted pile
        // never regrows, matching the stock behavior)
        island.harvest(ael, 'tree', 'wood');
        expect(island.cellStock(-7, 0)).toEqual({ tree: 1, berry: 1, mushroom: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ tree: 1 });
        // Tree rhythm: every 60 minutes at offset 40 — the first 39
        // one-minute steps pass silently…
        for (let index = 0; index < 39; index++) {
            world.step();
        }
        expect(island.cellStock(-7, 0).tree).toBe(1);
        // …minute 40 regrows one tree into the stock AND the tile deposit
        world.step();
        expect(island.cellStock(-7, 0).tree).toBe(2);
        expect(world.cellAt(-7, 0)?.resources).toEqual({ tree: 2 });
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
        // Shrink the island and re-survey the new canvas
        plugin.resize(21, 13);
        island.resurvey();
        // Reference cells on the 21×13 island (row-major survey order):
        // first beach (−3,−5) hit the shell draw this run, first forest
        // (−2,−4) is a DENSE grove — tree ×6 + the woods' mushroom
        expect(island.cellStock(-3, -5)).toEqual({ sand: 1, coconut: 1, shell: 1 });
        expect(island.cellStock(-2, -4)).toEqual({ tree: 6, berry: 1, mushroom: 1 });
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
        // minutes 293, 323, 331, 508, 529 — the roll stream is untouched by
        // the pool sweep (each cell's pool roll comes from its own keyed
        // stream)
        expect(rains).toEqual([293, 323, 331, 508, 529]);
        // Beach (−5,−7): coconut regrew to cap 2; TWO rains pooled water
        // here (the patchwork — pools gather on a scattered subset of the
        // land, not under every foot; the pile clamps at the cap of 2);
        // the unlimited sand pile never moved
        expect(island.cellStock(-5, -7)).toEqual({ sand: 1, coconut: 2, water: 2 });
        // The patchwork census: five rains × 25% pool chance per cell —
        // 217 of the 282 land cells ever pooled (a fresh rain still only
        // wets a quarter of the island; the cast must travel to a pool and
        // COLLECT before anything drinks)
        expect(island.cellsWithItem('water').length).toBe(217);
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
        // The forest stands (tree ×2) — but the bag cannot hold the wood
        expect(island.harvest(ael, 'tree', 'wood')).toBe(false);
        // The tree never came down: stock, deposit and bag all untouched
        expect(island.cellStock(-7, 0)).toEqual({ tree: 2, berry: 1, mushroom: 1 });
        expect(world.cellAt(-7, 0)?.resources).toEqual({ tree: 2 });
        expect(island.of('a')).toEqual({ sand: 8 });
    });

    it('gather respects the capacity — a full bag gathers nothing', () => {
        const { world, island } = buildProfiled();
        const ael = world.spawn(actor('a', 'Ael', 1, -4));
        for (let index = 0; index < 8; index++) {
            island.takeFromCell(ael, 'dirt');
        }
        // The meadow's two berries cannot fit — the gather is a no-op
        expect(island.gather(ael)).toBe(null);
        expect(island.cellStock(1, -4)).toEqual({ dirt: 1, berry: 2 });
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
        // The tile's stone pile is still there (the bird's failed take
        // never drew the deposit down)
        expect(world.cellAt(0, 0)?.resources).toEqual({});
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
