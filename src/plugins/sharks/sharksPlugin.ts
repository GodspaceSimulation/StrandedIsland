// The sharks environment plugin — water creatures that swim in from beyond
// the edge of the world and can vanish past it again.
//
// Sharks are coordinate-space residents (kind 'creature' / type 'shark',
// state 'swimming') but never world.actors — no needs, no behavior loop, the
// same registry pattern as the birds plugin (plugins/birds/birdsPlugin.ts).
// They are bound to the WATER: they spawn on rim water cells (the sea is the
// world's edge for them), swim from water cell to water cell — never beaching
// themselves, an impassable (dry) neighbor cell is not a step — and each
// minute one roll may send a shark sweeping back past the edge. Things come
// in too, like the birds: one arrival roll per tick spawns a fresh shark on
// a rim water cell while the population stays under the cap.
//
// Everything is deterministic from the plugin's own keyed random stream.

import { arrayEach } from '@presource/core';
import {
    NEIGHBOR_OFFSETS,
    position3,
    type PluginContext,
    type WorldPlugin,
    type Position3D,
} from '@godspace/core';
import type { World } from '../../engine/world';

export type SharksPluginOptions = {
    /** Chance per world-minute a shark swims in past the edge. Default 0.008. */
    arriveChancePerMinute?: number;
    /** Chance per world-minute a shark leaves past the edge. Default 0.01. */
    leaveChancePerMinute?: number;
    /** Population cap. Default 2. */
    maxSharks?: number;
};

/** One shark's record — position is read live from the coordinate space. */
export type SharkRecord = {
    id: string;
    name: string;
    marker: string;
    position: Position3D;
};

export type SharksPlugin = WorldPlugin<World> & {
    /** Places one shark at a rim water cell (the god-view manual release). */
    release(name?: string): SharkRecord;
    /** One shark's record, or undefined. */
    sharkOf(id: string): SharkRecord | undefined;
    /** All live sharks. */
    sharks(): SharkRecord[];
};

/** Roster for default shark names. */
const SHARK_NAMES = ['Finn', 'Mako', 'Reef', 'Chum'];

/**
 * Canvas type-glyph for sharks — the unicode/svg canvases resolve an entry's
 * TYPE through their type map, so shark entries (type 'shark') draw the fin
 * emoji. Merged into the canvas palettes by the scenario (scenario/island.ts)
 * next to ITEM_TYPE_GLYPHS.
 */
export const SHARK_TYPE_GLYPH: Record<string, string> = { shark: '🦈' };

/** Direction word for a step delta — shared phrasing with the behavior and
 * birds plugins (a local copy, like birds keeps). */
const directionWord = (dx: number, dy: number): string => {
    const vertical = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
    const horizontal = dx > 0 ? 'east' : dx < 0 ? 'west' : '';
    if (!vertical) {
        return horizontal || 'nowhere';
    }
    return horizontal ? `${vertical}${horizontal}` : vertical;
};

