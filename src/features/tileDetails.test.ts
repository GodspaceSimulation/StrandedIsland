// Tests for the tile inspection logic (features/tileDetails.ts).
//
// All expectations come from the deterministic seed-7 island (default 25×17,
// centered coordinates — see scenario/island.test.ts). The cast comes ashore
// at the island edge (shipwreck rule):
//   (−11,0)   sand tile (beach)   h3  voxels [stone, dirt, sand]   ground supply
//             {stone, dirt, sand} ×∞  stock {stone:1, dirt:1, sand:1, coconut:2}  Ael stands here
//   (−4,−7)   sand tile (beach)   h3  ground supply + shell draw
//   (−12,−8)  shallows           h2  voxels [dirt, sand, water]  deposits {}         stock {fish:1}
//   (0,0)     stone tile (highland) h7  voxels [stone ×5, dirt, stone]  supply
//             {stone:1, dirt:1}  stock {stone:1, dirt:1}  Kiki flies at z 2
//   (1,−2)    tree tile (meadow with its localized ingress) h5  voxels
//             [stone ×3, dirt, grass]  supply
//             {stone:1, dirt:1, grass:1, tree:10}  stock
//             {tree:10, stone:1, dirt:1, grass:1, berry:3} — the meadow
//             beside the woods carries its 10-spot edge fringe (the
//             neighborhood model's localized tree ingress) — the 0.85-era
//             (1,−4) meadow became a lake at the lowered 0.8 threshold
//   (−7,0)    tree tile (forest) h5  voxels [stone ×3, dirt, grass, forest]
//             supply {stone:1, dirt:1, grass:1} + the neighborhood-counted
//             425-tree mirror — the persistent fine-scale stand
//             (plugins/forest)
//   (−5,3)    iron tile (lode — on the 37×25 reference board; the smaller
//             25×17 default keeps every vein sample below the threshold)
//             h7  supply {stone:1, dirt:1, iron:1}  stock {stone:1, dirt:1, iron:1, flint:1}
//
// Inspected tiles are addressed by TilePath (@godspace/core src/subtile):
// a length-1 path is a scale-0 tile, a length-2 path a subtile of that
// tile's sub-grid (the scale-1 view), and so on — recursive.

import { describe, it, expect } from 'vitest';
import { createIslandWorld } from '../scenario/island';
import {
    voxelRuns,
    voxelSummary,
    tileOccupants,
    tileGround,
    tileResources,
    tileSummary,
    tileForest,
    forestStandLine,
    forestTreeLine,
    occupantLine,
    scaleView,
    treeIconOpacity,
    TREE_ICON_FULL_COVERAGE,
    TREE_ICON_MIN_OPACITY,
    dominantVisibleType,
} from './tileDetails';
import { tileSurfaceKey } from '../plugins/terrain/islandTerrain';

const island = createIslandWorld({ seed: 7 });
// The 37×25 reference board — the pre-shrink default island, kept for the
// iron-lode pins (the vein threshold has no lodes left on 25×17)
const reference = createIslandWorld({ seed: 7, terrain: { width: 37, height: 25 } });

describe('voxelRuns / voxelSummary', () => {
    it('groups consecutive identical voxels into runs, bottom → top', () => {
        expect(voxelRuns(['stone', 'stone', 'stone', 'dirt', 'grass', 'forest'])).toEqual([
            { kind: 'stone', count: 3 },
            { kind: 'dirt', count: 1 },
            { kind: 'grass', count: 1 },
            { kind: 'forest', count: 1 },
        ]);
        // Water columns keep the liquid runs separate from the seabed
        expect(voxelRuns(['dirt', 'sand', 'water'])).toEqual([
            { kind: 'dirt', count: 1 },
            { kind: 'sand', count: 1 },
            { kind: 'water', count: 1 },
        ]);
    });

    it('renders the stack as a readable summary string', () => {
        expect(voxelSummary(['stone', 'stone', 'stone', 'dirt', 'grass', 'forest'])).toBe(
            'stone ×3, dirt, grass, forest',
        );
        expect(voxelSummary(['stone', 'dirt', 'sand'])).toBe('stone, dirt, sand');
        expect(voxelSummary([])).toBe('');
    });
});

