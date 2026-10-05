// The World — the container that ties everything together.
//
// A world owns:
//   canvas      — the island (a grid of voxel columns; built by the terrain
//                 plugin). Coordinates are CENTERED: (0, 0) is the dead
//                 center of the canvas, so grid sizes must be odd — cells
//                 run from −half to +half on both axes, and storage stays
//                 row-major from the top-left corner cell
//   coordinates — the 3D spatial record of the entire world (from
//                 @godspace/core): every entity's X, Y, Z position lives
//                 here, castaways clamped to the ground plane (Z = 0) and
//                 birds travelling the Z axis
//   actors      — the stranded people (id → Actor map)
//   ticker      — the world clock (one step = tickSize minutes of world time)
//   events      — the world event bus / log
//   plugins     — the swappable environment behaviour (see engine/plugin.ts)
//
// `step()` is the heartbeat: the ticker advances, then every installed plugin
// gets a `tick` hook call in registration order. Realtime play/pause/speed
// simply delegate to the ticker.

import { arrayEach } from '@presource/core';
import { createCoordinateSystem, GROUND_LEVEL, type CoordinateSystem, type CoordinateFacet, type Position3D } from '@godspace/core';
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
    /** The 3D spatial record of the entire world (@godspace/core). */
    coordinates: CoordinateSystem;
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
    /** Updates an actor's 3D position (registry + coordinate record stay in sync). */
    relocate(actorId: string, position: Position3D): void;
    /** Updates an entity's display state in the coordinate record (condition, flight state…). */
    retag(entityId: string, facet: CoordinateFacet): void;
    /** The cell at grid coordinates, or undefined when out of bounds/empty. */
    cellAt(x: number, y: number): TerrainCell | undefined;
    /** Whether (x, y) is inside the canvas. */
    inBounds(x: number, y: number): boolean;
    /** The actor standing at an exact 3D position (Z defaults to the ground plane). */
    actorAt(x: number, y: number, z?: number): Actor | undefined;
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

    // The 3D spatial record — the single position registry of the world.
    // Castaways are placed here at spawn (kind 'castaway', ground plane),
    // birds and any other entity a plugin releases join the same space.
    const coordinates = createCoordinateSystem();

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
        coordinates,
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
            // The coordinate record carries the display facet the ascii
            // canvas reads — kind, name, marker and the live condition
            coordinates.place({
                id: actor.id,
                position: actor.position,
                kind: 'castaway',
                name: actor.name,
                marker: actor.marker,
                state: actor.condition,
            });
            events.emit({ kind: 'spawn', message: `${actor.name} washes ashore.`, actorId: actor.id });
            return actor;
        },
        despawn: (actorId) => {
            const actor = actors.get(actorId);
            if (!actor) {
                return;
            }
            actors.delete(actorId);
            // The spatial record leaves the world with the actor
            coordinates.remove(actorId);
            events.emit({ kind: 'despawn', message: `${actor.name} is no more.`, actorId });
        },
        relocate: (actorId, position) => {
            const actor = actors.get(actorId);
            if (!actor) {
                return;
            }
            actor.position = { ...position };
            coordinates.move(actorId, actor.position);
        },
        retag: (entityId, facet) => {
            coordinates.relabel(entityId, facet);
        },
        cellAt: (x, y) => {
            const grid = canvasHolder.current;
            // World coordinates are CENTERED: (0, 0) is the canvas middle
            // (odd grid sizes only), so valid x/y run −half … +half
            const halfX = (grid.width - 1) / 2;
            const halfY = (grid.height - 1) / 2;
            if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
                return undefined;
            }
            // Row-major storage from the top-left corner cell (−halfX, −halfY)
            return grid.cells[(y + halfY) * grid.width + (x + halfX)];
        },
        inBounds: (x, y) => {
            const grid = canvasHolder.current;
            // Centered bounds: |x| ≤ halfX, |y| ≤ halfY (odd dims → exact)
            const halfX = (grid.width - 1) / 2;
            const halfY = (grid.height - 1) / 2;
            return x >= -halfX && x <= halfX && y >= -halfY && y <= halfY;
        },
        actorAt: (x, y, z = GROUND_LEVEL) => {
            let found: Actor | undefined;
            // Block-bodied predicate so no early-return value short-circuits.
            // Z filters the column: a bird gliding at Z 2 above a cell never
            // blocks a castaway walking the ground beneath it.
            actors.forEach((candidate) => {
                if (
                    candidate.position.x === x &&
                    candidate.position.y === y &&
                    candidate.position.z === z
                ) {
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
