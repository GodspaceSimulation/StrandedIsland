// Tests for the scenario composition root (scenario/island.ts).

import { describe, it, expect } from 'vitest';
import { createIslandWorld } from './island';

describe('createIslandWorld', () => {
    it('assembles all stock plugins in tick order (packages + environment)', () => {
        const handle = createIslandWorld({ seed: 7 });
        expect(handle.world.plugins.list().map((plugin) => plugin.id)).toEqual([
            'island-terrain',
            'inventory',
            'needs',
            'relationship',
            'behavior',
            'birds',
            // The @godspace/canvas representation plugins, loaded by the engine
            'ascii-canvas',
            'unicode-canvas',
            'data-canvas',
        ]);
        expect(handle.world.ticker.tickSize()).toBe(10);
        // The canvas exists after terrain setup — the default 37×25 island
        // in centered coordinates ((0, 0) the exact middle)
        expect(handle.world.canvas).toEqual({
            width: 37,
            height: 25,
            cells: expect.any(Array),
        });
    });

    it('spawns the cast at the island edge with a starting kit', () => {
        const handle = createIslandWorld({ seed: 7 });
        // The ship wrecked on the coast — every castaway comes ashore on the
        // outermost dry ring (ranked by rim closeness, spread by stride).
        // Captured reference positions for the default 37×25 island.
        expect(Array.from(handle.world.actors.values()).map((actor) => ({
            id: actor.id,
            name: actor.name,
            position: actor.position,
        }))).toEqual([
            { id: 'actor-1', name: 'Ael', position: { x: 17, y: -11, z: 0 } },
            { id: 'actor-2', name: 'Bram', position: { x: 14, y: 2, z: 0 } },
            { id: 'actor-3', name: 'Cove', position: { x: -11, y: -4, z: 0 } },
            { id: 'actor-4', name: 'Dune', position: { x: -8, y: 3, z: 0 } },
        ]);
        // Every landing spot is dry land, ranked from the outermost dry ring
        // inward (Ael's pick — edge[0] — IS the outermost land cell: no dry
        // cell ranks closer to the rim on this island)
        Array.from(handle.world.actors.values()).forEach((actor) => {
            expect(handle.world.cellAt(actor.position.x, actor.position.y)?.passable).toBe(true);
        });
        // The outermost dry ring's exact rim score, ranked first
        const rimScore = (cell: { x: number; y: number }) =>
            Math.max(Math.abs(cell.x) / 18, Math.abs(cell.y) / 12);
        const land = handle.world.landCells();
        const outermost = land
            .slice()
            .sort((left, right) => rimScore(right) - rimScore(left))[0];
        expect(outermost).toMatchObject({ x: 17, y: -11 });
        expect(rimScore(outermost)).toBeCloseTo(0.9444444444444444, 12);
        // Every castaway sits on the ground plane (z = 0) in the coordinate
        // record — the 3D spatial record holds the whole world
        expect(
            Array.from(handle.world.actors.keys()).map((id) => handle.world.coordinates.positionOf(id)?.z),
        ).toEqual([0, 0, 0, 0]);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1 });
        expect(handle.inventory.of('actor-4')).toEqual({ berry: 2, flint: 1 });
    });

    it('releases a seabird wheeling above the island center at cruise altitude', () => {
        const handle = createIslandWorld({ seed: 7 });
        const bird = handle.birds.birdOf('bird-1');
        expect(bird).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
            // World coordinates are centered — the island center IS (0, 0);
            // cruise altitude z = 2
            position: { x: 0, y: 0, z: 2 },
        });
        // The bird lives in the 3D spatial record with kind 'bird'
        expect(handle.world.coordinates.entryOf('bird-1')).toEqual({
            id: 'bird-1',
            position: { x: 0, y: 0, z: 2 },
            kind: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
        });
        // Birds are not castaways — they stay out of the actor registry
        expect(handle.world.actors.has('bird-1')).toBe(false);
        // Release log line lands after the four castaway spawns
        expect(handle.world.events.log().map((event) => event.message)).toEqual([
            'Ael washes ashore.',
            'Bram washes ashore.',
            'Cove washes ashore.',
            'Dune washes ashore.',
            'Kiki wheels above the island.',
        ]);
    });

    it('actorCount caps the cast', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        expect(Array.from(handle.world.actors.keys())).toEqual(['actor-1', 'actor-2']);
    });

    it('runs: actors wander once the ticker advances', () => {
        const handle = createIslandWorld({ seed: 7 });
        handle.world.step();
        expect(handle.world.ticker.ticks()).toBe(1);
        // Every castaway moved (wander path) + Kiki's first glide
        expect(handle.world.events.log().filter((event) => event.kind === 'move').length).toBe(5);
    });

    it('plugin toggles swap environment behaviour out entirely', () => {
        // No behavior plugin → actors stand still forever
        const still = createIslandWorld({ seed: 7, plugins: { behavior: false } });
        const before = Array.from(still.world.actors.values()).map((actor) => ({ ...actor.position }));
        for (let index = 0; index < 5; index++) {
            still.world.step();
        }
        const after = Array.from(still.world.actors.values()).map((actor) => ({ ...actor.position }));
        expect(after).toEqual(before);
        expect(still.world.plugins.has('behavior')).toBe(false);

        // Only terrain → a bare canvas world with no actors at all
        const bare = createIslandWorld({
            seed: 7,
            plugins: {
                inventory: false,
                needs: false,
                relationship: false,
                behavior: false,
                birds: false,
                ascii: false,
                unicode: false,
                data: false,
            },
            actorCount: 0,
        });
        expect(bare.world.plugins.list().map((plugin) => plugin.id)).toEqual(['island-terrain']);
        expect(bare.world.canvas.width).toBe(37);


        // Birds off → no bird in the spatial record, no birds plugin
        const grounded = createIslandWorld({ seed: 7, plugins: { birds: false } });
        expect(grounded.world.plugins.has('birds')).toBe(false);
        expect(grounded.world.coordinates.count()).toBe(4);
        expect(grounded.birds.birds()).toEqual([]);

        // ASCII canvas off → the ascii sibling is gone from the roster and
        // its frame is empty (unicode + data still render)
        const unseen = createIslandWorld({ seed: 7, plugins: { ascii: false } });
        expect(unseen.world.plugins.has('ascii-canvas')).toBe(false);
        expect(unseen.ascii.frame()).toEqual({ columns: 0, rows: 0, tiles: [] });
        expect(unseen.world.plugins.has('unicode-canvas')).toBe(true);
        expect(unseen.world.plugins.has('data-canvas')).toBe(true);

        // Unicode + data canvases off → only the ascii sibling renders
        const plain = createIslandWorld({ seed: 7, plugins: { unicode: false, data: false } });
        expect(plain.world.plugins.has('unicode-canvas')).toBe(false);
        expect(plain.world.plugins.has('data-canvas')).toBe(false);
        expect(plain.unicode.frame()).toEqual({ columns: 0, rows: 0, tiles: [] });
        expect(plain.data.frame()).toEqual({ tables: [] });
    });

    it('the ascii canvas frame mirrors the world: tiles, glyphs and altitude', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.ascii.frame();
        // One tile per island cell, row-major (37×25 = 925)
        expect(frame.columns).toBe(37);
        expect(frame.rows).toBe(25);
        expect(frame.tiles.length).toBe(925);
        // Ael stands on the shore at (17,−11): tile 1×37+35 = 72 carries his
        // grounded glyph
        expect(frame.tiles[72].glyphs).toEqual([
            { id: 'actor-1', glyph: 'A', color: '#5cb85c', elevation: 0, kind: 'castaway', state: 'well' },
        ]);
        expect(frame.tiles[72].title).toBe('beach · height 3 · stone / soil / sand · Ael · well');
        // Kiki wheels at the center (0,0): tile 12×37+18 = 462 carries the
        // flying glyph with her altitude superscript
        expect(frame.tiles[462].glyphs).toEqual([
            { id: 'bird-1', glyph: 'K', color: '#7ec8e3', elevation: 2, kind: 'bird', state: 'flying' },
        ]);
        expect(frame.tiles[462].title).toBe(
            'meadow · height 5 · stone / stone / stone / soil / grass · Kiki · flying · z 2',
        );
    });

    it('the unicode canvas frame mirrors the ascii world with emoji glyphs', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.unicode.frame();
        // Same frame model as the ascii canvas — one tile per cell
        expect(frame.columns).toBe(37);
        expect(frame.rows).toBe(25);
        expect(frame.tiles.length).toBe(925);
        // Ael renders as the castaway emoji at his shore position (tile 72)
        expect(frame.tiles[72].glyphs).toEqual([
            { id: 'actor-1', glyph: '🧍', color: '#5cb85c', elevation: 0, kind: 'castaway', state: 'well' },
        ]);
        // Kiki renders as the bird emoji with her altitude superscript
        expect(frame.tiles[462].glyphs).toEqual([
            { id: 'bird-1', glyph: '🐦', color: '#7ec8e3', elevation: 2, kind: 'bird', state: 'flying' },
        ]);
        // Empty sea tiles carry the terrain emoji
        expect(frame.tiles[0].glyphs).toEqual([]);
        expect(frame.tiles[0].symbol).toBe('🐚');
        // The palette exposes the terrain symbols for the legend
        expect(handle.unicode.palette().symbols.ocean).toBe('🌊');
        expect(handle.unicode.palette().symbols.beach).toBe('🏖');
    });

    it('the data canvas frame renders plain tables of the live world', () => {
        const handle = createIslandWorld({ seed: 7 });
        const frame = handle.data.frame();
        // Three tables: entity positions, terrain census, canvas overview
        expect(frame.tables.map((table) => table.title)).toEqual(['Positions', 'Terrain', 'Canvas']);
        // Positions: bird first (kind order), then the cast in id order —
        // exact centered coordinates and facets per row
        expect(frame.tables[0].headers).toEqual(['id', 'kind', 'name', 'state', 'x', 'y', 'z']);
        expect(frame.tables[0].rows).toEqual([
            ['bird-1', 'bird', 'Kiki', 'flying', 0, 0, 2],
            ['actor-1', 'castaway', 'Ael', 'well', 17, -11, 0],
            ['actor-2', 'castaway', 'Bram', 'well', 14, 2, 0],
            ['actor-3', 'castaway', 'Cove', 'well', -11, -4, 0],
            ['actor-4', 'castaway', 'Dune', 'well', -8, 3, 0],
        ]);
        // Terrain census: cell counts per biome, alphabetical
        expect(frame.tables[1].rows).toEqual([
            ['beach', 438],
            ['forest', 90],
            ['highland', 9],
            ['meadow', 138],
            ['ocean', 103],
            ['shallows', 147],
        ]);
        // Canvas overview: the 37×25 frame
        expect(frame.tables[2].rows).toEqual([
            ['width', 37],
            ['height', 25],
            ['cells', 925],
        ]);
    });

    it('exposes the plugin handles for god-side control', () => {
        const handle = createIslandWorld({ seed: 7, actorCount: 2 });
        // The god can force an exchange between the two castaways
        const ael = handle.world.actors.get('actor-1');
        const bram = handle.world.actors.get('actor-2');
        const forced = handle.inventory.exchange(ael, bram, { flint: 1 }, { berry: 1 });
        expect(forced).toBe(true);
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 3 });
        expect(handle.inventory.of('actor-2')).toEqual({ berry: 1, flint: 2 });
        expect(handle.relationship.relation('actor-1', 'actor-2')).toBe(0);
        // …and inspect needs directly
        expect(handle.needs.of('actor-1')).toEqual({ hunger: 20, thirst: 20, energy: 100 });
    });
});
