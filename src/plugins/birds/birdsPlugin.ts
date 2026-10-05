// The seabirds environment plugin — the only engine residents that travel
// the Z axis.
//
// Castaways cannot fly or dig (their Z is clamped to the ground plane, see
// engine/world relocate + @godspace/core `grounded`), but gulls move through
// full 3D space: they perch on the ground plane (Z = 0), take off, and drift
// through an altitude fade ladder while gliding. THE VANISHED HIGHER SCALE:
// this world only has scale 0 (the island) and scale 1 (tile interiors —
// scenario/island.ts anchors the ladder), so there is no scale 2. Altitude
// maps upward onto that ladder: a bird climbing to z ≥ ALTITUDE_CEILING would
// reach the nonexistent scale 2 and vanishes from the memory stack for good
// (despawned). Birds also FADE as they climb: BIRD_ALTITUDE_STATES runs the
// visible fade bands, and at z ≥ ALTITUDE_FADE_LIMIT (the ceiling − 2) the
// bird is fully invisible — it LEAVES the coordinate space (the memory-stack
// vanish at render level) while its flock record survives 'aloft' with a
// private last position; descending below the limit places it back in.
// Birds can ARRIVE too: over the sea rim at flying altitude, or dropping
// from the high air already aloft.
//
// Bird positions live in the world's coordinate system (the 3D spatial record
// from @godspace/core) with kind 'creature' / type 'bird' — the canvas
// plugins render them from there, altitude as a superscript glyph.
//
// Birds never enter world.actors (no needs, no behavior loop) — and since
// the engine's ground occupancy checks scan actors only, a perched bird
// never blocks a castaway's step. Everything is deterministic from the
// plugin's own keyed random stream.

import { arrayEach } from '@presource/core';
import { position3, grounded, type Position3D } from '@godspace/core';
import { NEIGHBOR_OFFSETS } from '../../engine/world';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';

export type BirdsPluginOptions = {
    /** Chance per world-minute a flying bird lands. Default 0.02. */
    landChancePerMinute?: number;
    /** Chance per world-minute a perched bird takes off. Default 0.05. */
    takeoffChancePerMinute?: number;
    /** Chance per world-minute a flying or aloft bird's altitude drifts ±1. Default 0.03. */
    altitudeChancePerMinute?: number;
    /** Chance per world-minute a new bird arrives (sea rim or high air). Default 0.01. */
    arriveChancePerMinute?: number;
    /** Flock population cap — arrivals stop once reached. Default 4. */
    maxBirds?: number;
};

/**
 * A bird's record. State is the MECHANICAL state — the fade band is display
 * state and lives in the coordinate facet (the retag), derivable from the
 * live position's z. Position is read live from the coordinate space; aloft
 * birds (out of the space) report their private last position instead.
 */
export type BirdRecord = {
    id: string;
    name: string;
    marker: string;
    state: 'flying' | 'perched' | 'aloft';
    position: Position3D;
};

export type BirdsPlugin = WorldPlugin & {
    /** Releases a bird above the island center at cruise altitude. */
    release(name?: string): BirdRecord;
    /** One bird's record, or undefined. */
    birdOf(id: string): BirdRecord | undefined;
    /** All live birds (aloft ones included, with their last position). */
    birds(): BirdRecord[];
};

// Climbing to z ≥ ALTITUDE_CEILING leaves the world's reachable scales
// entirely: this world only generates scale 0 and scale 1 (scenario/island.ts
// scale ladder), so z 10 would map onto the nonexistent scale 2 — the bird
// is despawned for good (coordinate space + flock record).
export const ALTITUDE_CEILING = 10;

// At z ≥ ALTITUDE_FADE_LIMIT (= ceiling − 2) the bird is fully invisible:
// like something that has flown outside the world's edge, it LEAVES the
// coordinate space (the memory-stack vanish at render level) while its flock
// record survives 'aloft'; descending below the limit places it back.
export const ALTITUDE_FADE_LIMIT = 8;

