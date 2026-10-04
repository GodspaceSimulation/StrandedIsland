// The seabirds environment plugin — the only engine residents that travel
// the Z axis.
//
// Castaways cannot fly or dig (their Z is clamped to the ground plane, see
// engine/world relocate + @godspace/core `grounded`), but gulls move through
// full 3D space: they perch on the ground plane (Z = 0), take off to a
// cruise altitude (Z 1..ceiling), drift up and down while gliding, and land
// again. Bird positions live in the world's coordinate system (the 3D
// spatial record from @godspace/core) with kind 'bird' — the ASCII canvas
// renders them from there, altitude as a superscript glyph.
//
// Birds never enter world.actors (no needs, no behavior loop) — and since
// the engine's ground occupancy checks scan actors only, a perched bird
// never blocks a castaway's step. Everything is deterministic from the
// plugin's own keyed random stream.

import { position3, grounded, type Position3D } from '@godspace/core';
import { NEIGHBOR_OFFSETS } from '../../engine/world';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';

export type BirdsPluginOptions = {
    /** Chance per tick a flying bird lands. Default 0.2. */
    landChance?: number;
    /** Chance per tick a perched bird takes off. Default 0.4. */
    takeoffChance?: number;
    /** Chance per tick a flying bird's altitude drifts ±1. Default 0.25. */
    altitudeChance?: number;
    /** Cruise altitude ceiling in voxels above the ground plane. Default 3. */
    ceiling?: number;
};

/** A bird's record — position is read live from the coordinate space. */
export type BirdRecord = {
    id: string;
    name: string;
    marker: string;
    state: 'flying' | 'perched';
    position: Position3D;
};

export type BirdsPlugin = WorldPlugin & {
    /** Releases a bird above the island center at cruise altitude. */
    release(name?: string): BirdRecord;
    /** One bird's record, or undefined. */
    birdOf(id: string): BirdRecord | undefined;
    /** All released birds. */
    birds(): BirdRecord[];
};

/** Roster for default bird names. */
const BIRD_NAMES = ['Kiki', 'Jask', 'Tern', 'Sula'];

/** Cruise altitude a released bird starts at. */
const CRUISE_ALTITUDE = 2;

const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));

/** Direction word for a step delta — shared phrasing with the behavior plugin. */
const directionWord = (dx: number, dy: number): string => {
    const vertical = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
    const horizontal = dx > 0 ? 'east' : dx < 0 ? 'west' : '';
    if (!vertical) {
        return horizontal || 'nowhere';
    }
    return horizontal ? `${vertical}${horizontal}` : vertical;
};

