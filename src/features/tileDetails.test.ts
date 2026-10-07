// Tests for the tile inspection logic (features/tileDetails.ts).
//
// All expectations come from the deterministic seed-7 island (default 25×17,
// centered coordinates — see scenario/island.test.ts). The cast comes ashore
// at the island edge (shipwreck rule):
//   (−11,0)   sand tile (beach)   h3  voxels [stone, dirt, sand]   ground supply
//             {stone, dirt, sand} ×∞  stock {stone:1, dirt:1, sand:1, coconut:1}  Ael stands here
//   (−4,−7)   sand tile (beach)   h3  ground supply + shell draw
//   (−12,−8)  shallows           h2  voxels [dirt, sand, water]  deposits {}         stock {fish:1}
//   (0,0)     stone tile (highland) h7  voxels [stone ×5, dirt, stone]  supply
//             {stone:1, dirt:1}  stock {stone:1, dirt:1}  Kiki flies at z 2
//   (1,−2)    tree tile (meadow with its localized ingress) h5  voxels
//             [stone ×3, dirt, grass]  supply
//             {stone:1, dirt:1, grass:1, tree:10}  stock
//             {tree:10, stone:1, dirt:1, grass:1, berry:2} — the meadow
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
    occupantLine,
    scaleView,
} from './tileDetails';

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
        // Sea: one fish → Foods ×1
        expect(tileGround(island, [{ x: -12, y: -8 }])).toEqual([
            { category: 'food', label: 'Foods', count: 1 },
        ]);
        // The meadow (1,−2): 2 berries (food) + the ground supply (stone,
        // dirt, grass) + its localized 10-tree ingress fringe (each tree a
        // material unit) — thirteen materials in all; the categories list
        // in ITEM_KINDS order (food before material)
        expect(tileGround(island, [{ x: 1, y: -2 }])).toEqual([
            { category: 'food', label: 'Foods', count: 2 },
            { category: 'material', label: 'Materials', count: 13 },
        ]);
        // Ael's beach: coconut + shell (food) + the ground supply (three
        // materials) — four materials in all (the 0.85-era beach had no shell)
        expect(tileGround(island, [{ x: -11, y: 0 }])).toEqual([
            { category: 'food', label: 'Foods', count: 1 },
            { category: 'material', label: 'Materials', count: 4 },
        ]);
    });

    it('keeps the category generalization exact while the stock moves', () => {
        // The berry stock is live — emptying it drops the Foods category
        // entirely (zero categories drop out of the list); the ingress
        // fringe's ten tree units keep the meadow's materials at thirteen
        const stock = island.inventory.cellStock(1, -2);
        const before = stock.berry ?? 0;
        stock.berry = 0;
        expect(tileGround(island, [{ x: 1, y: -2 }])).toEqual([
            { category: 'material', label: 'Materials', count: 13 },
        ]);
        stock.berry = before;
    });

    it('scatters the parent ground across the parent sub-grid at scale 1', () => {
        // Each non-resource unit lands on ONE seeded subtile of the parent
        // tile's 425-tile sub-grid (pinned by the world seed):
        //   coconut on (−11,0) → subtile (−11,5)
        //   fish on (−12,−8) → subtile (9,5)
        //   berries on (1,−2) → subtiles (1,−3) and (11,0)
        // Tile-resource stock (the mirrors — ground supply, trees) never
        // scatters — those units stand as the subtile deposits the terrain
        // distributed (trees at their persistent stand positions)
        expect(tileGround(island, [{ x: -11, y: 0 }, { x: -11, y: 5 }])).toEqual([
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
        // The meadow (1,−2) carries the voxel ground supply — every ground
        // voxel material the column is built from, each ×∞ (stone bedrock,
        // the dirt under it, the grass cover) — PLUS its localized 10-tree
        // ingress fringe beside the woods (the finite biological stand),
        // in TILE_RESOURCES order (tree first)
        expect(tileResources(island.world.cellAt(1, -2)?.resources)).toEqual([
            { resource: 'tree', count: 10, unlimited: false },
            { resource: 'stone', count: 1, unlimited: true },
            { resource: 'dirt', count: 1, unlimited: true },
            { resource: 'grass', count: 1, unlimited: true },
        ]);
        // The forest keeps its FINITE biological stand (the
        // neighborhood-counted 425-tree mirror) beside the ground supply —
        // TILE_RESOURCES order (tree first)
        expect(tileResources(island.world.cellAt(-7, 0)?.resources)).toEqual([
            { resource: 'tree', count: 425, unlimited: false },
            { resource: 'stone', count: 1, unlimited: true },
            { resource: 'dirt', count: 1, unlimited: true },
            { resource: 'grass', count: 1, unlimited: true },
        ]);
        // An iron lode carries stone AND iron — the ore finite (the 37×25
        // reference board — the default island holds no lodes)
        expect(tileResources(reference.world.cellAt(-5, 3)?.resources)).toEqual([
            { resource: 'stone', count: 1, unlimited: true },
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
        // the same summary shape the woods read
        expect(tileForest(island, [{ x: 1, y: -2 }])).toEqual({ trees: 10, wood: 44 });
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
        // at the 0.8 density), so the probe uses the (7,3) stand (298 trees
        // — it has bare cells; its first bare spot is the sub-grid corner)
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
            voxels: ['stone', 'dirt', 'sand'],
            resources: [
                { resource: 'stone', count: 1, unlimited: true },
                { resource: 'sand', count: 1, unlimited: true },
                { resource: 'dirt', count: 1, unlimited: true },
            ],
            // Scale-0 granularity: the ground lists its categories (the
            // beach carries a shell draw too — four materials in all)
            ground: [
                { category: 'food', label: 'Foods', count: 1 },
                { category: 'material', label: 'Materials', count: 4 },
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
            ground: [{ category: 'food', label: 'Foods', count: 1 }],
            occupants: [],
            structures: [],
        });
    });

    it('assembles the woods under the inspected tile: the stand summary rides the summary', () => {
        const summary = tileSummary(island, [{ x: -7, y: 0 }]);
        // The surface key: the standing trees win (the landmark deposit)
        expect(summary?.surface).toBe('tree');
        expect(summary?.resources).toEqual([
            { resource: 'tree', count: 425, unlimited: false },
            { resource: 'stone', count: 1, unlimited: true },
            { resource: 'dirt', count: 1, unlimited: true },
            { resource: 'grass', count: 1, unlimited: true },
        ]);
        // THE FOREST LAYER — the stand summary (captured at minute 0 at the
        // 0.8 threshold)
        expect(summary?.forest).toEqual({ trees: 425, wood: 1688 });
        // An INGRESS meadow rides its fringe's layer; a bare meadow carries
        // no forest layer at all
        expect(tileSummary(island, [{ x: 1, y: -2 }])?.forest).toEqual({ trees: 10, wood: 44 });
        expect(tileSummary(island, [{ x: 0, y: -3 }])?.forest).toBeUndefined();
    });

    it('assembles an iron lode column with its deposits', () => {
        // The 37×25 reference board — the default island holds no lodes
        const summary = tileSummary(reference, [{ x: -5, y: 3 }]);
        // The lode surfaces as iron even though stone surrounds it —
        // landmark priority puts the rare resource first
        expect(summary?.surface).toBe('iron');
        expect(summary?.biome).toBe('highland');
        expect(summary?.resources).toEqual([
            { resource: 'stone', count: 1, unlimited: true },
            { resource: 'iron', count: 1, unlimited: false },
            { resource: 'dirt', count: 1, unlimited: true },
        ]);
        // Stone, iron and dirt aggregate as materials — this run's lode
        // drew no flint (the survey's chance stream moved with the map)
        expect(summary?.ground).toEqual([
            { category: 'material', label: 'Materials', count: 3 },
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
        expect(summary?.biome).toBe('beach');
        expect(summary?.surface).toBe('sand');
        expect(summary?.height).toBe(3);
        expect(summary?.passable).toBe(true);
        expect(summary?.resources).toEqual([
            { resource: 'stone', count: 1, unlimited: true },
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
        // as canvas objects: the coconut stands at its scattered subtile
        // (−11,5), typed with the item id so the canvases draw its emoji.
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
            // The beach's shell draw scatters to its own seeded subtile
            {
                id: 'ground:shell:1',
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
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 1, y: -3 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 1, y: -2 }, { x: 11, y: 0 }])).toEqual([
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
