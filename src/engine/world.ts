// The island world adapter — where StrandedIsland's entities meet the
// @godspace/core engine.
//
// The GENERIC engine core lives in @godspace/core (src/engine): the world
// container (3D coordinate record + entity registry + ticker + event bus +
// plugin roster + the fine-movement ladder), generic over the entities a
// distribution inserts into it. THIS file is the distribution's half of the
// contract:
//
//   entities  — the Actor type (engine/types.ts): the stranded people,
//               each with its own condition vocabulary. Inserted into the
//               engine world at spawn (the facetOf hook maps the actor's
//               `condition` onto the coordinate record's display `state`).
//   canvas    — the island grid (engine/types.ts Canvas of TerrainCell),
//               owned by the terrain plugin and swapped whole through the
//               `canvas` setter. The core engine only needs the BOARD dims
//               (the fine ladder resolves against them — the `board` hook);
//               the full canvas surface attaches here for the plugins and
//               the @godspace/canvas representation to read.
//   narrative — the spawn/despawn event lines ("washes ashore", "is no
//               more") are the distribution's vocabulary, passed through
//               the engine's message hooks.
//
// The adapter result is the same `World` the rest of the codebase has always
// consumed — the generic engine world PLUS the island surface (canvas
// holder, cell lookups, the `actors` registry alias). `NEIGHBOR_OFFSETS`
// (the 8-direction neighbourhood every walker shares) now comes from the
// engine core and is re-exported here for the plugins' deep imports.
//
// TIME PER TICK — the distribution's own pacing rule: ONE WORLD MINUTE per
// tick (TICK_MINUTES). The view scale is a pure view ladder now (it no
// longer re-times the clock): the simulation always runs at the Scale-0
// pace, one world minute per tick, and the island view (Scale 1) simply
// shows where the entities are.

import {
    GROUND_LEVEL,
    NEIGHBOR_OFFSETS as CORE_NEIGHBOR_OFFSETS,
    createWorld as createEngineWorld,
    type EngineEntity,
    type World as EngineWorld,
    type WorldPlugin,
} from '@godspace/core';
import type { Actor, Canvas, TerrainCell } from './types';

export { GROUND_LEVEL };

/** The 8-direction neighbourhood — re-exported from the engine core. */
export const NEIGHBOR_OFFSETS = CORE_NEIGHBOR_OFFSETS;

/**
 * TIME PER TICK — StrandedIsland's pacing rule: one tick carries ONE world
 * minute. Every step of the simulation advances the world clock by exactly
 * this much (the distance rule — one Scale-0 tile move per tick — lives in
 * scenario/island.ts TRAVEL_MINUTES_PER_TILE).
 */
export const TICK_MINUTES = 1;

export type WorldOptions = {
    /** Simulation seed — drives terrain generation and every plugin RNG. */
    seed?: number;
    /** World minutes per tick. Default TICK_MINUTES (one world minute). */
    tickSize?: number;
    /** Plugins installed at creation, in tick order. */
    plugins?: WorldPlugin<World>[];
};

/** The island world — the generic engine world plus the island surface. */
export type World = EngineWorld<Actor> & {
    /**
     * The island. Mutable — the terrain plugin (re)builds it in `setup`.
     * Also the BOARD the fine ladder resolves against.
     */
    canvas: Canvas;
    /** All living actors by id (the engine world's entity registry). */
    actors: Map<string, Actor>;
    /** The cell at grid coordinates, or undefined when out of bounds/empty. */
    cellAt(x: number, y: number): TerrainCell | undefined;
    /** Whether (x, y) is inside the canvas. */
    inBounds(x: number, y: number): boolean;
    /** The actor standing at an exact 3D position (Z defaults to the ground plane). */
    actorAt(x: number, y: number, z?: number): Actor | undefined;
    /** All currently passable (dry) cells — used for spawn placement. */
    landCells(): TerrainCell[];
    /**
     * The mounted structure-blocking hook (see StructureBlocker) — the
     * construction plugin assigns it at setup and clears it at dispose.
     * Null: no completed structures exist to block anything.
     */
    structures: StructureBlocker | null;
};

/**
 * The structure-blocking hook — the construction plugin mounts it at setup
 * (plugins/construction) so the Scale-0 movement rules can refuse stepping
 * ONTO a completed footprint's cells (the usable GATE cell excepted — see
 * the plugin's doorway rule). Null when no construction plugin is mounted:
 * the fine ground is all free, the pre-construction behavior.
 */