describe('tileOccupants', () => {
    it('lists the castaway standing on an island tile, linked to the actor registry', () => {
        expect(tileOccupants(island, [{ x: -11, y: 0 }])).toEqual([
            {
                id: 'actor-1',
                name: 'Ael',
                kind: 'sentient',
                type: 'human',
                state: 'well',
                z: 0,
                actorId: 'actor-1',
            },
        ]);
    });

    it('lists birds as occupants too — every living thing is an actor', () => {
        // Kiki wheels at the center (0,0) at cruise altitude z 2, NOT in
        // world.actors — but she is a living thing and shows up in her
        // column; her display state is the z-2 fade band ('flying-2')
        expect(tileOccupants(island, [{ x: 0, y: 0 }])).toEqual([
            {
                id: 'bird-1',
                name: 'Kiki',
                kind: 'creature',
                type: 'bird',
                state: 'flying-2',
                z: 2,
                // Birds stay out of the actor registry — view-only residents
                actorId: undefined,
            },
        ]);
    });

    it('orders a mixed column grounded-first by ascending Z', () => {
        // Park a second bird right above Ael at z 1: column (−11,0) then
        // holds Ael (z 0) before the flyer (z 1)
        island.world.coordinates.place({
            id: 'bird-x',
            position: { x: -11, y: 0, z: 1 },
            kind: 'creature',
            type: 'bird',
            name: 'Jask',
            marker: 'J',
            state: 'flying',
        });
        expect(tileOccupants(island, [{ x: -11, y: 0 }]).map((occupant) => occupant.id)).toEqual([
            'actor-1',
            'bird-x',
        ]);
        island.world.coordinates.remove('bird-x');
    });

    it('filters deeper paths by the residents\u2019 fine positions', () => {
        // Ael's fine spot inside tile (−11,0)'s sub-grid — derived from the
        // world seed + entity id + parent tile, pinned here
        expect(island.world.subOf('actor-1')).toEqual({ x: -8, y: 0 });
        // The subtile at his spot holds him alone; the sub-grid's other
        // subtiles hold nobody
        expect(tileOccupants(island, [{ x: -11, y: 0 }, { x: -8, y: 0 }]).map((o) => o.id)).toEqual([
            'actor-1',
        ]);
        expect(tileOccupants(island, [{ x: -11, y: 0 }, { x: 0, y: 0 }])).toEqual([]);
        // Kiki's fine spot inside the tile she hovers (0,0)
        expect(island.world.subOf('bird-1')).toEqual({ x: 4, y: -6 });
        expect(tileOccupants(island, [{ x: 0, y: 0 }, { x: 4, y: -6 }]).map((o) => o.id)).toEqual([
            'bird-1',
        ]);
    });

    it('returns nothing for an empty column', () => {
        expect(tileOccupants(island, [{ x: -4, y: -7 }])).toEqual([]);
    });
});

describe('occupantLine', () => {
    it('reads grounded residents without altitude and flyers with z', () => {
        expect(
            occupantLine({
                id: 'actor-1',
                name: 'Ael',
                kind: 'sentient',
                type: 'human',
                state: 'well',
                z: 0,
                actorId: 'actor-1',
            }),
        ).toBe('Ael — human · well');
        expect(
            occupantLine({
                id: 'bird-1',
                name: 'Kiki',
                kind: 'creature',
                type: 'bird',
                state: 'flying',
                z: 2,
                actorId: undefined,
            }),
        ).toBe('Kiki — bird · flying · z 2');
    });
});

describe('tileGround', () => {
    it('generalizes the island-view stock into its item categories', () => {
        // Sea: the shoal seeds two fish → Foods ×2 (R5 abundance)
        expect(tileGround(island, [{ x: -12, y: -8 }])).toEqual([
            { category: 'food', label: 'Foods', count: 2 },
        ]);
        // The meadow (1,−2): 3 berries (food — the abundance tuning) + the
        // ground supply (dirt, grass — R4: the stone that the old endless
        // ground supply buried under the meadow stands only on the highland
        // rock sites) + its localized 14-tree ingress fringe (T2's densified
        // counts; each tree a material unit) — sixteen materials in all; the
        // categories list in ITEM_KINDS order (food before material)
        expect(tileGround(island, [{ x: 1, y: -2 }])).toEqual([
            { category: 'food', label: 'Foods', count: 3 },
            { category: 'material', label: 'Materials', count: 16 },
        ]);
        // Ael's beach: TWO coconuts (food — the abundance tuning) + the
        // ground supply — shell, sand and dirt (three materials; R4: the
        // meadow-style stone that the old endless ground supply buried under
        // the beach stands only on the highland rock sites; the 0.85-era
        // beach had no shell)
        expect(tileGround(island, [{ x: -11, y: 0 }])).toEqual([
            { category: 'food', label: 'Foods', count: 2 },
            { category: 'material', label: 'Materials', count: 3 },
        ]);
    });

    it('keeps the category generalization exact while the stock moves', () => {
        // The berry stock is live — emptying it drops the Foods category
        // entirely (zero categories drop out of the list); the ingress
        // fringe's fourteen tree units (T2) plus the gravel-excluded ground
        // supply keep the meadow's materials at sixteen
        const stock = island.inventory.cellStock(1, -2);
        const before = stock.berry ?? 0;
        stock.berry = 0;
        expect(tileGround(island, [{ x: 1, y: -2 }])).toEqual([
            { category: 'material', label: 'Materials', count: 16 },
        ]);
        stock.berry = before;
    });

    it('scatters the parent ground across the parent sub-grid at scale 1', () => {
        // Each non-resource unit lands on ONE seeded subtile of the parent
        // tile's 425-tile sub-grid (pinned by the world seed):
        //   coconuts on (−11,0) → subtiles (−11,5) and (7,−4)
        //   fish on (−12,−8) → subtile (9,5)
        //   berries on (1,−2) → subtiles (1,−3), (11,0) and (2,8)
        // Tile-resource stock (the mirrors — ground supply, trees) never
        // scatters — those units stand as the subtile deposits the terrain
        // distributed (trees at their persistent stand positions)
        expect(tileGround(island, [{ x: -11, y: 0 }, { x: -11, y: 5 }])).toEqual([
            { item: 'coconut', count: 1 },
        ]);
        expect(tileGround(island, [{ x: -11, y: 0 }, { x: 7, y: -4 }])).toEqual([
            { item: 'coconut', count: 1 },
        ]);
        expect(tileGround(island, [{ x: -11, y: 0 }, { x: 0, y: 0 }])).toEqual([]);
        expect(tileGround(island, [{ x: -12, y: -8 }, { x: 9, y: 5 }])).toEqual([
            { item: 'fish', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 1, y: -3 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 11, y: 0 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 2, y: 8 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
    });

    it('reflects gathering at the island view in every zoomed view', () => {
        // The berry stock is live — dropping it to 1 moves one berry's
        // scatter (the derivation reads the parent stock per call): the
        // (11,0) subtile empties, (1,−3) keeps the surviving unit
        const stock = island.inventory.cellStock(1, -2);
        const before = stock.berry ?? 0;
        stock.berry = 1;
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 11, y: 0 }])).toEqual([]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 1, y: -3 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        stock.berry = before;
    });
});

