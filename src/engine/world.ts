// The World — the container that ties everything together.
//
// A world owns:
//   canvas  — the island (a grid of voxel columns; built by the terrain plugin)
//   actors  — the stranded people (id → Actor map)
//   ticker  — the world clock (one step = tickSize minutes of world time)
//   events  — the world event bus / log
//   plugins — the swappable environment behaviour (see engine/plugin.ts)
//
// `step()` is the heartbeat: the ticker advances, then every installed plugin
// gets a `tick` hook call in registration order. Realtime play/pause/speed
// simply delegate to the ticker.

import { arrayEach } from '@presource/core';
import { createEventBus, type EventBus } from './events';
import { createPluginRegistry, type WorldPlugin } from './plugin';
import type { Actor, Canvas, TerrainCell } from './types';
import { createTicker, type Ticker, type TickerOptions } from './ticker';

export type WorldOptions = {
    /** Simulation seed — drives terrain generation and every plugin RNG. */
    seed?: number;
    /** Minutes of world time per tick. Default 10. */
    tickSize?: number;
    /** Plugins installed at creation, in tick order. */
    plugins?: WorldPlugin[];
    /** Ticker realtime options (speed in ticks/second). */
    ticker?: TickerOptions;
};

export type World = {
    /** Simulation seed everything deterministic hangs off. */
    seed: number;
    /** The island. Mutable — the terrain plugin (re)builds it in `setup`. */
    canvas: Canvas;
    /** All living actors by id. */
    actors: Map<string, Actor>;
    /** The world clock. */
    ticker: Ticker;
    /** World log / event bus. */
    events: EventBus;
    /** Plugin roster — add/remove at will. */
    plugins: ReturnType<typeof createPluginRegistry>;
    /** Advances one tick and runs every plugin's `tick` hook. Returns tick no. */
    step(): number;
    /** Realtime loop passthrough (ticker). */
    play(): void;
    pause(): void;
    running(): boolean;
    /** Adds an actor to the world (must already carry valid canvas coords). */
    spawn(actor: Actor): Actor;
    /** Removes an actor (marked 'gone', dropped from the registry). */
    despawn(actorId: string): void;
    /** The cell at grid coordinates, or undefined when out of bounds/empty. */
    cellAt(x: number, y: number): TerrainCell | undefined;
    /** Whether (x, y) is inside the canvas. */
    inBounds(x: number, y: number): boolean;
    /** The actor standing on (x, y), when any. */
    actorAt(x: number, y: number): Actor | undefined;
    /** All currently passable (dry) cells — used for spawn placement. */
    landCells(): TerrainCell[];
};

/** 4 cardinal + 4 diagonal neighbours, clockwise from north. */
export const NEIGHBOR_OFFSETS: Array<{ dx: number; dy: number }> = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
];

export const createWorld = (options: WorldOptions = {}): World => {
    const seed = options.seed ?? 1;

    // Canvas holder — the terrain plugin replaces the whole canvas in `setup`,
    // so lookups must read through the holder, not a stale local reference.
    const canvasHolder: { current: Canvas } = {
        current: { width: 0, height: 0, cells: [] },
    };

    const actors = new Map<string, Actor>();

    const ticker = createTicker({ tickSize: options.tickSize, speed: options.ticker?.speed });
    const events = createEventBus();

    const world: World = {
        seed,
        // Canvas accessor so the terrain plugin can swap the whole grid
        get canvas() {
            return canvasHolder.current;
        },
        set canvas(value: Canvas) {
            canvasHolder.current = value;
        },
        actors,
        ticker,
        events,
        plugins: null as unknown as ReturnType<typeof createPluginRegistry>,
        step: () => {
            const tick = ticker.step();
            // Plugins run in registration order — order matters (needs decay
            // before behavior decides, so agents react to fresh values)
            arrayEach(plugins.list(), ({ value: plugin }) => {
                // Block body so plugin tick return values can't short-circuit.
                // Context comes from the registry so each plugin keeps its
                // own persistent deterministic random stream.
                plugin.tick?.(plugins.context(plugin));
            });
            return tick;
        },
        play: () => ticker.play(),
        pause: () => ticker.pause(),
        running: () => ticker.running(),
        spawn: (actor) => {
            actors.set(actor.id, actor);
            events.emit({ kind: 'spawn', message: `${actor.name} washes ashore.`, actorId: actor.id });
            return actor;
        },
        despawn: (actorId) => {
            const actor = actors.get(actorId);
            if (!actor) {
                return;
            }
            actors.delete(actorId);
            events.emit({ kind: 'despawn', message: `${actor.name} is no more.`, actorId });
        },
        cellAt: (x, y) => {
            const grid = canvasHolder.current;
            if (y < 0 || y >= grid.height || x < 0 || x >= grid.width) {
                return undefined;
            }
            return grid.cells[y * grid.width + x];
        },
        inBounds: (x, y) => {
            const grid = canvasHolder.current;
            return x >= 0 && x < grid.width && y >= 0 && y < grid.height;
        },
        actorAt: (x, y) => {
            let found: Actor | undefined;
            // Block-bodied predicate so no early-return value short-circuits
            actors.forEach((candidate) => {
                if (candidate.x === x && candidate.y === y) {
                    found = candidate;
                }
            });
            return found;
        },
        landCells: () => canvasHolder.current.cells.filter((cell) => cell.passable),
    };

    // Plugin registry needs the world reference; create it after `world`.
    const plugins = createPluginRegistry(world);
    world.plugins = plugins;

    // The event bus stamps emitted events from the ticker
    events.bind(() => ({ tick: ticker.ticks(), time: ticker.elapsed() }));

    // The realtime loop must run the FULL world step (ticker + all plugin
    // ticks), not just the clock — bind the pulse before installing plugins
    // so play() behaves exactly like a manual world.step()
    ticker.bindPulse(() => {
        world.step();
    });

    // Install the requested plugins (their setup hooks run immediately)
    arrayEach(options.plugins ?? [], ({ value: plugin }) => {
        plugins.add(plugin);
    });

    return world;
};