export const sharksPlugin = (options: SharksPluginOptions = {}): SharksPlugin => {
    // Chances are per world-minute — every tick hook call covers exactly one
    // world-minute (engine/world.ts sub-steps), so the rolls apply directly
    const arriveChance = options.arriveChancePerMinute ?? 0.008;
    const leaveChance = options.leaveChancePerMinute ?? 0.01;
    const maxSharks = options.maxSharks ?? 2;

    // Shark identity records — positions live in the coordinate space only
    const shoal = new Map<string, { name: string; marker: string }>();
    let released = 0;

    // The world + the plugin's persistent random stream arrive with setup —
    // release() draws its rim pick from the SAME stream the tick rolls use
    // (the registry caches one context per plugin id, engine/plugin.ts)
    let world: PluginContext<World>['world'] | null = null;
    let random: PluginContext<World>['random'] | null = null;

    /** Composes the public record: identity + live position from the space. */
    const recordOf = (id: string): SharkRecord | undefined => {
        const shark = shoal.get(id);
        const position = world?.coordinates.positionOf(id);
        if (!shark || !position) {
            return undefined;
        }
        return { id, name: shark.name, marker: shark.marker, position };
    };

    /**
     * The rim cells that are WATER (impassable — ocean/shallows columns,
     * engine/types.ts TerrainCell), row-major over the canvas cells — the sea
     * horizon sharks spawn on and vanish past.
     */
    const rimWaterCells = (canvas: {
        width: number;
        height: number;
        cells: Array<{ x: number; y: number; passable: boolean }>;
    }): Array<{ x: number; y: number }> => {
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const rim: Array<{ x: number; y: number }> = [];
        arrayEach(canvas.cells, ({ value: cell }) => {
            const onRim = Math.abs(cell.x) === halfX || Math.abs(cell.y) === halfY;
            if (onRim && !cell.passable) {
                rim.push({ x: cell.x, y: cell.y });
            }
        });
        return rim;
    };

    /** Spawns one shark at an explicit cell: monotonic id (despawned ids are
     * never reused), roster name, full facet into the coordinate space (never
     * into world.actors). */
    const spawnShark = (
        active: NonNullable<PluginContext<World>['world']>,
        cell: { x: number; y: number },
        name?: string,
    ): SharkRecord => {
        released = released + 1;
        const id = `shark-${released}`;
        const sharkName = name ?? SHARK_NAMES[(released - 1) % SHARK_NAMES.length];
        const marker = sharkName.slice(0, 1);
        shoal.set(id, { name: sharkName, marker });
        active.coordinates.place({
            id,
            position: position3(cell.x, cell.y),
            // The two-level taxonomy: a shark is a creature of type shark
            kind: 'creature',
            type: 'shark',
            name: sharkName,
            marker,
            state: 'swimming',
        });
        active.events.emit({
            kind: 'spawn',
            actorId: id,
            message: `${sharkName} fins in from the open sea.`,
        });
        return recordOf(id) as SharkRecord;
    };

    return {
        id: 'sharks',
        label: 'Sharks',

        setup: (context: PluginContext<World>) => {
            world = context.world;
            random = context.random;
        },

        release: (name) => {
            if (!world || !random) {
                throw new Error('sharks plugin released before setup');
            }
            const active = world;
            const stream = random;
            const rim = rimWaterCells(active.canvas);
            // Deterministic pick from the plugin's own stream; a canvas with
            // no rim water (no sea at all) falls back to the center column
            const cell = rim.length > 0 ? rim[Math.floor(stream() * rim.length)] : { x: 0, y: 0 };
            return spawnShark(active, cell, name);
        },

        sharkOf: recordOf,

        sharks: () => Array.from(shoal.keys()).map((id) => recordOf(id) as SharkRecord),

        dispose: () => {
            // The environment is gone entirely: shark records leave the
            // coordinate space along with the plugin's own state
            if (world) {
                shoal.forEach((_, id) => {
                    world?.coordinates.remove(id);
                });
            }
            shoal.clear();
            released = 0;
            world = null;
            random = null;
        },

        tick: (context: PluginContext<World>) => {
            if (!world) {
                return;
            }
            // Local alias — the null check above does not survive into the
            // arrayEach closures (mutable outer variable)
            const active = world;
            const { coordinates, events } = active;
            const stream = context.random;

            // ── Fixed roll order ── ONE shoal-level arrival roll comes FIRST
            // (before any per-shark roll — deterministic), then the per-shark
            // rolls run in id order. The roster is snapshotted before the
            // arrival: a shark that arrives this minute starts rolling next
            // minute.
            const order = Array.from(shoal.keys());
            if (stream() < arriveChance && shoal.size < maxSharks) {
                const rim = rimWaterCells(active.canvas);
                if (rim.length > 0) {
                    spawnShark(active, rim[Math.floor(stream() * rim.length)]);
                }
            }

            arrayEach(order, ({ value: id }) => {
                const shark = shoal.get(id);
                const position = coordinates.positionOf(id);
                if (!shark || !position) {
                    return;
                }
                // Leave roll first — when it fires the shark swims off past
                // the edge of the world and is gone
                if (stream() < leaveChance) {
                    coordinates.remove(id);
                    shoal.delete(id);
                    events.emit({
                        kind: 'despawn',
                        actorId: id,
                        message: `${shark.name} sweeps past the edge of the world and vanishes.`,
                    });
                    return;
                }
                // Swim: a random in-bounds WATER neighbor — sharks never
                // beach themselves (an impassable/dry cell is not a step);
                // a cell with no water neighbor → the shark stays put this
                // minute (no roll, no event)
                const halfX = (active.canvas.width - 1) / 2;
                const halfY = (active.canvas.height - 1) / 2;
                const water: Array<{ dx: number; dy: number; x: number; y: number }> = [];
                arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                    const x = position.x + offset.dx;
                    const y = position.y + offset.dy;
                    const inBounds = x >= -halfX && x <= halfX && y >= -halfY && y <= halfY;
                    if (inBounds && active.cellAt(x, y)?.passable === false) {
                        water.push({ dx: offset.dx, dy: offset.dy, x, y });
                    }
                });
                if (water.length === 0) {
                    return;
                }
                const step = water[Math.floor(stream() * water.length)];
                coordinates.move(id, position3(step.x, step.y));
                events.emit({
                    kind: 'move',
                    actorId: id,
                    message: `${shark.name} glides ${directionWord(step.dx, step.dy)}.`,
                });
            });
        },
    };
};