describe('tileResources', () => {
    it('lists the tile deposits with their unlimited flag, in resource order', () => {
        // The meadow (1,−2) carries the ground supply — every ground voxel
        // material the column is built from, each ×∞ (the dirt under it, the
        // grass cover — R4: gravel bedrock supplies nothing, and the stone
        // that once stood here ×∞ stands only on the highland rock sites) —
        // PLUS its localized 14-tree ingress fringe beside the woods (T2's
        // densified finite biological stand), in TILE_RESOURCES order
        // (tree first)
        expect(tileResources(island.world.cellAt(1, -2)?.resources)).toEqual([
            { resource: 'tree', count: 14, unlimited: false },
            { resource: 'dirt', count: 1, unlimited: true },
            { resource: 'grass', count: 1, unlimited: true },
        ]);
        // The forest keeps its FINITE biological stand (the
        // neighborhood-counted 425-tree mirror) beside the ground supply —
        // TILE_RESOURCES order (tree first); R4: no stone line
        expect(tileResources(island.world.cellAt(-7, 0)?.resources)).toEqual([
            { resource: 'tree', count: 425, unlimited: false },
            { resource: 'dirt', count: 1, unlimited: true },
            { resource: 'grass', count: 1, unlimited: true },
        ]);
        // An iron lode carries stone AND iron — both FINITE now (R4: the
        // highland's rock stock is the finite 3 units, not the endless
        // ground supply) — the 37×25 reference board (the default island
        // holds no lodes)
        expect(tileResources(reference.world.cellAt(-5, 3)?.resources)).toEqual([
            { resource: 'stone', count: 3, unlimited: false },
            { resource: 'iron', count: 1, unlimited: false },
            { resource: 'dirt', count: 1, unlimited: true },
        ]);
        // Sea columns are bare
        expect(tileResources(island.world.cellAt(-12, -8)?.resources)).toEqual([]);
        expect(tileResources(undefined)).toEqual([]);
    });
});

describe('tileForest', () => {
    it('summarizes a forest tile\u2019s stand and reads a fine spot\u2019s tree card', () => {
        // The island view: the seeded stand of the woods (−7,0) — its
        // neighborhood-counted 425 standing trees, 1688 wood across their
        // pools (captured at the 0.8 threshold)
        expect(tileForest(island, [{ x: -7, y: 0 }])).toEqual({ trees: 425, wood: 1688 });
        // An INGRESS MEADOW carries its localized fringe as a real stand —
        // the same summary shape the woods read (T2's densified fringe:
        // 14 trees, 61 wood across their pools)
        expect(tileForest(island, [{ x: 1, y: -2 }])).toEqual({ trees: 14, wood: 61 });
        // A BARE meadow (no forest neighbor) carries no forest layer
        expect(tileForest(island, [{ x: 0, y: -3 }])).toBeUndefined();
        expect(tileForest(island, [{ x: -11, y: 0 }])).toBeUndefined();
        // Scale 0: the tree standing exactly on a treed fine spot — its
        // card (wood pool, age, maturity). The stand's first seeded
        // position (−1,6) holds a captured pool-4 tree
        const card = tileForest(island, [{ x: -7, y: 0 }, { x: -1, y: 6 }]);
        expect(card).toEqual({
            trees: 1,
            wood: 4,
            tree: { wood: 4, ageMinutes: 2008964, mature: false },
        });
        // A bare fine cell of a wood carries no card — the first fine spot
        // the stand does NOT hold (deterministic row-major probe). The
        // (−7,0) stand is NOW packed (425 trees fill all 425 sub-grid cells
        // at the 0.8 density), so the probe uses the (7,3) stand (361 trees
        // at T2's densified edge — it has bare cells; its first bare spot
        // is the sub-grid corner)
        const stand = island.terrain.forestOf(7, 3)!;
        let bareSpot: { x: number; y: number } | undefined;
        for (let row = -8; row <= 8 && !bareSpot; row++) {
            for (let col = -12; col <= 12; col++) {
                if (!stand.trees.has(`${col},${row}`)) {
                    bareSpot = { x: col, y: row };
                    break;
                }
            }
        }
        expect(bareSpot).toEqual({ x: -12, y: -8 });
        expect(tileForest(island, [{ x: 7, y: 3 }, bareSpot!])).toBeUndefined();
        // Deeper paths carry nothing
        expect(tileForest(island, [{ x: -7, y: 0 }, { x: -1, y: 6 }, { x: 0, y: 0 }])).toBeUndefined();
    });
});

