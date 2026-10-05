// Tests for the island world adapter (engine/world.ts) — the distribution's
// half of the @godspace/core engine contract. The generic engine surface
// (registry, coordinates, clock, sub-stepping, the fine ladder) is tested in
// packages/godspace/core src/engine; what is tested here is what the adapter
// ADDS: the canvas holder (and the board binding it provides), the cell
// lookups, the actor registry alias and the island narrative.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld, NEIGHBOR_OFFSETS, TICK_MINUTES } from './world';
import type { Actor, TerrainCell } from './types';

describe('createWorld (island adapter)', () => {
    // The AUTO loop needs rAF + performance faked (see @godspace/core
    // src/engine/ticker.test.ts)
    beforeEach(() => {
        vi.useFakeTimers({
            toFake: [
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'Date',
                'requestAnimationFrame',
                'cancelAnimationFrame',
                'performance',
            ],
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const buildActor = (overrides: Partial<Actor> = {}): Actor => ({
        id: 'actor-1',
        name: 'Ael',
        // The stock castaway: a sentient of the human race
        kind: 'sentient',
        type: 'human',
        position: position3(0, 0),
        marker: 'A',
        condition: 'well',
        ...overrides,
    });

    it('starts with an empty canvas, no actors, seed default 1', () => {
        const world = createWorld();
        expect(world.seed).toBe(1);
        expect(world.canvas).toEqual({ width: 0, height: 0, cells: [] });
        expect(world.actors.size).toBe(0);
        expect(world.ticker.ticks()).toBe(0);
        // The 3D spatial record of the world starts empty
        expect(world.coordinates.count()).toBe(0);
    });

    it('the time-per-tick rule: one world minute per tick', () => {
        expect(TICK_MINUTES).toBe(1);
        expect(createWorld().ticker.tickSize()).toBe(1);
        // One step = one world minute
        const world = createWorld({ tickSize: 1 });
        world.step();
        expect(world.ticker.elapsed()).toBe(1);
    });

    it('installs plugins at creation and setup runs against the dressed world', () => {
        const setup = vi.fn();
        const world = createWorld({ seed: 3, plugins: [{ id: 'p', setup }] });
        expect(setup).toHaveBeenCalledTimes(1);
        expect(world.plugins.has('p')).toBe(true);
        // The plugin context world IS the adapter world (canvas surface on)
        expect(setup.mock.calls[0][0].world).toBe(world);
    });

    it('spawn registers the actor, mirrors the condition facet and logs the narrative', () => {
        const world = createWorld();
        const actor = world.spawn(buildActor({ position: position3(3, 2) }));
        expect(world.actors.get('actor-1')).toBe(actor);
        // The coordinate record carries the full display facet — the
        // kind/type taxonomy rides along with name, marker and the
        // condition (the actor's `condition` IS the display `state`)
        expect(world.coordinates.entryOf('actor-1')).toEqual({
            id: 'actor-1',
            position: { x: 3, y: 2, z: 0 },
            kind: 'sentient',
            type: 'human',
            name: 'Ael',
            marker: 'A',
            state: 'well',
        });
        const log = world.events.log();
        expect(log.length).toBe(1);
        expect(log[0]).toEqual({
            id: 1,
            tick: 0,
            time: 0,
            kind: 'spawn',
            message: 'Ael washes ashore.',
            actorId: 'actor-1',
        });
    });

    it('despawn removes the actor and logs the narrative', () => {
        const world = createWorld();
        world.spawn(buildActor());
        world.despawn('actor-1');
        expect(world.actors.size).toBe(0);
        // The spatial record leaves with the actor
        expect(world.coordinates.count()).toBe(0);
        expect(world.events.log()[1]).toMatchObject({ kind: 'despawn', message: 'Ael is no more.' });
        // Unknown id is a silent no-op
        world.despawn('ghost');
        expect(world.events.log().length).toBe(2);
    });

    it('relocate updates the actor record and the coordinate record together', () => {
        const world = createWorld();
        world.spawn(buildActor({ position: position3(1, 1) }));
        world.relocate('actor-1', position3(4, 5, 0));
        expect(world.actors.get('actor-1')?.position).toEqual({ x: 4, y: 5, z: 0 });
        expect(world.coordinates.positionOf('actor-1')).toEqual({ x: 4, y: 5, z: 0 });
        // Unknown actor is a silent no-op
        world.relocate('ghost', position3(9, 9));
        expect(world.coordinates.positionOf('ghost')).toBeUndefined();
    });

    it('cellAt resolves centered row-major cells and enforces bounds', () => {
        // Synthetic 3×3 canvas in CENTERED coordinates: cells run −1 … +1
        // on both axes; storage is row-major from the top-left (−1, −1)
        const cell = (x: number, y: number): TerrainCell => ({
            x,
            y,
            voxels: [],
            height: 0,
            waterLevel: 0,
            biome: 'ocean',
            passable: false,
            resources: {},
        });
        const world = createWorld();
        world.canvas = {
            width: 3,
            height: 3,
            cells: [
                cell(-1, -1),
                cell(0, -1),
                cell(1, -1),
                cell(-1, 0),
                cell(0, 0),
                cell(1, 0),
                cell(-1, 1),
                cell(0, 1),
                cell(1, 1),
            ],
        };
        // The canvas middle is the origin
        expect(world.cellAt(0, 0)?.x).toBe(0);
        expect(world.cellAt(0, 0)?.y).toBe(0);
        // Corners and axes
        expect(world.cellAt(-1, -1)?.x).toBe(-1);
        expect(world.cellAt(-1, -1)?.y).toBe(-1);
        expect(world.cellAt(1, -1)?.x).toBe(1);
        expect(world.cellAt(0, 1)?.x).toBe(0);
        expect(world.cellAt(0, 1)?.y).toBe(1);
        expect(world.cellAt(1, 1)?.y).toBe(1);
        // Anything beyond ±half is out of bounds
        expect(world.cellAt(-2, 0)).toBeUndefined();
        expect(world.cellAt(2, 0)).toBeUndefined();
        expect(world.cellAt(0, 2)).toBeUndefined();
        expect(world.cellAt(0, -2)).toBeUndefined();
        expect(world.inBounds(1, 1)).toBe(true);
        expect(world.inBounds(-1, -1)).toBe(true);
        expect(world.inBounds(2, 1)).toBe(false);
        expect(world.inBounds(1, -2)).toBe(false);
    });

    it('actorAt finds the actor at an exact 3D position (Z defaults to ground)', () => {
        const world = createWorld();
        world.spawn(buildActor({ position: position3(3, 2) }));
        expect(world.actorAt(3, 2)?.id).toBe('actor-1');
        // Explicit ground level matches too
        expect(world.actorAt(3, 2, 0)?.id).toBe('actor-1');
        // Another Z level of the same column is empty for actors
        expect(world.actorAt(3, 2, 1)).toBeUndefined();
        expect(world.actorAt(0, 0)).toBeUndefined();
    });

    it('landCells filters to passable cells', () => {
        const world = createWorld();
        // Synthetic 1×3 canvas (odd) in centered coordinates: y runs −1 … +1
        world.canvas = {
            width: 1,
            height: 3,
            cells: [
                { x: 0, y: -1, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false, resources: {} },
                { x: 0, y: 0, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false, resources: {} },
                { x: 0, y: 1, voxels: [], height: 0, waterLevel: 0, biome: 'beach', passable: true, resources: {} },
            ],
        };
        expect(world.landCells().map((cell) => cell.y)).toEqual([1]);
    });

    it('realtime play/pause delegate to the ticker (AUTO — as fast as possible)', () => {
        const world = createWorld();
        world.play();
        expect(world.running()).toBe(true);
        vi.advanceTimersByTime(1000);
        // The AUTO loop races — 62 animation frames × the 100-step per-frame
        // cap = 6200 steps in one fake second, no per-second throttle
        expect(world.ticker.ticks()).toBe(6200);
        world.pause();
        expect(world.running()).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(world.ticker.ticks()).toBe(6200);
    });

    it('NEIGHBOR_OFFSETS lists 8 directions clockwise from north (from the engine core)', () => {
        expect(NEIGHBOR_OFFSETS).toEqual([
            { dx: 0, dy: -1 },
            { dx: 1, dy: -1 },
            { dx: 1, dy: 0 },
            { dx: 1, dy: 1 },
            { dx: 0, dy: 1 },
            { dx: -1, dy: 1 },
            { dx: -1, dy: 0 },
            { dx: -1, dy: -1 },
        ]);
    });

    it('the canvas IS the board — the fine ladder derives from it', () => {
        const world = createWorld({ seed: 7 });
        // No canvas yet — the derivation centers on (0, 0)
        world.spawn(buildActor({ position: position3(3, 2) }));
        expect(world.subOf('actor-1')).toEqual({ x: 0, y: 0 });
        // Once the canvas is in, the sub-grid dims come from it (5×3 board:
        // the fine spots run x −2..2, y −1..1)
        world.canvas = centeredCanvas(5, 3);
        world.relocate('actor-1', position3(1, 0));
        expect(world.subOf('actor-1')).toEqual({ x: -1, y: 1 });
        // Fine steps flow across tile boundaries against the board
        world.spawn(buildActor({ position: position3(0, 0) }));
        expect(world.relocateFine('actor-1', 1, 0)).toBe(true);
        expect(world.actors.get('actor-1')?.position).toEqual({ x: 0, y: 0, z: 0 });
    });
});

/** A centered odd canvas of stub cells (the tile ladder runs on odd dims). */
const centeredCanvas = (width: number, height: number) => {
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const cell = (x: number, y: number): TerrainCell => ({
        x,
        y,
        voxels: [],
        height: 0,
        waterLevel: 0,
        biome: 'ocean',
        passable: false,
        resources: {},
    });
    const cells = [];
    for (let y = -halfY; y <= halfY; y++) {
        for (let x = -halfX; x <= halfX; x++) {
            cells.push(cell(x, y));
        }
    }
    return { width, height, cells };
};
