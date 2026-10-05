// Tests for the World container (engine/world.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld, NEIGHBOR_OFFSETS } from './world';
import type { WorldPlugin } from './plugin';
import type { Actor } from './types';

describe('createWorld', () => {
    // The AUTO loop needs rAF + performance faked (see engine/ticker.test.ts)
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

    it('installs plugins at creation and setup runs immediately', () => {
        const setup = vi.fn();
        const world = createWorld({ seed: 3, plugins: [{ id: 'p', setup }] });
        expect(setup).toHaveBeenCalledTimes(1);
        expect(world.plugins.has('p')).toBe(true);
    });

    it('step advances the ticker and runs plugin ticks in order', () => {
        const order: string[] = [];
        const makePlugin = (id: string): WorldPlugin => ({
            id,
            tick: () => {
                order.push(id);
            },
        });
        // One-minute steps keep the order array one pass long — the
        // sub-stepping test below covers the multi-minute batching
        const world = createWorld({ tickSize: 1, plugins: [makePlugin('first'), makePlugin('second')] });
        expect(world.step()).toBe(1);
        expect(order).toEqual(['first', 'second']);
        expect(world.ticker.elapsed()).toBe(1);
    });

    it('a step sub-steps its world-minutes — every plugin tick hook covers one minute', () => {
        const calls: string[] = [];
        const world = createWorld({
            tickSize: 3,
            plugins: [
                {
                    id: 'counter',
                    tick: () => {
                        calls.push('tick');
                    },
                },
            ],
        });
        // One 3-minute step = 3 tick hook calls (one per world-minute)
        world.step();
        expect(calls).toEqual(['tick', 'tick', 'tick']);
        expect(world.ticker.elapsed()).toBe(3);
        // And three 1-minute steps make the same three calls
        const minuteWorld = createWorld({
            tickSize: 1,
            plugins: [
                {
                    id: 'counter',
                    tick: () => {
                        calls.push('tick');
                    },
                },
            ],
        });
        minuteWorld.step();
        minuteWorld.step();
        minuteWorld.step();
        expect(calls).toEqual(['tick', 'tick', 'tick', 'tick', 'tick', 'tick']);
    });

    it('spawn registers the actor and logs to the event bus', () => {
        const world = createWorld();
        const actor = world.spawn(buildActor({ position: position3(3, 2) }));
        expect(world.actors.get('actor-1')).toBe(actor);
        // The coordinate record carries the full display facet — the
        // kind/type taxonomy rides along with name, marker and state
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

    it('despawn removes the actor and logs', () => {
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
        // Unknown entity is a silent no-op
        world.relocate('ghost', position3(9, 9));
        expect(world.coordinates.positionOf('ghost')).toBeUndefined();
    });

    it('retag updates the display facet of a coordinate record', () => {
        const world = createWorld();
        world.spawn(buildActor());
        world.retag('actor-1', { state: 'weak' });
        expect(world.coordinates.entryOf('actor-1')?.state).toBe('weak');
        expect(world.actors.get('actor-1')?.position).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('cellAt resolves centered row-major cells and enforces bounds', () => {
        // Synthetic 3×3 canvas in CENTERED coordinates: cells run −1 … +1
        // on both axes; storage is row-major from the top-left (−1, −1)
        const cell = (x: number, y: number) => ({
            x,
            y,
            voxels: [],
            height: 0,
            waterLevel: 0,
            biome: 'ocean',
            passable: false,
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
                { x: 0, y: -1, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
                { x: 0, y: 0, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
                { x: 0, y: 1, voxels: [], height: 0, waterLevel: 0, biome: 'beach', passable: true },
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

    it('NEIGHBOR_OFFSETS lists 8 directions clockwise from north', () => {
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

    // ── Fine positions — the recursive tile ladder (scale +1) ────────────────

    it('subOf derives a stable fine spot from seed + id + parent tile', () => {
        // No canvas yet — the derivation centers on (0, 0)
        const bare = createWorld();
        bare.spawn(buildActor({ position: position3(3, 2) }));
        expect(bare.subOf('actor-1')).toEqual({ x: 0, y: 0 });
        expect(bare.subOf('ghost')).toBeUndefined();

        // With a canvas: the spot keys off the entity AND its parent tile —
        // the same entity in the same tile always stands at the same spot
        const world = createWorld({ seed: 7 });
        world.canvas = centeredCanvas(5, 3);
        world.spawn(buildActor({ position: position3(1, 0) }));
        const first = world.subOf('actor-1');
        expect(first).toEqual({ x: -1, y: 1 });
        // Re-reading is stable
        expect(world.subOf('actor-1')).toEqual(first);
        // Moving the parent re-spots the entity inside the new tile
        world.relocate('actor-1', position3(2, 0));
        expect(world.subOf('actor-1')).toEqual({ x: 1, y: 0 });
        // A different entity in the SAME tile spots differently
        world.spawn(buildActor({ id: 'actor-2', name: 'Bram', position: position3(2, 0) }));
        expect(world.subOf('actor-2')).not.toEqual(world.subOf('actor-1'));
    });

    it('relocateFine walks the sub-grid and flows across tile boundaries', () => {
        const world = createWorld({ seed: 7 });
        // Synthetic 5×3 canvas (odd): sub-grids run x −2..2, y −1..1
        world.canvas = centeredCanvas(5, 3);
        world.spawn(buildActor({ position: position3(0, 0) }));
        // The derived spot inside tile (0, 0) — pinned by the seed
        expect(world.subOf('actor-1')).toEqual({ x: 1, y: -1 });
        // Interior steps stay inside the tile (the root never moves)
        expect(world.relocateFine('actor-1', 1, 0)).toBe(true);
        expect(world.actors.get('actor-1')?.position).toEqual({ x: 0, y: 0, z: 0 });
        expect(world.subOf('actor-1')).toEqual({ x: 2, y: -1 });
        // Stepping off the EAST edge wraps to the west edge of the NEIGHBOR
        // tile — the parent moves +1 with the entity (the world is
        // continuous: subtiles flow into the neighboring tile's subtiles)
        world.relocateFine('actor-1', 1, 0);
        expect(world.actors.get('actor-1')?.position).toEqual({ x: 1, y: 0, z: 0 });
        expect(world.subOf('actor-1')).toEqual({ x: -2, y: -1 });
        // And back west across the boundary restores the exact prior state
        world.relocateFine('actor-1', -1, 0);
        expect(world.actors.get('actor-1')?.position).toEqual({ x: 0, y: 0, z: 0 });
        expect(world.subOf('actor-1')).toEqual({ x: 2, y: -1 });
        // Unknown entities and canvas-less worlds are rejected
        expect(world.relocateFine('ghost', 1, 0)).toBe(false);
        expect(createWorld().relocateFine('actor-1', 1, 0)).toBe(false);
    });

    it('relocateFine moves coordinates-only creatures too, keeping their Z', () => {
        const world = createWorld({ seed: 7 });
        world.canvas = centeredCanvas(5, 3);
        // A bird (not in the actor registry) hovering the tile at z 2
        world.coordinates.place({
            id: 'bird-1',
            position: position3(0, 0, 2),
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
        });
        expect(world.subOf('bird-1')).toEqual({ x: 1, y: -1 });
        // Interior step first, then off the south edge: the root moves one
        // tile south and the flight altitude rides along untouched
        world.relocateFine('bird-1', 0, 1);
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 0, y: 0, z: 2 });
        expect(world.subOf('bird-1')).toEqual({ x: 1, y: 0 });
        world.relocateFine('bird-1', 0, 2);
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 0, y: 1, z: 2 });
        expect(world.subOf('bird-1')).toEqual({ x: 1, y: -1 });
    });
});

/** A centered odd canvas of stub cells (the tile ladder runs on odd dims). */
const centeredCanvas = (width: number, height: number) => {
    const halfX = (width - 1) / 2;
    const halfY = (height - 1) / 2;
    const cell = (x: number, y: number) => ({
        x,
        y,
        voxels: [],
        height: 0,
        waterLevel: 0,
        biome: 'ocean',
        passable: false,
    });
    const cells = [];
    for (let y = -halfY; y <= halfY; y++) {
        for (let x = -halfX; x <= halfX; x++) {
            cells.push(cell(x, y));
        }
    }
    return { width, height, cells };
};