describe('forest display lines (forestStandLine / forestTreeLine)', () => {
    // Regression for the duplicated count + broken grammar the Tile
    // Inspector used to read at scale 0: "1 trees · 3 wood standing ·
    // wood 3 · age 3.2 y · growing". The single-tree read must now be
    // "1 tree · 3 wood standing · age 3.2 y · growing" — the wood count
    // once (the standing count), the tree count singularized, the age
    // and maturity kept.

    it('singularizes a single tree and keeps the standing wood count', () => {
        // The scale-0 shape tileForest produces (trees 1, wood = the
        // card's pool) — the count reads "1 tree", never "1 trees"
        expect(forestStandLine({ trees: 1, wood: 3 })).toBe('1 tree · 3 wood standing');
        expect(forestStandLine({ trees: 1, wood: 8 })).toBe('1 tree · 8 wood standing');
        // Plural stands keep the whole-stand summary behavior (N > 1 → "trees")
        expect(forestStandLine({ trees: 425, wood: 1688 })).toBe('425 trees · 1688 wood standing');
        expect(forestStandLine({ trees: 10, wood: 44 })).toBe('10 trees · 44 wood standing');
    });

    it('keeps the seeded stand summaries verbatim', () => {
        // The seed-7 stands the tileForest block pins above — their human
        // reads, captured against the deterministic island
        expect(forestStandLine(tileForest(island, [{ x: -7, y: 0 }])!)).toBe(
            '425 trees · 1688 wood standing',
        );
        // T2's densified ingress fringe (and the densified (4,−5) edge
        // band that App.test pins on the canvas)
        expect(forestStandLine(tileForest(island, [{ x: 1, y: -2 }])!)).toBe(
            '14 trees · 61 wood standing',
        );
        expect(forestStandLine(tileForest(island, [{ x: 4, y: -5 }])!)).toBe(
            '383 trees · 1518 wood standing',
        );
    });

    it('the tree card adds only age and maturity — never repeats the standing wood', () => {
        // The pinned card of the (−7,0) stand (tileForest block above):
        // wood 4, ageMinutes 2008964 → 3.8 y, not mature
        expect(
            forestTreeLine({
                trees: 1,
                wood: 4,
                tree: { wood: 4, ageMinutes: 2008964, mature: false },
            }),
        ).toBe(' · age 3.8 y · growing');
        // A mature card: the full pool of 8 at exactly eight island years
        // (8 × 1440 × 365 minutes) reads "8 y · mature"
        expect(
            forestTreeLine({
                trees: 1,
                wood: 8,
                tree: { wood: 8, ageMinutes: 4204800, mature: true },
            }),
        ).toBe(' · age 8 y · mature');
        // The card carries no wood segment at all — the standing line
        // already reads the pool (tileForest sets the view's wood to
        // the card's pool at scale 0)
        const card = { trees: 1, wood: 3, tree: { wood: 3, ageMinutes: 1681920, mature: false } };
        expect(forestTreeLine(card)).not.toContain('wood');
        // The island-view shape holds no card — the card line is empty
        expect(forestTreeLine({ trees: 425, wood: 1688 })).toBe('');
    });

    it('the scale-0 read composes to the single expected line', () => {
        // The exact shape the panel renders (stand line + card span),
        // 3.2 island years: 3.2 × 1440 × 365 = 1,681,920 minutes
        const forest = { trees: 1, wood: 3, tree: { wood: 3, ageMinutes: 1681920, mature: false } };
        expect(forestStandLine(forest) + forestTreeLine(forest)).toBe(
            '1 tree · 3 wood standing · age 3.2 y · growing',
        );
    });
});

