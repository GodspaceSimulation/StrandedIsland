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
    it('reads the non-zero cell stock — fish for sea, dirt + berries for meadow', () => {
        expect(tileGround(island, -18, -12)).toEqual([{ item: 'fish', count: 1 }]);
        // Deposits seed before the biome food, so the unlimited dirt lists
        // first
        expect(tileGround(island, 0, 0)).toEqual([
            { item: 'dirt', count: 1 },
            { item: 'berry', count: 2 },
        ]);
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
    it('assembles the full sand column under Ael (deposits + surface key)', () => {
        expect(tileSummary(island, 17, -11)).toEqual({
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
            ground: [
                { item: 'sand', count: 1 },
                { item: 'coconut', count: 1 },
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
        expect(tileSummary(island, -18, -12)).toEqual({
            x: -18,
            y: -12,
            biome: 'shallows',
            surface: 'shallows',
            height: 2,
            waterLevel: 3,
            passable: false,
            voxels: ['soil', 'sand', 'water'],
            resources: [],
            ground: [{ item: 'fish', count: 1 }],
            occupants: [],
        });
    });

    it('assembles an iron lode column with its deposits', () => {
        const summary = tileSummary(island, -5, 3);
        // The lode surfaces as iron even though stone surrounds it —
        // deposit priority puts the rare resource first
        expect(summary?.surface).toBe('iron');
        expect(summary?.biome).toBe('highland');
        expect(summary?.resources).toEqual([
            { resource: 'stone', count: 1, unlimited: false },
            { resource: 'iron', count: 1, unlimited: false },
        ]);
        expect(summary?.ground).toEqual([
            { item: 'stone', count: 1 },
            { item: 'iron', count: 1 },
            { item: 'flint', count: 1 },
        ]);
    });

    it('resolves to null outside the canvas', () => {
        expect(tileSummary(island, -19, 0)).toBeNull();
        expect(tileSummary(island, 19, 0)).toBeNull();
        expect(tileSummary(island, 0, 13)).toBeNull();
        expect(tileSummary(island, 0, -13)).toBeNull();
    });
});
