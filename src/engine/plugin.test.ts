// Tests for the plugin registry (engine/plugin.ts).

import { describe, it, expect, vi } from 'vitest';
import { createPluginRegistry } from './plugin';
import { createWorld } from './world';
import type { WorldPlugin } from './plugin';

describe('createPluginRegistry', () => {
    const buildWorld = () => createWorld({ seed: 5 });

    it('runs setup on add', () => {
        const world = buildWorld();
        const setup = vi.fn();
        world.plugins.add({ id: 'p1', setup });
        expect(setup).toHaveBeenCalledTimes(1);
        // Context carries the world
        expect(setup.mock.calls[0][0].world).toBe(world);
    });

    it('rejects duplicate ids (no double setup)', () => {
        const world = buildWorld();
        const setup = vi.fn();
        world.plugins.add({ id: 'same', setup });
        world.plugins.add({ id: 'same', setup });
        expect(setup).toHaveBeenCalledTimes(1);
        expect(world.plugins.list().length).toBe(1);
    });

    it('remove runs dispose and drops the plugin', () => {
        const world = buildWorld();
        const dispose = vi.fn();
        world.plugins.add({ id: 'p1', dispose });
        world.plugins.remove('p1');
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(world.plugins.has('p1')).toBe(false);
        // Removing an absent plugin is a no-op
        world.plugins.remove('p1');
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('clear disposes newest → oldest', () => {
        const world = buildWorld();
        const order: string[] = [];
        world.plugins.add({ id: 'a', dispose: () => order.push('a') });
        world.plugins.add({ id: 'b', dispose: () => order.push('b') });
        world.plugins.add({ id: 'c', dispose: () => order.push('c') });
        world.plugins.clear();
        expect(order).toEqual(['c', 'b', 'a']);
        expect(world.plugins.list().length).toBe(0);
    });

    it('context.random is persistent per plugin (not re-seeded per tick)', () => {
        const world = buildWorld();
        const plugin: WorldPlugin = {
            id: 'streamer',
            tick: (context) => {
                // Draw one value per tick and stash it
                (plugin as any).draws.push(context.random());
            },
        };
        (plugin as any).draws = [];
        world.plugins.add(plugin);
        world.step();
        world.step();
        world.step();
        // Three distinct advancing values — a fresh stream every tick would
        // have replayed the same first value three times
        expect((plugin as any).draws.length).toBe(3);
        expect(new Set((plugin as any).draws).size).toBe(3);
    });

    it('same seed + id → same stream for a given plugin', () => {
        const draws: number[] = [];
        const build = () => {
            const target = createWorld({ seed: 9 });
            target.plugins.add({
                id: 'probe',
                setup: (context) => draws.push(context.random()),
            });
            return target;
        };
        build();
        build();
        // Two separate worlds, same seed + plugin id → identical first draw
        expect(draws[0]).toBe(draws[1]);
    });
});