describe('tileSummary', () => {
    it('assembles the full sand column under Ael at the island view (deposits + surface key)', () => {
        expect(tileSummary(island, [{ x: -11, y: 0 }])).toEqual({
            path: [{ x: -11, y: 0 }],
            x: -11,
            y: 0,
            biome: 'beach',
            // The unlimited ground supply decides the tile's look: the
            // column's topmost ground voxel (sand) keys the surface
            surface: 'sand',
            height: 3,
            waterLevel: 3,
            passable: true,
            // R4: the column's bedrock reads gravel (the rock the finite
            // stone mines off the highlands) — never the stone that the old
            // endless ground supply buried under every tile
            voxels: ['gravel', 'dirt', 'sand'],
            resources: [
                { resource: 'sand', count: 1, unlimited: true },
                { resource: 'dirt', count: 1, unlimited: true },
            ],
            // Scale-0 granularity: the ground lists its categories (the
            // beach carries TWO coconuts now — the abundance tuning — plus a
            // shell draw: three materials in all; R4: the meadow-style stone
            // is gone from the beach's supply)
            ground: [
                { category: 'food', label: 'Foods', count: 2 },
                { category: 'material', label: 'Materials', count: 3 },
            ],
            occupants: [
                {
                    id: 'actor-1',
                    name: 'Ael',
                    kind: 'sentient',
                    type: 'human',
                    state: 'well',
                    z: 0,
                    actorId: 'actor-1',
                },
            ],
            // No construction site touches this tile at tick 0 (the
            // construction plugin places its first project on the first tick)
            structures: [],
        });
    });

    it('assembles a submerged shallows column with its fish stock', () => {
        expect(tileSummary(island, [{ x: -12, y: -8 }])).toEqual({
            path: [{ x: -12, y: -8 }],
            x: -12,
            y: -8,
            biome: 'shallows',
            surface: 'shallows',
            height: 2,
            waterLevel: 3,
            passable: false,
            voxels: ['dirt', 'sand', 'water'],
            resources: [],
            ground: [{ category: 'food', label: 'Foods', count: 2 }],
            occupants: [],
            structures: [],
        });
    });

    it('assembles the woods under the inspected tile: the stand summary rides the summary', () => {
        const summary = tileSummary(island, [{ x: -7, y: 0 }]);
        // The surface key: the standing trees win (the landmark deposit)
        expect(summary?.surface).toBe('tree');
        // R4: the woodland column carries no stone line (the finite rock
        // stands only on the highland sites) — the ground supply reads
        // dirt + grass
        expect(summary?.resources).toEqual([
            { resource: 'tree', count: 425, unlimited: false },
            { resource: 'dirt', count: 1, unlimited: true },
            { resource: 'grass', count: 1, unlimited: true },
        ]);
        // THE FOREST LAYER — the stand summary (captured at minute 0 at the
        // 0.8 threshold)
        expect(summary?.forest).toEqual({ trees: 425, wood: 1688 });
        // An INGRESS meadow rides its fringe's layer (T2's densified
        // fringe); a bare meadow carries no forest layer at all
        expect(tileSummary(island, [{ x: 1, y: -2 }])?.forest).toEqual({ trees: 14, wood: 61 });
        expect(tileSummary(island, [{ x: 0, y: -3 }])?.forest).toBeUndefined();
    });

    it('assembles an iron lode column with its deposits', () => {
        // The 37×25 reference board — the default island holds no lodes
        const summary = tileSummary(reference, [{ x: -5, y: 3 }]);
        // R6 — the lode reads DIRT at this scale: the dominant visible type
        // is the majority of the cell's children, and the single iron child
        // sits among dirt/sand siblings. The landmark itself still rides
        // the resources and ground lines below
        expect(summary?.surface).toBe('dirt');
        expect(summary?.biome).toBe('highland');
        // R4: the lode's rock stock is the FINITE highland stock (3 units,
        // not the endless ×∞ ground supply) — the iron ore stays finite
        expect(summary?.resources).toEqual([
            { resource: 'stone', count: 3, unlimited: false },
            { resource: 'iron', count: 1, unlimited: false },
            { resource: 'dirt', count: 1, unlimited: true },
        ]);
        // Stone, iron and dirt aggregate as materials — R4: the lode's rock
        // stock counts its THREE finite units (3 stone + 1 iron + 1 dirt = 5
        // material units, not the old ×∞ ground line); this run's lode drew
        // no flint (the survey's chance stream moved with the map)
        expect(summary?.ground).toEqual([
            { category: 'material', label: 'Materials', count: 5 },
        ]);
    });

    it('assembles a scale-1 subtile with its zoom lineage and fine residents', () => {
        const summary = tileSummary(island, [{ x: -11, y: 0 }, { x: -8, y: 0 }]);
        // The lineage rides on the summary — the full zoom path
        expect(summary?.path).toEqual([
            { x: -11, y: 0 },
            { x: -8, y: 0 },
        ]);
        // The subtile inherits the parent column (the beach's interior
        // ground) with the ground supply carried onto every subtile
        // (R4: gravel bedrock + the sand/dirt underlayer — no stone)
        expect(summary?.biome).toBe('beach');
        expect(summary?.surface).toBe('sand');
        expect(summary?.height).toBe(3);
        expect(summary?.passable).toBe(true);
        expect(summary?.resources).toEqual([
            { resource: 'sand', count: 1, unlimited: true },
            { resource: 'dirt', count: 1, unlimited: true },
        ]);
        // Ael stands at this subtile (his fine spot)
        expect(summary?.occupants.map((o) => o.id)).toEqual(['actor-1']);
        // The coconut scattered to (−11,5), not here
        expect(summary?.ground).toEqual([]);
    });

    it('resolves to null outside the canvas or past the generated depth', () => {
        expect(tileSummary(island, [{ x: -13, y: 0 }])).toBeNull();
        expect(tileSummary(island, [{ x: 13, y: 0 }])).toBeNull();
        expect(tileSummary(island, [{ x: 0, y: 9 }])).toBeNull();
        expect(tileSummary(island, [{ x: 0, y: -9 }])).toBeNull();
        // The island generates one subtile level — depth 3 has no content
        expect(
            tileSummary(island, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]),
        ).toBeNull();
        expect(tileSummary(island, [])).toBeNull();
    });
});

