// Tests for the tile inspection logic (features/tileDetails.ts).
//
// All expectations come from the deterministic seed-7 island (default 37×25,
// centered coordinates — see scenario/island.test.ts). The cast comes ashore
// at the island edge (shipwreck rule):
//   (17,−11) sand tile (beach)   h3  voxels [stone, soil, sand]  deposits {sand:1}  stock {sand:1, coconut:1}  Ael stands here
//   (−10,−11) sand tile (beach)  h3  voxels [stone, soil, sand]  deposits {sand:1}  stock {sand:1, coconut:1, shell:1}
//   (−18,−12) shallows           h2  voxels [soil, sand, water]  deposits {}         stock {fish:1}
//   (0,0)     dirt tile (meadow) h5  voxels [stone ×3, soil, grass]  deposits {dirt:1}  stock {dirt:1, berry:2}  Kiki flies at z 2
//   (−3,−6)   wood tile (forest) h5  voxels [stone ×3, soil, grass, forest]  deposits {wood:2}  stock {wood:2, berry:1}
//   (−5,3)    iron tile (lode)   h7  deposits {stone:1, iron:1}  stock {stone:1, iron:1, flint:1}
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
    occupantLine,
    scaleView,
} from './tileDetails';

const island = createIslandWorld({ seed: 7 });

describe('voxelRuns / voxelSummary', () => {
    it('groups consecutive identical voxels into runs, bottom → top', () => {
        expect(voxelRuns(['stone', 'stone', 'stone', 'soil', 'grass', 'forest'])).toEqual([
            { kind: 'stone', count: 3 },
            { kind: 'soil', count: 1 },
            { kind: 'grass', count: 1 },
            { kind: 'forest', count: 1 },
        ]);
        // Water columns keep the liquid runs separate from the seabed
        expect(voxelRuns(['soil', 'sand', 'water'])).toEqual([
            { kind: 'soil', count: 1 },
            { kind: 'sand', count: 1 },
            { kind: 'water', count: 1 },
        ]);
    });

    it('renders the stack as a readable summary string', () => {
        expect(voxelSummary(['stone', 'stone', 'stone', 'soil', 'grass', 'forest'])).toBe(
            'stone ×3, soil, grass, forest',
        );
        expect(voxelSummary(['stone', 'soil', 'sand'])).toBe('stone, soil, sand');
        expect(voxelSummary([])).toBe('');
    });
});

