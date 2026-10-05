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
// `step()` is the heartbeat: the ticker advances (one step = `tickSize`
// minutes of world time — the view scale decides the step size), then the
// step's world-minutes are processed ONE MINUTE at a time — every installed
// plugin gets a `tick` hook call per world-minute, so all simulation logic
// lives at the smallest scale possible and a step behaves exactly like its
// minutes' worth of one-minute steps at every zoom level. Realtime
// play/pause simply delegate to the ticker's AUTO loop (as fast as the
// browser allows — no per-second cap).

import { arrayEach } from '@presource/core';
import {
    createCoordinateSystem,
    GROUND_LEVEL,
    subTileStep,
    type CoordinateSystem,
    type CoordinateFacet,
    type Position3D,
} from '@godspace/core';
import { createEventBus, type EventBus } from './events';
import { createPluginRegistry, type WorldPlugin } from './plugin';
import { randomKeyed } from './random';
import type { Actor, Canvas, TerrainCell } from './types';
import { createTicker, type Ticker } from './ticker';

export type WorldOptions = {
    /** Simulation seed — drives terrain generation and every plugin RNG. */
    seed?: number;
    /** Minutes of world time per tick. Default 10 (the scale-0 step time). */
    tickSize?: number;
    /** Plugins installed at creation, in tick order. */
    plugins?: WorldPlugin[];
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
    /** Advances one tick and runs every plugin's `tick` hook — once per
     * world-minute of the step (the smallest-scale sub-stepping). */
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
    /**
     * The entity's FINE position — where it stands inside the sub-grid of
     * the tile it occupies (the zoomed-in view of that tile, engine-wide
     * scale +1). Entities never explicitly fine-moved stand at a stable
     * spot derived from the world seed + entity id + parent tile; the
     * derivation needs no bookkeeping, so coarse moves (relocate) re-spot
     * the entity deterministically in its new tile.
     */
    subOf(entityId: string): { x: number; y: number } | undefined;
    /**
     * Continuous fine movement — the world flowing across its own
     * boundaries. Steps the entity `dx`/`dy` INSIDE its parent tile's
     * sub-grid; stepping off an edge wraps to the opposite edge of the
     * NEIGHBOR parent tile's sub-grid (the parent position moves with it —
     * @godspace/core subTileStep is the rule). Works for any coordinate
     * resident (castaways and coordinates-only creatures alike); flyers
     * keep their Z. `false` when the id is unknown or no canvas exists.
     */
    relocateFine(entityId: string, dx: number, dy: number): boolean;
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
    // Castaways are placed here at spawn (kind 'sentient', type 'human',
    // ground plane), birds and any other entity a plugin releases join the
    // same space with their own kind/type pair.
    const coordinates = createCoordinateSystem();

    // Fine positions — where each entity stands INSIDE the sub-grid of the
    // tile it occupies (the zoomed-in view of that tile). Only entities
    // that fine-moved at least once (relocateFine) are stored here:
    // everyone else derives a stable spot from world seed + entity id +
    // parent tile (deriveFine below), which keeps coarse moves (relocate)
    // bookkeeping-free — the derivation follows the new parent on its own.
    const finePositions = new Map<string, { x: number; y: number }>();

    // Derives an entity's fine spot inside its parent tile's sub-grid,
    // seeded by world seed + entity id + parent coordinates: the same
    // entity in the same tile always stands at the same fine spot (the
    // sub-grid dims equal the world grid's — the recursive tiling rule)
    const deriveFine = (entityId: string, root: Position3D): { x: number; y: number } => {
        const grid = canvasHolder.current;
        if (grid.width === 0 || grid.height === 0) {
            // No canvas yet (no terrain plugin) — the exact center
            return { x: 0, y: 0 };
        }
        const stream = randomKeyed(seed, `fine:${entityId}@${root.x},${root.y}`);
        const halfX = (grid.width - 1) / 2;
        const halfY = (grid.height - 1) / 2;
        return {
            x: Math.floor(stream() * grid.width) - halfX,
            y: Math.floor(stream() * grid.height) - halfY,
        };
    };

    const ticker = createTicker({ tickSize: options.tickSize });
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
            // ── Sub-stepping: the step's world-minutes run ONE MINUTE at a
            // time ── the simulation logic lives at the smallest scale
            // possible, so a step behaves exactly like its minutes' worth of
            // one-minute steps at every zoom level (a 100-minute scale −1
            // step holds the same 100 minutes of logic a scale +1 run would
            // spread over 100 steps). Plugins run in registration order —
            // order matters (needs decay before behavior decides, so agents
            // react to fresh values) — and every plugin tick hook covers
            // exactly ONE world-minute.
            const minutes = ticker.tickSize();
            arrayEach(Array.from({ length: minutes }, (_, index) => index), () => {
                // Block body so plugin tick return values can't short-circuit.
                // Context comes from the registry so each plugin keeps its
                // own persistent deterministic random stream.
                arrayEach(plugins.list(), ({ value: plugin }) => {
                    plugin.tick?.(plugins.context(plugin));
                });
            });
            return tick;
        },
        play: () => ticker.play(),
        pause: () => ticker.pause(),
        running: () => ticker.running(),
        spawn: (actor) => {
            actors.set(actor.id, actor);
            // The coordinate record carries the display facet the canvases
            // read — the kind/type taxonomy, name, marker and the live
            // condition
            coordinates.place({
                id: actor.id,
                position: actor.position,
                kind: actor.kind,
                type: actor.type,
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
            // …and any explicit fine spot goes with it (the derivation is
            // keyed by the id, so a respawned id would otherwise inherit it)
            finePositions.delete(actorId);
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
        subOf: (entityId) => {
            const override = finePositions.get(entityId);
            if (override) {
                return { ...override };
            }
            const root = coordinates.positionOf(entityId);
            return root ? deriveFine(entityId, root) : undefined;
        },
        relocateFine: (entityId, dx, dy) => {
            const grid = canvasHolder.current;
            if (grid.width === 0 || grid.height === 0) {
                return false;
            }
            const root = coordinates.positionOf(entityId);
            if (!root) {
                return false;
            }
            const override = finePositions.get(entityId);
            const sub = override ?? deriveFine(entityId, root);
            // The continuity rule (@godspace/core subTileStep): the fine
            // step wraps at the sub-grid's edges and reports the parent
            // tile it crossed — the world flows into the neighbor tile
            const step = subTileStep(grid.width, grid.height, sub.x, sub.y, dx, dy);
            const nextRoot: Position3D = {
                x: root.x + step.parent.dx,
                y: root.y + step.parent.dy,
                z: root.z,
            };
            // The actor registry and the spatial record stay in sync —
            // the same write path world.relocate uses, but WITHOUT the
            // fresh fine-spot derivation: a boundary flow must keep its
            // wrapped position, not re-spot the entity
            const actor = actors.get(entityId);
            if (actor) {
                actor.position = nextRoot;
            }
            coordinates.move(entityId, nextRoot);
            finePositions.set(entityId, { x: step.x, y: step.y });
            return true;
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