describe('scaleView', () => {
    it('binds the live root world at the island view', () => {
        const slice = scaleView(island, []);
        expect(slice?.canvas).toBe(island.world.canvas);
        // The root coordinates are the live coordinate space itself
        expect(slice?.coordinates.all().length).toBe(island.world.coordinates.count());
    });

    it('builds the zoomed slice: the parent sub-grid with fine-positioned residents', () => {
        const slice = scaleView(island, [{ x: -11, y: 0 }]);
        expect(slice?.canvas.width).toBe(25);
        expect(slice?.canvas.height).toBe(17);
        expect(slice?.canvas.cells.length).toBe(425);
        // Ael is the only resident of tile (−11,0) — drawn at his fine
        // spot, altitude preserved. The tile's ground items JOIN the slice
        // as canvas objects: the TWO coconuts (the abundance tuning) stand
        // at their scattered subtiles (−11,5) and (7,−4), typed with the
        // item id so the canvases draw its emoji.
        expect(slice?.coordinates.all()).toEqual([
            {
                id: 'actor-1',
                position: { x: -8, y: 0, z: 0 },
                kind: 'sentient',
                type: 'human',
                name: 'Ael',
                marker: 'A',
                state: 'well',
                // The profile rides the coordinate facet (engine/world.ts
                // facetOf) so the canvases draw the gendered emoji
                sex: 'male',
            },
            {
                id: 'ground:coconut:0',
                position: { x: -11, y: 5, z: 0 },
                kind: 'item',
                type: 'coconut',
                name: 'Coconut',
            },
            {
                id: 'ground:coconut:1',
                position: { x: 7, y: -4, z: 0 },
                kind: 'item',
                type: 'coconut',
                name: 'Coconut',
            },
            // The beach's shell draw scatters to its own seeded subtile
            {
                id: 'ground:shell:2',
                position: { x: -6, y: 6, z: 0 },
                kind: 'item',
                type: 'shell',
                name: 'Shell',
            },
        ]);
    });

    it('keeps the canvas objects and the inspector lists in exact agreement', () => {
        // Every ground unit the slice draws lands where the scale-1 Tile
        // Inspector's derivation counts it — the berry subtiles of the
        // meadow hold exactly the berries the board shows there
        const slice = scaleView(island, [{ x: 1, y: -2 }]);
        const berries = slice?.coordinates.all().filter((entry) => entry.type === 'berry');
        expect(berries?.map((entry) => [entry.position.x, entry.position.y])).toEqual([
            [1, -3],
            [11, 0],
            [2, 8],
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 1, y: -3 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 11, y: 0 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 2, y: 8 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        // …and subtile (0,0) holds nothing — the inspector and board agree
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 0, y: 0 }])).toEqual([]);
    });

    it('scatters deeper views consistently with the inspector recursion', () => {
        // A depth-2 island: the sea tile's sub-grid opens again — the fish
        // unit that landed at (9,5) at scale 1 is the only item entering
        // that board, scattered once more inside it
        const deep = createIslandWorld({ seed: 7, terrain: { subtiles: 2 } });
        const slice = scaleView(deep, [{ x: -12, y: -8 }, { x: 9, y: 5 }]);
        const fish = slice?.coordinates.all().filter((entry) => entry.type === 'fish');
        expect(fish?.length).toBe(1);
        const spot = (fish as Array<{ position: { x: number; y: number } }>)[0].position;
        // The board object and the inspector recursion agree exactly: the
        // unit stands at the subtile the derivation counts it in
        expect(tileGround(deep, [{ x: -12, y: -8 }, { x: 9, y: 5 }, { x: spot.x, y: spot.y }])).toEqual([
            { item: 'fish', count: 1 },
        ]);
        // Any other subtile of that board is bare
        expect(tileGround(deep, [{ x: -12, y: -8 }, { x: 9, y: 5 }, { x: 0, y: 0 }])).toEqual(
            spot.x === 0 && spot.y === 0 ? [{ item: 'fish', count: 1 }] : [],
        );
    });

    it('resolves to null past the generated depth', () => {
        expect(scaleView(island, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBeNull();
    });
});