describe('tileOccupants', () => {
    it('lists the castaway standing on a scale-0 tile, linked to the actor registry', () => {
        expect(tileOccupants(island, [{ x: 17, y: -11 }])).toEqual([
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
        // world.actors — but she is a living thing and shows up in her column
        expect(tileOccupants(island, [{ x: 0, y: 0 }])).toEqual([
            {
                id: 'bird-1',
                name: 'Kiki',
                kind: 'creature',
                type: 'bird',
                state: 'flying',
                z: 2,
                // Birds stay out of the actor registry — view-only residents
                actorId: undefined,
            },
        ]);
    });

    it('orders a mixed column grounded-first by ascending Z', () => {
        // Park a second bird right above Ael at z 1: column (17,−11) then
        // holds Ael (z 0) before the flyer (z 1)
        island.world.coordinates.place({
            id: 'bird-x',
            position: { x: 17, y: -11, z: 1 },
            kind: 'creature',
            type: 'bird',
            name: 'Jask',
            marker: 'J',
            state: 'flying',
        });
        expect(tileOccupants(island, [{ x: 17, y: -11 }]).map((occupant) => occupant.id)).toEqual([
            'actor-1',
            'bird-x',
        ]);
        island.world.coordinates.remove('bird-x');
    });

    it('filters deeper paths by the residents\u2019 fine positions', () => {
        // Ael's fine spot inside tile (17,−11)'s sub-grid — derived from the
        // world seed + entity id + parent tile, pinned here
        expect(island.world.subOf('actor-1')).toEqual({ x: 11, y: 3 });
        // The subtile at his spot holds him alone; the sub-grid's other
        // subtiles hold nobody
        expect(tileOccupants(island, [{ x: 17, y: -11 }, { x: 11, y: 3 }]).map((o) => o.id)).toEqual([
            'actor-1',
        ]);
        expect(tileOccupants(island, [{ x: 17, y: -11 }, { x: 0, y: 0 }])).toEqual([]);
        // Kiki's fine spot inside the tile she hovers (0,0)
        expect(island.world.subOf('bird-1')).toEqual({ x: 6, y: -10 });
        expect(tileOccupants(island, [{ x: 0, y: 0 }, { x: 6, y: -10 }]).map((o) => o.id)).toEqual([
            'bird-1',
        ]);
    });

    it('returns nothing for an empty column', () => {
        expect(tileOccupants(island, [{ x: -10, y: -11 }])).toEqual([]);
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
    it('generalizes the scale-0 stock into its item categories', () => {
        // Sea: one fish → Foods ×1
        expect(tileGround(island, [{ x: -18, y: -12 }])).toEqual([
            { category: 'food', label: 'Foods', count: 1 },
        ]);
        // The meadow under Kiki: dirt (material) + 2 berries (food) — the
        // categories list in ITEM_KINDS order (food before material)
        expect(tileGround(island, [{ x: 0, y: 0 }])).toEqual([
            { category: 'food', label: 'Foods', count: 2 },
            { category: 'material', label: 'Materials', count: 1 },
        ]);
        // Ael's beach: coconut (food) + the sand mirror (material)
        expect(tileGround(island, [{ x: 17, y: -11 }])).toEqual([
            { category: 'food', label: 'Foods', count: 1 },
            { category: 'material', label: 'Materials', count: 1 },
        ]);
    });

    it('keeps the category generalization exact while the stock moves', () => {
        // The berry stock is live — emptying it drops the Foods category
        // entirely (zero categories drop out of the list)
        const stock = island.inventory.cellStock(0, 0);
        const before = stock.berry ?? 0;
        stock.berry = 0;
        expect(tileGround(island, [{ x: 0, y: 0 }])).toEqual([
            { category: 'material', label: 'Materials', count: 1 },
        ]);
        stock.berry = before;
    });

    it('scatters the parent ground across the parent sub-grid at scale 1', () => {
        // Each non-resource unit lands on ONE seeded subtile of the parent
        // tile's 925-tile sub-grid (pinned by the world seed):
        //   coconut on (17,−11) → subtile (11,−9)
        //   fish on (−18,−12) → subtile (−4,−10)
        //   berries on (0,0) → subtiles (−1,−1) and (−5,−3)
        // Tile-resource stock (the sand/dirt/wood mirrors) never scatters —
        // those units stand as the subtile deposits the terrain distributed
        expect(tileGround(island, [{ x: 17, y: -11 }, { x: 11, y: -9 }])).toEqual([
            { item: 'coconut', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 17, y: -11 }, { x: 0, y: 0 }])).toEqual([]);
        expect(tileGround(island, [{ x: -18, y: -12 }, { x: -4, y: -10 }])).toEqual([
            { item: 'fish', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: -1, y: -1 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: -5, y: -3 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
    });

    it('reflects gathering at scale 0 in every zoomed view', () => {
        // The berry stock is live — dropping it to 1 moves one berry's
        // scatter (the derivation reads the parent stock per call)
        const stock = island.inventory.cellStock(0, 0);
        const before = stock.berry ?? 0;
        stock.berry = 1;
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: -1, y: -1 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: -5, y: -3 }])).toEqual([]);
        stock.berry = before;
    });
});

describe('tileResources', () => {
    it('lists the tile deposits with their unlimited flag, in resource order', () => {
        // The meadow under Kiki carries unlimited dirt
        expect(tileResources(island.world.cellAt(0, 0)?.resources)).toEqual([
            { resource: 'dirt', count: 1, unlimited: true },
        ]);
        // The forest keeps a finite timber deposit
        expect(tileResources(island.world.cellAt(-3, -6)?.resources)).toEqual([
            { resource: 'wood', count: 2, unlimited: false },
        ]);
        // An iron lode carries stone AND iron, both finite
        expect(tileResources(island.world.cellAt(-5, 3)?.resources)).toEqual([
            { resource: 'stone', count: 1, unlimited: false },
            { resource: 'iron', count: 1, unlimited: false },
        ]);
        // Sea columns are bare
        expect(tileResources(island.world.cellAt(-18, -12)?.resources)).toEqual([]);
        expect(tileResources(undefined)).toEqual([]);
    });
});

describe('tileSummary', () => {
    it('assembles the full sand column under Ael at scale 0 (deposits + surface key)', () => {
        expect(tileSummary(island, [{ x: 17, y: -11 }])).toEqual({
            path: [{ x: 17, y: -11 }],
            x: 17,
            y: -11,
            biome: 'beach',
            // The unlimited sand deposit decides the tile's look
            surface: 'sand',
            height: 3,
            waterLevel: 3,
            passable: true,
            voxels: ['stone', 'soil', 'sand'],
            resources: [{ resource: 'sand', count: 1, unlimited: true }],
            // Scale-0 granularity: the ground lists its categories
            ground: [
                { category: 'food', label: 'Foods', count: 1 },
                { category: 'material', label: 'Materials', count: 1 },
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
        });
    });

    it('assembles a submerged shallows column with its fish stock', () => {
        expect(tileSummary(island, [{ x: -18, y: -12 }])).toEqual({
            path: [{ x: -18, y: -12 }],
            x: -18,
            y: -12,
            biome: 'shallows',
            surface: 'shallows',
            height: 2,
            waterLevel: 3,
            passable: false,
            voxels: ['soil', 'sand', 'water'],
            resources: [],
            ground: [{ category: 'food', label: 'Foods', count: 1 }],
            occupants: [],
        });
    });

    it('assembles an iron lode column with its deposits', () => {
        const summary = tileSummary(island, [{ x: -5, y: 3 }]);
        // The lode surfaces as iron even though stone surrounds it —
        // deposit priority puts the rare resource first
        expect(summary?.surface).toBe('iron');
        expect(summary?.biome).toBe('highland');
        expect(summary?.resources).toEqual([
            { resource: 'stone', count: 1, unlimited: false },
            { resource: 'iron', count: 1, unlimited: false },
        ]);
        // Stone and iron aggregate as materials; the flint is a tool —
        // its own category
        expect(summary?.ground).toEqual([
            { category: 'material', label: 'Materials', count: 2 },
            { category: 'tool', label: 'Tools', count: 1 },
        ]);
    });

    it('assembles a scale-1 subtile with its zoom lineage and fine residents', () => {
        const summary = tileSummary(island, [{ x: 17, y: -11 }, { x: 11, y: 3 }]);
        // The lineage rides on the summary — the full zoom path
        expect(summary?.path).toEqual([
            { x: 17, y: -11 },
            { x: 11, y: 3 },
        ]);
        // The subtile inherits the parent column (the beach's interior
        // ground) with the unlimited sand carried onto every subtile
        expect(summary?.biome).toBe('beach');
        expect(summary?.surface).toBe('sand');
        expect(summary?.height).toBe(3);
        expect(summary?.passable).toBe(true);
        expect(summary?.resources).toEqual([{ resource: 'sand', count: 1, unlimited: true }]);
        // Ael stands at this subtile (his fine spot)
        expect(summary?.occupants.map((o) => o.id)).toEqual(['actor-1']);
        // The coconut scattered to (11,−9), not here
        expect(summary?.ground).toEqual([]);
    });

    it('resolves to null outside the canvas or past the generated depth', () => {
        expect(tileSummary(island, [{ x: -19, y: 0 }])).toBeNull();
        expect(tileSummary(island, [{ x: 19, y: 0 }])).toBeNull();
        expect(tileSummary(island, [{ x: 0, y: 13 }])).toBeNull();
        expect(tileSummary(island, [{ x: 0, y: -13 }])).toBeNull();
        // The island generates one subtile level — depth 3 has no content
        expect(
            tileSummary(island, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]),
        ).toBeNull();
        expect(tileSummary(island, [])).toBeNull();
    });
});

describe('scaleView', () => {
    it('binds the live root world at scale 0', () => {
        const slice = scaleView(island, []);
        expect(slice?.canvas).toBe(island.world.canvas);
        // The root coordinates are the live coordinate space itself
        expect(slice?.coordinates.all().length).toBe(island.world.coordinates.count());
    });

    it('builds the zoomed slice: the parent sub-grid with fine-positioned residents', () => {
        const slice = scaleView(island, [{ x: 17, y: -11 }]);
        expect(slice?.canvas.width).toBe(37);
        expect(slice?.canvas.height).toBe(25);
        expect(slice?.canvas.cells.length).toBe(925);
        // Ael is the only resident of tile (17,−11) — drawn at his fine
        // spot, altitude preserved. The tile's ground items JOIN the slice
        // as canvas objects: the coconut stands at its scattered subtile
        // (11,−9), typed with the item id so the canvases draw its emoji.
        expect(slice?.coordinates.all()).toEqual([
            {
                id: 'actor-1',
                position: { x: 11, y: 3, z: 0 },
                kind: 'sentient',
                type: 'human',
                name: 'Ael',
                marker: 'A',
                state: 'well',
            },
            {
                id: 'ground:coconut:0',
                position: { x: 11, y: -9, z: 0 },
                kind: 'item',
                type: 'coconut',
                name: 'Coconut',
            },
        ]);
    });

    it('keeps the canvas objects and the inspector lists in exact agreement', () => {
        // Every ground unit the slice draws lands where the scale-1 Tile
        // Inspector's derivation counts it — the berry subtile of the
        // meadow holds exactly the berry the board shows there
        const slice = scaleView(island, [{ x: 0, y: 0 }]);
        const berries = slice?.coordinates.all().filter((entry) => entry.type === 'berry');
        expect(berries?.map((entry) => [entry.position.x, entry.position.y])).toEqual([
            [-1, -1],
            [-5, -3],
        ]);
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: -1, y: -1 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: -5, y: -3 }])).toEqual([
            { item: 'berry', count: 1 },
        ]);
        // …and subtile (0,0) holds nothing — the inspector and board agree
        expect(tileGround(island, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toEqual([]);
    });

    it('scatters deeper views consistently with the inspector recursion', () => {
        // A depth-2 island: the sea tile's sub-grid opens again — the fish
        // unit that landed at (−4,−10) at scale 1 is the only item entering
        // that board, scattered once more inside it
        const deep = createIslandWorld({ seed: 7, terrain: { subtiles: 2 } });
        const slice = scaleView(deep, [{ x: -18, y: -12 }, { x: -4, y: -10 }]);
        const fish = slice?.coordinates.all().filter((entry) => entry.type === 'fish');
        expect(fish?.length).toBe(1);
        const spot = (fish as Array<{ position: { x: number; y: number } }>)[0].position;
        // The board object and the inspector recursion agree exactly: the
        // unit stands at the subtile the derivation counts it in
        expect(tileGround(deep, [{ x: -18, y: -12 }, { x: -4, y: -10 }, { x: spot.x, y: spot.y }])).toEqual([
            { item: 'fish', count: 1 },
        ]);
        // Any other subtile of that board is bare
        expect(tileGround(deep, [{ x: -18, y: -12 }, { x: -4, y: -10 }, { x: 0, y: 0 }])).toEqual(
            spot.x === 0 && spot.y === 0 ? [{ item: 'fish', count: 1 }] : [],
        );
    });

    it('resolves to null past the generated depth', () => {
        expect(scaleView(island, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBeNull();
    });
});
