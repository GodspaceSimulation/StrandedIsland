// Tests for the tile inspection logic (features/tileDetails.ts).
//
// All expectations come from the deterministic seed-7 island (see
// scenario/island.test.ts and the dump in App.test.tsx notes):
//   (6,0)  beach   h3  voxels [stone, soil, sand]     stock {coconut:1}    Ael stands here
//   (7,0)  beach   h3  voxels [stone, soil, sand]     stock {coconut:1, shell:1}
//   (0,0)  ocean   h0  voxels [sand, water, water, water] stock {fish:1}
//   (6,5)  forest  h6  voxels [stone ×4, soil, grass, forest] stock {berry:1, wood:2}  Kiki flies at z 2
//   (5,6)  forest  h5  voxels [stone ×3, soil, grass, forest] stock {berry:1, wood:2}  Dune stands here

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
        expect(voxelRuns(['sand', 'water', 'water', 'water'])).toEqual([
            { kind: 'sand', count: 1 },
            { kind: 'water', count: 3 },
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
        expect(tileOccupants(island, 6, 0)).toEqual([
            {
                id: 'actor-1',
                name: 'Ael',
                kind: 'castaway',
                state: 'well',
                z: 0,
                actorId: 'actor-1',
            },
        ]);
    });

    it('lists birds as occupants too — every living thing is an actor', () => {
        // Kiki wheels at (6,5) at cruise altitude z 2, NOT in world.actors —
        // but she is a living thing and shows up in her column
        expect(tileOccupants(island, 6, 5)).toEqual([
            {
                id: 'bird-1',
                name: 'Kiki',
                kind: 'bird',
                state: 'flying',
                z: 2,
                // Birds stay out of the actor registry — view-only residents
                actorId: undefined,
            },
        ]);
    });

    it('orders a mixed column grounded-first by ascending Z', () => {
        // Park a second bird right above Ael at z 1: column (6,0) then holds
        // Ael (z 0) before the flyer (z 1)
        island.world.coordinates.place({
            id: 'bird-x',
            position: { x: 6, y: 0, z: 1 },
            kind: 'bird',
            name: 'Jask',
            marker: 'J',
            state: 'flying',
        });
        expect(tileOccupants(island, 6, 0).map((occupant) => occupant.id)).toEqual([
            'actor-1',
            'bird-x',
        ]);
        island.world.coordinates.remove('bird-x');
    });

    it('returns nothing for an empty column', () => {
        expect(tileOccupants(island, 7, 0)).toEqual([]);
    });
});

describe('occupantLine', () => {
    it('reads grounded residents without altitude and flyers with z', () => {
        expect(
            occupantLine({
                id: 'actor-1',
                name: 'Ael',
                kind: 'castaway',
                state: 'well',
                z: 0,
                actorId: 'actor-1',
            }),
        ).toBe('Ael — castaway · well');
        expect(
            occupantLine({
                id: 'bird-1',
                name: 'Kiki',
                kind: 'bird',
                state: 'flying',
                z: 2,
                actorId: undefined,
            }),
        ).toBe('Kiki — bird · flying · z 2');
    });
});

describe('tileGround', () => {
    it('reads the non-zero cell stock — fish for sea, berries/wood for forest', () => {
        expect(tileGround(island, 0, 0)).toEqual([{ item: 'fish', count: 1 }]);
        expect(tileGround(island, 6, 5)).toEqual([
            { item: 'berry', count: 1 },
            { item: 'wood', count: 2 },
        ]);
    });
});

describe('tileSummary', () => {
    it('assembles the full beach column under Ael', () => {
        expect(tileSummary(island, 6, 0)).toEqual({
            x: 6,
            y: 0,
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
                    kind: 'castaway',
                    state: 'well',
                    z: 0,
                    actorId: 'actor-1',
                },
            ],
        });
    });

    it('assembles a submerged ocean column with its fish stock', () => {
        expect(tileSummary(island, 0, 0)).toEqual({
            x: 0,
            y: 0,
            biome: 'ocean',
            height: 0,
            waterLevel: 3,
            passable: false,
            voxels: ['sand', 'water', 'water', 'water'],
            ground: [{ item: 'fish', count: 1 }],
            occupants: [],
        });
    });

    it('resolves to null outside the canvas', () => {
        expect(tileSummary(island, -1, 0)).toBeNull();
        expect(tileSummary(island, 12, 0)).toBeNull();
        expect(tileSummary(island, 0, 10)).toBeNull();
    });
});