// ── R2 — the scale-1 tree icon opacity (the coverage-readability rule) ───────
// The island view fades a tile's standing tree icon by its TRUE scale-0 tree
// coverage (tree units / sub-grid cells), clamped: opacity = clamp(coverage /
// FULL_COVERAGE, MIN_OPACITY, 1). Zero trees → NO icon (undefined — the caller
// draws nothing). The anchors below are the acceptance set: coverage 0.01 →
// the 0.1 floor, 0.45 → 0.5, 0.9 → full, and the clamp above full.
describe('treeIconOpacity (the scale-1 coverage fade)', () => {
    it('pins the rule constants', () => {
        // 90 % woods read as a full canopy; a lone tree still marks the tile
        expect(TREE_ICON_FULL_COVERAGE).toBe(0.9);
        expect(TREE_ICON_MIN_OPACITY).toBe(0.1);
    });

    it('fades by the true coverage with the documented anchors', () => {
        // 1 tree among 100 cells — coverage 0.01 → 0.0111 raw → the 0.1 floor
        expect(treeIconOpacity(1, 100)).toBe(0.1);
        // 45 % woods → 0.45 / 0.9 = exactly half
        expect(treeIconOpacity(45, 100)).toBe(0.5);
        // 90 % woods → the full-coverage mark → full strength
        expect(treeIconOpacity(90, 100)).toBe(1);
        // Coverage ABOVE the full mark clamps at 1 (the icon fades DOWN with
        // sparseness, never up)
        expect(treeIconOpacity(100, 100)).toBe(1);
        expect(treeIconOpacity(95, 90)).toBe(1);
    });

    it('draws no icon at all for zero trees (and never divides by zero)', () => {
        // Zero stock → undefined → the caller draws NOTHING (a clear-cut tile
        // is bare — the same no-flood rule the decorations carry)
        expect(treeIconOpacity(0, 100)).toBeUndefined();
        // A degenerate zero-cell sub-grid resolves the same way
        expect(treeIconOpacity(5, 0)).toBeUndefined();
        expect(treeIconOpacity(-1, 100)).toBeUndefined();
    });

    it('tracks the seed-7 island view anchors exactly', () => {
        // The sub-grid copies the world grid's dims (25×17 = 425 cells) — the
        // two live island-view cases: the 14-tree ingress fringe sits on the
        // 0.1 floor (14/425/0.9 ≈ 0.0366 → floor), while the 383-tree edge
        // wood (383/425/0.9 ≈ 1.0013) clamps to full strength
        expect(treeIconOpacity(14, 425)).toBe(TREE_ICON_MIN_OPACITY);
        expect(treeIconOpacity(383, 425)).toBe(1);
    });
});