// Fade-band colors for the visible climb (z 2..7): the base seabird blue
// #7ec8e3 with a 2-digit hex alpha of opacity(z) = 1 − z / 8 —
//   z2 0.750 → round(0.750 × 255) = 191 = 'bf'
//   z3 0.625 → round(0.625 × 255) = 159 = '9f'
//   z4 0.500 → round(0.500 × 255) = 128 = '80'
//   z5 0.375 → round(0.375 × 255) =  96 = '60'
//   z6 0.250 → round(0.250 × 255) =  64 = '40'
//   z7 0.125 → round(0.125 × 255) =  32 = '20'
// z 0 ('perched') and z 1 ('flying', legacy full color, no alpha) stay in the
// canvas palettes' stock state colors (@godspace/canvas ASCII_STATE_COLORS);
// the scenario merges this map into every canvas' `states` option. z ≥
// ALTITUDE_FADE_LIMIT draws nothing — the bird is out of the coordinate space.
export const BIRD_ALTITUDE_STATES: Record<string, string> = {
    'flying-2': '#7ec8e3bf',
    'flying-3': '#7ec8e39f',
    'flying-4': '#7ec8e380',
    'flying-5': '#7ec8e360',
    'flying-6': '#7ec8e340',
    'flying-7': '#7ec8e320',
};

/** Roster for default bird names. */
const BIRD_NAMES = ['Kiki', 'Jask', 'Tern', 'Sula'];

/** Cruise altitude a released bird starts at. */
const CRUISE_ALTITUDE = 2;

/**
 * Display band state for a flying altitude — z 1 is the legacy full-color
 * 'flying', z 2..7 the fading 'flying-N' ladder. Only called for z ≤ 7
 * (z ≥ ALTITUDE_FADE_LIMIT transitions to 'aloft' before any band is read).
 */