export const birdsPlugin = (options: BirdsPluginOptions = {}): BirdsPlugin => {
    const landChance = options.landChance ?? 0.2;
    const takeoffChance = options.takeoffChance ?? 0.4;
    const altitudeChance = options.altitudeChance ?? 0.25;
    const ceiling = options.ceiling ?? 3;

    // Bird identity records — positions live in the coordinate space only
    const flock = new Map<string, { name: string; marker: string; state: 'flying' | 'perched' }>();
    let released = 0;

    // The world reference arrives with setup (release/tick need canvas + events)
    let world: PluginContext['world'] | null = null;

    /** Composes the public record: identity + live position from the space. */
    const recordOf = (id: string): BirdRecord | undefined => {
        const bird = flock.get(id);
        const position = world?.coordinates.positionOf(id);
        if (!bird || !position) {
            return undefined;
        }
        return { id, name: bird.name, marker: bird.marker, state: bird.state, position };
    };

    return {
        id: 'birds',
        label: 'Seabirds',

        setup: (context: PluginContext) => {
            world = context.world;
        },

        release: (name) => {
            if (!world) {
                throw new Error('birds plugin released before setup');
            }
            released = released + 1;
            const id = `bird-${released}`;
            const birdName = name ?? BIRD_NAMES[(released - 1) % BIRD_NAMES.length];
            const canvas = world.canvas;
            // Hover above the island center at cruise altitude (Z = 2)
            const position = position3(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                CRUISE_ALTITUDE,
            );
            flock.set(id, { name: birdName, marker: birdName.slice(0, 1), state: 'flying' });
            world.coordinates.place({
                id,
                position,
                kind: 'bird',
                name: birdName,
                marker: birdName.slice(0, 1),
                state: 'flying',
            });
            world.events.emit({
                kind: 'spawn',
                actorId: id,
                message: `${birdName} wheels above the island.`,
            });
            return recordOf(id) as BirdRecord;
        },

        birdOf: recordOf,

        birds: () => Array.from(flock.keys()).map((id) => recordOf(id) as BirdRecord),

        dispose: () => {
            // The environment is gone entirely: bird records leave the
            // coordinate space along with the plugin's own state
            if (world) {
                flock.forEach((_, id) => {
                    world?.coordinates.remove(id);
                });
            }
            flock.clear();
            released = 0;
            world = null;
        },

        tick: (context: PluginContext) => {
            if (!world) {
                return;
            }
            // Local alias — the null check above does not survive into the
            // forEach closure (mutable outer variable)
            const active = world;
            const canvas = active.canvas;
            const { coordinates, events } = active;

            flock.forEach((bird, id) => {
                const position = coordinates.positionOf(id);
                if (!position) {
                    return;
                }
                if (bird.state === 'flying') {
                    // Draw order is fixed: land roll → glide direction →
                    // altitude roll → altitude direction (deterministic)
                    if (context.random() < landChance) {
                        // Touch down onto the ground plane (Z = 0)
                        coordinates.move(id, grounded(position));
                        bird.state = 'perched';
                        active.retag(id, { state: 'perched' });
                        events.emit({
                            kind: 'move',
                            actorId: id,
                            message: `${bird.name} lands.`,
                        });
                        return;
                    }
                    const offset = NEIGHBOR_OFFSETS[Math.floor(context.random() * NEIGHBOR_OFFSETS.length)];
                    // Birds ignore passability — they glide over sea and land
                    const x = clamp(position.x + offset.dx, 0, canvas.width - 1);
                    const y = clamp(position.y + offset.dy, 0, canvas.height - 1);
                    let z = position.z;
                    if (context.random() < altitudeChance) {
                        z = clamp(z + (context.random() < 0.5 ? -1 : 1), 1, ceiling);
                    }
                    const dx = x - position.x;
                    const dy = y - position.y;
                    coordinates.move(id, position3(x, y, z));
                    // Clamped into the map edge → no plane movement happened
                    const verb = dx === 0 && dy === 0 ? 'hangs in the air' : `glides ${directionWord(dx, dy)}`;
                    events.emit({
                        kind: 'move',
                        actorId: id,
                        message: `${bird.name} ${verb}.`,
                    });
                    return;
                }
                // Perched: draw order is takeoff roll → takeoff altitude →
                // hop direction
                if (context.random() < takeoffChance) {
                    const z = 1 + Math.floor(context.random() * ceiling);
                    coordinates.move(id, position3(position.x, position.y, z));
                    bird.state = 'flying';
                    active.retag(id, { state: 'flying' });
                    events.emit({
                        kind: 'move',
                        actorId: id,
                        message: `${bird.name} takes off.`,
                    });
                    return;
                }
                // Hop one step along the ground plane (gulls float — any
                // in-bounds cell goes, sea included)
                const offset = NEIGHBOR_OFFSETS[Math.floor(context.random() * NEIGHBOR_OFFSETS.length)];
                const x = clamp(position.x + offset.dx, 0, canvas.width - 1);
                const y = clamp(position.y + offset.dy, 0, canvas.height - 1);
                const dx = x - position.x;
                const dy = y - position.y;
                coordinates.move(id, grounded(position3(x, y)));
                events.emit({
                    kind: 'move',
                    actorId: id,
                    message: `${bird.name} hops ${directionWord(dx, dy)}.`,
                });
            });
        },
    };
};