describe('dominantVisibleType — the coarse-scale majority read (R6)', () => {
    it('paints each coarse tile with the majority visible type of its children', () => {
        // The tree-fringed meadow (1,−2): its OWN key is 'tree' (the 14-spot
        // ingress deposit) but the fringe is 14 spots among 425 children —
        // at the coarse scale the tile READS grass
        expect(tileSurfaceKey(island.world.canvas.cells.find((cell) => cell.x === 1 && cell.y === -2)!)).toBe('tree');
        expect(dominantVisibleType(island, [{ x: 1, y: -2 }])).toBe('grass');
        // The rock site (0,0): own 'stone', dominant 'dirt' — the cap is a
        // handful among dirt floors (the 🪨 decoration keeps it findable)
        expect(tileSurfaceKey(island.world.canvas.cells.find((cell) => cell.x === 0 && cell.y === 0)!)).toBe('stone');
        expect(dominantVisibleType(island, [{ x: 0, y: 0 }])).toBe('dirt');
        // The iron lode (−1,−1): own 'iron', dominant 'dirt' — the rare
        // landmark still rides the resources lines, the canvas reads ground
        expect(dominantVisibleType(island, [{ x: -1, y: -1 }])).toBe('dirt');
        // The lake keeps its water identity (every child is the drowned
        // column); the true canopy reads tree; the sea keeps its plain biome
        expect(dominantVisibleType(island, [{ x: 1, y: -4 }])).toBe('lake');
        expect(dominantVisibleType(island, [{ x: 4, y: -5 }])).toBe('tree');
        expect(dominantVisibleType(island, [{ x: -7, y: 0 }])).toBe('tree');
        expect(dominantVisibleType(island, [{ x: -12, y: -8 }])).toBe('shallows');
    });

    it('falls back to the tile\u2019s own key at the leaf level and undefined for dead addresses', () => {
        // A scale-0 child has no generated sub-grid: its own surface key IS
        // its visible type (the zoomed views show children cell-for-cell,
        // so they never need the majority)
        expect(dominantVisibleType(island, [{ x: 0, y: 0 }, { x: -1, y: -4 }])).toBe('stone');
        expect(dominantVisibleType(island, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBe('dirt');
        // Empty paths and unresolvable addresses answer undefined — the
        // caller falls back to the tile's own key
        expect(dominantVisibleType(island, [])).toBeUndefined();
        expect(dominantVisibleType(island, [{ x: 99, y: 99 }])).toBeUndefined();
    });
});

// ── The depth-2 fold under the caching fast paths (R6 performance fix) ───────
// At configured depth 2 the fold reads the deepest level through the terrain
// plugin's surfaceKeyCounts histogram and caches every intermediate node —
// both must answer EXACTLY what the naive recursive fold computes. The
// reference below is that naive fold, written straight off the rule and
// independent of the caches (it only materializes grids and keys cells).
describe('dominantVisibleType — the depth-2 fold is exact and invalidates (R6)', () => {
    type DeepWorld = ReturnType<typeof createIslandWorld>;

    /** The independent reference: naive recursive majority over MATERIALIZED children. */
    const naiveDominant = (world: DeepWorld, path: Array<{ x: number; y: number }>): string | undefined => {
        const grid = world.terrain.canvasFor(path);
        if (!grid || grid.cells.length === 0) {
            return tileSurfaceKey(world.terrain.cellFor(path));
        }
        const counts = new Map<string, number>();
        let best: string | undefined;
        let bestCount = 0;
        grid.cells.forEach((child) => {
            const key =
                naiveDominant(world, [...path, { x: child.x, y: child.y }]) ??
                tileSurfaceKey(child);
            if (key === undefined) {
                return;
            }
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            if (count > bestCount) {
                best = key;
                bestCount = count;
            }
        });
        return best;
    };

    it('matches the naive fold on EVERY root of a small depth-2 world', () => {
        // A 5×3 depth-2 world: 15 roots, each folding 15 children whose own
        // children are leaves — every fold path (recursion, histogram,
        // cache) exercised against the reference at trivial cost
        const small = createIslandWorld({ seed: 11, terrain: { subtiles: 2, width: 5, height: 3 } });
        small.world.canvas.cells.forEach((cell) => {
            const path = [{ x: cell.x, y: cell.y }];
            expect(dominantVisibleType(small, path)).toBe(naiveDominant(small, path));
        });
    });

    it('matches the naive fold on the T5 repro world (seed 11, subtiles 2)', { timeout: 120_000 }, () => {
        // The exact world from the performance report — the cached fold must
        // agree with the naive one on land, forest, coast and sea alike
        const deep = createIslandWorld({ seed: 11, terrain: { subtiles: 2 } });
        const cells = deep.world.canvas.cells;
        const samples = [
            cells[0],
            cells[106],
            cells[212],
            cells[318],
            cells[424],
            // …plus one canopy and one water column (cheap landmark picks)
            cells.find((cell) => cell.biome === 'forest'),
            cells.find((cell) => !cell.passable),
        ].filter((cell): cell is (typeof cells)[number] => !!cell);
        samples.forEach((cell) => {
            const path = [{ x: cell.x, y: cell.y }];
            expect(dominantVisibleType(deep, path)).toBe(naiveDominant(deep, path));
        });
    });

    it('invalidates every cached node when the parent changes', () => {
        const small = createIslandWorld({ seed: 11, terrain: { subtiles: 2, width: 5, height: 3 } });
        const cell = small.world.canvas.cells.find((candidate) => candidate.passable)!;
        const path = [{ x: cell.x, y: cell.y }];
        const before = dominantVisibleType(small, path);
        expect(before).toBe(naiveDominant(small, path));
        // Warm reads answer from the caches (memo + path cache), unchanged
        expect(dominantVisibleType(small, path)).toBe(before);
        // Drown the column — the biome rides EVERY child (the inherited
        // column), so the memo AND every cached intermediate are stale at
        // once; the fingerprint moves, the fold rebuilds
        cell.biome = 'lake';
        cell.passable = false;
        expect(dominantVisibleType(small, path)).toBe(naiveDominant(small, path));
        // A basin is its WATER over every decoration — the fresh answer,
        // not the cached one (a stale cache would keep reading `before`)
        expect(dominantVisibleType(small, path)).toBe('lake');
    });

    it('resolves histogram ties by the key that reached the count first', () => {
        // The tie rule of the row-major strict-`>` scan, pinned against a
        // crafted histogram: 'b' hit its count of 2 at index 2, 'a' only at
        // index 3 — the sequence a,b,b,a scans to 'b'
        const counts = [
            { key: 'a', count: 2, first: 0, last: 3 },
            { key: 'b', count: 2, first: 1, last: 2 },
        ];
        // The scan reference over the matching row-major sequence
        const sequence = ['a', 'b', 'b', 'a'];
        const scan = new Map<string, number>();
        let best: string | undefined;
        let bestCount = 0;
        sequence.forEach((key) => {
            const count = (scan.get(key) ?? 0) + 1;
            scan.set(key, count);
            if (count > bestCount) {
                best = key;
                bestCount = count;
            }
        });
        // The stub terrain serves the histogram at the deepest level (the
        // fold's fast path) — its answer must equal the scan's
        const cell = {
            x: 0,
            y: 0,
            biome: 'meadow',
            height: 5,
            waterLevel: 3,
            passable: true,
            voxels: ['dirt'],
            resources: {},
        };
        const stub = {
            terrain: {
                depth: () => 1,
                size: () => ({ width: 3, height: 3 }),
                cellFor: (stubPath: Array<{ x: number; y: number }>) =>
                    stubPath.length === 1 && stubPath[0].x === 0 && stubPath[0].y === 0
                        ? (cell as never)
                        : undefined,
                canvasFor: () => undefined,
                surfaceKeyCounts: (stubPath: Array<{ x: number; y: number }>) =>
                    stubPath.length === 1 ? counts : undefined,
            },
        } as unknown as Parameters<typeof dominantVisibleType>[0];
        expect(best).toBe('b');
        expect(dominantVisibleType(stub, [{ x: 0, y: 0 }])).toBe('b');
    });
});