const bandState = (z: number): string => (z <= 1 ? 'flying' : `flying-${z}`);

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
    // Chances are per world-minute — every tick hook call covers exactly one
    // world-minute (engine/world.ts sub-steps), so the rolls apply directly
    const landChance = options.landChancePerMinute ?? 0.02;
    const takeoffChance = options.takeoffChancePerMinute ?? 0.05;
    const altitudeChance = options.altitudeChancePerMinute ?? 0.03;
    const arriveChance = options.arriveChancePerMinute ?? 0.01;
    const maxBirds = options.maxBirds ?? 4;

    // Bird identity records — the mechanical state drives the roll sets; `at`
    // mirrors the live position for visible birds and is the PRIVATE last
    // position for aloft ones (the coordinate space holds nothing for them)
    const flock = new Map<
        string,
        { name: string; marker: string; state: BirdRecord['state']; at: Position3D }
    >();
    let released = 0;

    // The world reference arrives with setup (release/tick need canvas + events)
    let world: PluginContext['world'] | null = null;

    /** Next bird identity — the monotonic counter never walks back on a
     * despawn (despawned ids are never reused; only a full dispose resets). */
    const nextIdentity = (name?: string): { id: string; name: string; marker: string } => {
        released = released + 1;
        const id = `bird-${released}`;
        const birdName = name ?? BIRD_NAMES[(released - 1) % BIRD_NAMES.length];
        return { id, name: birdName, marker: birdName.slice(0, 1) };
    };

    /** Composes the public record: identity + live position from the space,
     * falling back to the private last position for aloft birds. */
    const recordOf = (id: string): BirdRecord | undefined => {
        const bird = flock.get(id);
        if (!bird) {
            return undefined;
        }
        const position =
            bird.state === 'aloft'
                ? bird.at
                : (world?.coordinates.positionOf(id) ?? bird.at);
        return { id, name: bird.name, marker: bird.marker, state: bird.state, position: { ...position } };
    };

    /**
     * Every rim cell of the canvas (|x| = halfX or |y| = halfY), row-major —
     * birds ignore passability, so the whole rim is their arrival horizon.
     * Centered coordinates: cells run −half … +half on both axes.
     */
    const rimCells = (width: number, height: number): Array<{ x: number; y: number }> => {
        const halfX = (width - 1) / 2;
        const halfY = (height - 1) / 2;
        const rim: Array<{ x: number; y: number }> = [];
        arrayEach(Array.from({ length: width * height }, (_, index) => index), ({ value: index }) => {
            const x = (index % width) - halfX;
            const y = Math.floor(index / width) - halfY;
            if (Math.abs(x) === halfX || Math.abs(y) === halfY) {
                rim.push({ x, y });
            }
        });
        return rim;
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
            const active = world;
            const identity = nextIdentity(name);
            // Hover above the island center — world coordinates are centered,
            // so the dead center of any canvas IS (0, 0) — at cruise altitude.
            // The initial display band is already the z 2 fade rung
            const position = position3(0, 0, CRUISE_ALTITUDE);
            flock.set(identity.id, {
                name: identity.name,
                marker: identity.marker,
                state: 'flying',
                at: position,
            });
            active.coordinates.place({
                id: identity.id,
                position,
                // The two-level taxonomy: a bird is a creature of type bird
                kind: 'creature',
                type: 'bird',
                name: identity.name,
                marker: identity.marker,
                state: bandState(CRUISE_ALTITUDE),
            });
            active.events.emit({
                kind: 'spawn',
                actorId: identity.id,
                message: `${identity.name} wheels above the island.`,
            });
            return recordOf(identity.id) as BirdRecord;
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
            // arrayEach closures (mutable outer variable)
            const active = world;
            const { coordinates, events } = active;
            const random = context.random;

            // ── Fixed roll order ── ONE flock-level arrival roll comes FIRST
            // (before any per-bird roll — deterministic), then the per-bird
            // rolls run in id order. The roster is snapshotted before the
            // arrival: a bird that arrives this minute starts rolling next
            // minute.
            const order = Array.from(flock.keys());
            if (random() < arriveChance && flock.size < maxBirds) {
                // Second roll picks the lane: over the sea rim at flying
                // altitude, or dropping from the high air already aloft
                const rim = rimCells(active.canvas.width, active.canvas.height);
                if (rim.length > 0) {
                    const seaLane = random() < 0.5;
                    const cell = rim[Math.floor(random() * rim.length)];
                    const identity = nextIdentity();
                    if (seaLane) {
                        // SEA arrival: over the open sea edge, in the space at z 1
                        const position = position3(cell.x, cell.y, 1);
                        flock.set(identity.id, {
                            name: identity.name,
                            marker: identity.marker,
                            state: 'flying',
                            at: position,
                        });
                        coordinates.place({
                            id: identity.id,
                            position,
                            kind: 'creature',
                            type: 'bird',
                            name: identity.name,
                            marker: identity.marker,
                            state: 'flying',
                        });
                        events.emit({
                            kind: 'spawn',
                            actorId: identity.id,
                            message: `${identity.name} glides in from over the open sea.`,
                        });
                    } else {
                        // HIGH arrival: already aloft at z 9 — above the fade
                        // limit, below the ceiling — out of the space, private
                        // position only
                        const position = position3(cell.x, cell.y, ALTITUDE_FADE_LIMIT + 1);
                        flock.set(identity.id, {
                            name: identity.name,
                            marker: identity.marker,
                            state: 'aloft',
                            at: position,
                        });
                        events.emit({
                            kind: 'spawn',
                            actorId: identity.id,
                            message: `${identity.name} drops from the high air.`,
                        });
                    }
                }
            }

            arrayEach(order, ({ value: id }) => {
                const bird = flock.get(id);
                if (!bird) {
                    return;
                }
                if (bird.state === 'flying') {
                    const position = coordinates.positionOf(id);
                    if (!position) {
                        return;
                    }
                    // Roll order per flying bird: land → altitude → glide; a
                    // fired roll owns the bird's minute and returns early
                    if (random() < landChance) {
                        // Touch down onto the ground plane (Z = 0)
                        const ground = grounded(position);
                        coordinates.move(id, ground);
                        bird.state = 'perched';
                        bird.at = ground;
                        active.retag(id, { state: 'perched' });
                        events.emit({
                            kind: 'move',
                            actorId: id,
                            message: `${bird.name} lands.`,
                        });
                        return;
                    }
                    if (random() < altitudeChance) {
                        // Altitude drift ±1, clamped LOW at 1 only — climbing
                        // is unclamped: the fade limit turns the bird aloft
                        // (the ceiling case is handled by the aloft drift)
                        const z = Math.max(1, position.z + (random() < 0.5 ? -1 : 1));
                        if (z >= ALTITUDE_FADE_LIMIT) {
                            // Fade-out: leave the coordinate space (the
                            // memory-stack vanish at render level), keep the
                            // flock record with the private last position
                            coordinates.remove(id);
                            bird.state = 'aloft';
                            bird.at = position3(position.x, position.y, z);
                            events.emit({
                                kind: 'move',
                                actorId: id,
                                message: `${bird.name} soars out of sight.`,
                            });
                            return;
                        }
                        const next = position3(position.x, position.y, z);
                        coordinates.move(id, next);
                        bird.at = next;
                        // The band lives in the display facet (retag); the
                        // mechanical record state stays 'flying'
                        active.retag(id, { state: bandState(z) });
                        return;
                    }
                    // Glide: pick a random neighbor offset — flying birds are
                    // NOT clamped to the canvas. A step out of bounds flies
                    // past the edge of the world: the bird despawns (the
                    // released counter keeps counting, ids never collide)
                    const offset = NEIGHBOR_OFFSETS[Math.floor(random() * NEIGHBOR_OFFSETS.length)];
                    const x = position.x + offset.dx;
                    const y = position.y + offset.dy;
                    if (!active.inBounds(x, y)) {
                        coordinates.remove(id);
                        flock.delete(id);
                        events.emit({
                            kind: 'despawn',
                            actorId: id,
                            message: `${bird.name} wheels past the edge of the world and vanishes.`,
                        });
                        return;
                    }
                    const next = position3(x, y, position.z);
                    coordinates.move(id, next);
                    bird.at = next;
                    events.emit({
                        kind: 'move',
                        actorId: id,
                        message: `${bird.name} glides ${directionWord(offset.dx, offset.dy)}.`,
                    });
                    return;
                }
                if (bird.state === 'aloft') {
                    // Aloft: only the altitude roll applies — the private z
                    // drifts with no clamps, no landing, no gliding
                    if (random() < altitudeChance) {
                        const z = bird.at.z + (random() < 0.5 ? -1 : 1);
                        if (z >= ALTITUDE_CEILING) {
                            // z 10 would map onto the nonexistent scale 2 —
                            // the bird vanishes from the memory stack for good
                            flock.delete(id);
                            events.emit({
                                kind: 'despawn',
                                actorId: id,
                                message: `${bird.name} climbs into the higher scale and is gone.`,
                            });
                            return;
                        }
                        if (z < ALTITUDE_FADE_LIMIT) {
                            // Descending below the fade limit: back into the
                            // coordinate space at the private position — the
                            // full facet like release places it (place after
                            // remove is the clean path, there is no stale
                            // entry to move); the retag re-asserts the band
                            const next = position3(bird.at.x, bird.at.y, z);
                            coordinates.place({
                                id,
                                position: next,
                                kind: 'creature',
                                type: 'bird',
                                name: bird.name,
                                marker: bird.marker,
                                state: bandState(z),
                            });
                            active.retag(id, { state: bandState(z) });
                            bird.state = 'flying';
                            bird.at = next;
                            events.emit({
                                kind: 'move',
                                actorId: id,
                                message: `${bird.name} descends back into view.`,
                            });
                            return;
                        }
                        // Still above the fade limit: the private z drifts
                        // on, invisible and eventless
                        bird.at = position3(bird.at.x, bird.at.y, z);
                    }
                    return;
                }
                // Perched: roll order is takeoff → hop; a fired takeoff owns
                // the minute
                const position = coordinates.positionOf(id);
                if (!position) {
                    return;
                }
                if (random() < takeoffChance) {
                    // A LOW takeoff: 1..3 — reaching the fade limit or the
                    // ceiling takes many minutes of drift, never one jump
                    const z = 1 + Math.floor(random() * 3);
                    const next = position3(position.x, position.y, z);
                    coordinates.move(id, next);
                    bird.state = 'flying';
                    bird.at = next;
                    active.retag(id, { state: bandState(z) });
                    events.emit({
                        kind: 'move',
                        actorId: id,
                        message: `${bird.name} takes off.`,
                    });
                    return;
                }
                // Hop one step along the ground plane — grounded birds stay
                // on the island: clamped to the canvas like today (gulls
                // float — any in-bounds cell goes, sea included)
                const halfX = (active.canvas.width - 1) / 2;
                const halfY = (active.canvas.height - 1) / 2;
                const offset = NEIGHBOR_OFFSETS[Math.floor(random() * NEIGHBOR_OFFSETS.length)];
                const x = clamp(position.x + offset.dx, -halfX, halfX);
                const y = clamp(position.y + offset.dy, -halfY, halfY);
                const next = grounded(position3(x, y));
                coordinates.move(id, next);
                bird.at = next;
                events.emit({
                    kind: 'move',
                    actorId: id,
                    message: `${bird.name} hops ${directionWord(x - position.x, y - position.y)}.`,
                });
            });
        },
    };
};