export type StructureBlocker = {
    /** Whether the fine spot (sx, sy) inside the tile at (tileX, tileY) is walled off. */
    blocksFineSpot(tileX: number, tileY: number, sx: number, sy: number): boolean;
};

/** Canvas holder — the terrain plugin replaces the whole canvas in `setup`,
 * so lookups must read through the holder, not a stale local reference. */
type CanvasHolder = { current: Canvas };

export const createWorld = (options: WorldOptions = {}): World => {
    const canvasHolder: CanvasHolder = {
        current: { width: 0, height: 0, cells: [] },
    };

    // The generic engine world — entities, coordinates, clock, events,
    // plugins and the fine ladder — created with the island's hooks.
    // Plugins install AFTER the attach below (via world.plugins.add), so
    // their setup hooks run against the fully dressed world.
    const engine = createEngineWorld<Actor>({
        seed: options.seed,
        tickSize: options.tickSize ?? TICK_MINUTES,
        plugins: [],
        // The island canvas IS the board: the fine ladder (Scale 0, the
        // tile interiors) resolves its sub-grid dims from it
        board: () => canvasHolder.current,
        // The coordinate record's display state is the actor's condition.
        // The profile rides along — the sex lands on the coordinate facet so
        // the @godspace/canvas unicode/svg canvases draw the gendered
        // human emoji (scenario/island.ts glyphOf resolvers)
        facetOf: (actor) => ({
            kind: actor.kind,
            type: actor.type,
            name: actor.name,
            marker: actor.marker,
            state: actor.condition,
            sex: actor.profile.sex,
        }),
        // The island narrative — the cast washes ashore
        spawnMessage: (actor) => `${actor.name} washes ashore.`,
        despawnMessage: (actor) => `${actor.name} is no more.`,
        // The island surface — canvas holder, registry alias, cell lookups.
        // Runs BEFORE the plugins install (their setup hooks see everything).
        attach: (surface) => {
            const world = surface as unknown as World;

            // The canvas holder accessors — the terrain plugin swaps the
            // whole grid through the setter
            Object.defineProperty(world, 'canvas', {
                get: () => canvasHolder.current,
                set: (value: Canvas) => {
                    canvasHolder.current = value;
                },
            });

            // The actor registry — the engine world's entity registry, under
            // the distribution's name
            Object.defineProperty(world, 'actors', {
                get: () => world.entities,
            });

            // Centered row-major cell lookup: (0, 0) is the canvas middle
            // (odd grid sizes only), so valid x/y run −half … +half
            world.cellAt = (x, y) => {
                const grid = canvasHolder.current;
                const halfX = (grid.width - 1) / 2;
                const halfY = (grid.height - 1) / 2;
                if (y < -halfY || y > halfY || x < -halfX || x > halfX) {
                    return undefined;
                }
                // Row-major storage from the top-left corner cell (−halfX, −halfY)
                return grid.cells[(y + halfY) * grid.width + (x + halfX)];
            };

            world.inBounds = (x, y) => {
                const grid = canvasHolder.current;
                // Centered bounds: |x| ≤ halfX, |y| ≤ halfY (odd dims → exact)
                const halfX = (grid.width - 1) / 2;
                const halfY = (grid.height - 1) / 2;
                return x >= -halfX && x <= halfX && y >= -halfY && y <= halfY;
            };

            world.actorAt = (x, y, z = GROUND_LEVEL) => {
                let found: Actor | undefined;
                // Block-bodied predicate so no early-return value short-
                // circuits. Z filters the column: a bird gliding at Z 2 above
                // a cell never blocks a castaway walking the ground beneath it.
                world.entities.forEach((candidate) => {
                    if (
                        candidate.position.x === x &&
                        candidate.position.y === y &&
                        candidate.position.z === z
                    ) {
                        found = candidate;
                    }
                });
                return found;
            };

            world.landCells = () => canvasHolder.current.cells.filter((cell) => cell.passable);

            // The structure blocker starts unmounted — the construction
            // plugin swaps its hook in at setup (and back out at dispose)
            world.structures = null;
        },
    });

    const world = engine as unknown as World;

    // Install the requested plugins now that the surface is dressed (their
    // setup hooks run immediately, in tick order)
    (options.plugins ?? []).forEach((plugin) => {
        world.plugins.add(plugin);
    });

    return world;
};

// The engine entity vocabulary rides along for the adapter's consumers
export type { EngineEntity };
