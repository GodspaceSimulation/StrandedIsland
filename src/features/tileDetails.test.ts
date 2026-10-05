// Tests for the tile inspection logic (features/tileDetails.ts).
//
// All expectations come from the deterministic seed-7 island (default 37×25,
// centered coordinates — see scenario/island.test.ts). The cast comes ashore
// at the island edge (shipwreck rule):
//   (17,−11) beach   h3  voxels [stone, soil, sand]  stock {coconut:1}  Ael stands here
//   (−10,−11) beach  h3  voxels [stone, soil, sand]  stock {coconut:1, shell:1}
//   (−18,−12) shallows h2 voxels [soil, sand, water] stock {fish:1}
//   (0,0)     meadow  h5  voxels [stone ×3, soil, grass]  stock {berry:2}  Kiki flies at z 2
//   (−3,−6)   forest  h5  voxels [stone ×3, soil, grass, forest] stock {berry:1, wood:2}

import { describe, it, expect } from 'vitest';
import { createIslandWorld } from '../scenario/island';
import { voxelRuns, voxelSummary, tileOccupants, tileGround, tileSummary, occupantLine } from './tileDetails';

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
    it('lists the castaway standing on a tile, linked to the actor registry', () => {
        expect(tileOccupants(island, 17, -11)).toEqual([
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
        expect(tileOccupants(island, 0, 0)).toEqual([
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
        expect(tileOccupants(island, 17, -11).map((occupant) => occupant.id)).toEqual([
            'actor-1',
            'bird-x',
        ]);
        island.world.coordinates.remove('bird-x');
    });

    it('returns nothing for an empty column', () => {
        expect(tileOccupants(island, -10, -11)).toEqual([]);
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
    it('reads the non-zero cell stock — fish for sea, berries for meadow', () => {
        expect(tileGround(island, -18, -12)).toEqual([{ item: 'fish', count: 1 }]);
        expect(tileGround(island, 0, 0)).toEqual([{ item: 'berry', count: 2 }]);
    });
});

describe('tileSummary', () => {
    it('assembles the full beach column under Ael', () => {
        expect(tileSummary(island, 17, -11)).toEqual({
            x: 17,
            y: -11,
            biome: 'beach',
            height: 3,
            waterLevel: 3,
            passable: true,
            voxels: ['stone', 'soil', 'sand'],
            ground: [{ item: 'coconut', count: 1 }],
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
        expect(tileSummary(island, -18, -12)).toEqual({
            x: -18,
            y: -12,
            biome: 'shallows',
            height: 2,
            waterLevel: 3,
            passable: false,
            voxels: ['soil', 'sand', 'water'],
            ground: [{ item: 'fish', count: 1 }],
            occupants: [],
        });
    });

    it('resolves to null outside the canvas', () => {
        expect(tileSummary(island, -19, 0)).toBeNull();
        expect(tileSummary(island, 19, 0)).toBeNull();
        expect(tileSummary(island, 0, 13)).toBeNull();
        expect(tileSummary(island, 0, -13)).toBeNull();
    });
});
