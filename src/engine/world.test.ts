// Tests for the World container (engine/world.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld, NEIGHBOR_OFFSETS } from './world';
import type { WorldPlugin } from './plugin';
import type { Actor } from './types';

describe('createWorld', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const buildActor = (overrides: Partial<Actor> = {}): Actor => ({
        id: 'actor-1',
        name: 'Ael',
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
        const world = createWorld({ plugins: [makePlugin('first'), makePlugin('second')] });
        expect(world.step()).toBe(1);
        expect(order).toEqual(['first', 'second']);
        expect(world.ticker.elapsed()).toBe(10);
    });

    it('spawn registers the actor and logs to the event bus', () => {
        const world = createWorld();
        const actor = world.spawn(buildActor({ position: position3(3, 2) }));
        expect(world.actors.get('actor-1')).toBe(actor);
        // The coordinate record carries the full display facet
        expect(world.coordinates.entryOf('actor-1')).toEqual({
            id: 'actor-1',
            position: { x: 3, y: 2, z: 0 },
            kind: 'castaway',
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

    it('cellAt resolves row-major cells and enforces bounds', () => {
        const world = createWorld();
        world.canvas = {
            width: 2,
            height: 2,
            cells: [
                { x: 0, y: 0, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
                { x: 1, y: 0, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
                { x: 0, y: 1, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
                { x: 1, y: 1, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
            ],
        };
        expect(world.cellAt(1, 0)?.x).toBe(1);
        expect(world.cellAt(1, 0)?.y).toBe(0);
        expect(world.cellAt(0, 1)?.x).toBe(0);
        expect(world.cellAt(0, 1)?.y).toBe(1);
        expect(world.cellAt(-1, 0)).toBeUndefined();
        expect(world.cellAt(2, 0)).toBeUndefined();
        expect(world.cellAt(0, 2)).toBeUndefined();
        expect(world.inBounds(1, 1)).toBe(true);
        expect(world.inBounds(2, 1)).toBe(false);
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
        world.canvas = {
            width: 1,
            height: 2,
            cells: [
                { x: 0, y: 0, voxels: [], height: 0, waterLevel: 0, biome: 'ocean', passable: false },
                { x: 0, y: 1, voxels: [], height: 0, waterLevel: 0, biome: 'beach', passable: true },
            ],
        };
        expect(world.landCells().map((cell) => cell.y)).toEqual([1]);
    });

    it('realtime play/pause/speed delegate to the ticker', () => {
        const world = createWorld();
        world.play();
        expect(world.running()).toBe(true);
        vi.advanceTimersByTime(1000);
        // Default speed 2 tps
        expect(world.ticker.ticks()).toBe(2);
        world.pause();
        expect(world.running()).toBe(false);
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
});
