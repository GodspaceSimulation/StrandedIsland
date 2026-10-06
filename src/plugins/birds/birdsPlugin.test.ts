// Tests for the seabirds environment plugin (plugins/birds/birdsPlugin.ts).
// The bird is the engine's Z-axis traveler: everything below is captured
// from deterministic reference runs (seeded plugin stream) and pinned exactly.
//
// One-minute steps keep the reference paths short — one step is one
// world-minute of flight, one decision per step.
//
// The altitude ladder (plugins/birds/birdsPlugin.ts): z 0 perched, z 1 the
// legacy full-color 'flying', z 2..7 the fading 'flying-N' bands, z 8+
// (ALTITUDE_FADE_LIMIT) fully invisible — the bird LEAVES the coordinate
// space while its flock record survives 'aloft', and climbing to z ≥ 10
// (ALTITUDE_CEILING — the nonexistent scale 2) despawns it for good. Flying
// birds are NOT clamped to the canvas: a glide out of bounds flies past the
// edge of the world and vanishes. Birds also ARRIVE: over the sea rim or
// dropping from the high air, up to the flock cap.

import { describe, it, expect } from 'vitest';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { needsPlugin } from '../needs/needsPlugin';
import { entityPlugin } from '../entity/entityPlugin';
import { birdsPlugin, ALTITUDE_CEILING, ALTITUDE_FADE_LIMIT, BIRD_ALTITUDE_STATES } from './birdsPlugin';

const buildStack = (
    options: Parameters<typeof birdsPlugin>[0] = {},
    seed = 7,
) => {
    const birds = birdsPlugin(options);
    const world = createWorld({ seed, tickSize: 1, plugins: [islandTerrainPlugin(), birds] });
    return { world, birds };
};

describe('birdsPlugin', () => {
    it('releases a bird above the island center at cruise altitude', () => {
        const { world, birds } = buildStack();
        const kiki = birds.release();
        expect(kiki).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            // The MECHANICAL state is 'flying' — the fade band is display
            // state and lives in the coordinate facet below
            state: 'flying',
            // World coordinates are centered — the island center IS (0, 0);
            // cruise altitude z = 2
            position: { x: 0, y: 0, z: 2 },
        });
        // The bird lives in the 3D spatial record — a creature of type bird,
        // its display state the z-2 fade band ('flying-2')
        expect(world.coordinates.entryOf('bird-1')).toEqual({
            id: 'bird-1',
            position: { x: 0, y: 0, z: 2 },
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-2',
        });
        // Not a castaway — the actor registry never sees birds
        expect(world.actors.size).toBe(0);
        expect(world.events.log()[0]).toEqual({
            id: 1,
            tick: 0,
            time: 0,
            kind: 'spawn',
            message: 'Kiki wheels above the island.',
            actorId: 'bird-1',
        });
    });

    it('release rolls through the default name roster', () => {
        const { birds } = buildStack();
        expect(birds.release().name).toBe('Kiki');
        expect(birds.release().name).toBe('Jask');
        // An explicit name wins over the roster
        const named = birds.release('Sula');
        expect(named).toEqual({
            id: 'bird-3',
            name: 'Sula',
            marker: 'S',
            state: 'flying',
            position: { x: 0, y: 0, z: 2 },
        });
        expect(birds.birds().map((bird) => bird.name)).toEqual(['Kiki', 'Jask', 'Sula']);
    });

    it('flies through 3D space silently: glides, drifts altitude — no telemetry in the log', () => {
        const { world, birds } = buildStack();
        birds.release();
        // Reference run (seed 7, per-minute chances): ten minutes of flight —
        // the arrival roll fires never, the land roll never, the altitude
        // roll ONCE (minute 9, z 2 → 3 — altitude drift is eventless) and
        // every other minute a glide. NONE of it logs: a bird gliding east
        // or west is simulation, not story.
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        const path = world.events
            .log()
            .filter((event) => event.actorId === 'bird-1')
            .map((event) => event.message);
        expect(path).toEqual(['Kiki wheels above the island.']);
        // Reference end position: nine glides + one altitude drift to z 3 —
        // the flight itself never stopped, only its narration
        expect(birds.birdOf('bird-1')?.position).toEqual({ x: 4, y: 0, z: 3 });
    });

    it('lands onto the ground plane (z = 0) and hops while perched — silently', () => {
        // Force the landing instinct: land on the first roll
        const { world, birds } = buildStack({ landChancePerMinute: 1 });
        birds.release();
        world.step();
        expect(birds.birdOf('bird-1')).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'perched',
            position: { x: 0, y: 0, z: 0 },
        });
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 0, y: 0, z: 0 });
        // No landing line — the log tells stories, not flight telemetry
        expect(world.events.log().map((event) => event.message)).toEqual([
            'Kiki wheels above the island.',
        ]);

        // Perched: takeoff disabled → the gull hops one step per minute,
        // still silent
        const hopper = birdsPlugin({ landChancePerMinute: 1, takeoffChancePerMinute: 0 });
        const hopWorld = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), hopper] });
        hopper.release();
        hopWorld.step();
        hopWorld.step();
        expect(hopper.birdOf('bird-1')?.state).toBe('perched');
        const hopPath = hopWorld.events
            .log()
            .filter((event) => event.actorId === 'bird-1')
            .map((event) => event.message);
        expect(hopPath).toEqual(['Kiki wheels above the island.']);
        expect(hopper.birdOf('bird-1')?.position).toEqual({ x: 0, y: -1, z: 0 });
    });

    it('a perched bird takes off to an altitude within the ceiling — silently', () => {
        // Land on the first tick, then take off on the next
        const { world, birds } = buildStack({ landChancePerMinute: 1, takeoffChancePerMinute: 1 });
        birds.release();
        world.step(); // lands
        world.step(); // takes off
        const bird = birds.birdOf('bird-1');
        expect(bird?.state).toBe('flying');
        // Reference takeoff altitude (seeded draw): 1 + floor(draw × 3) = 1
        expect(bird?.position).toEqual({ x: 0, y: 0, z: 1 });
        expect(world.events.log().map((event) => event.message)).toEqual([
            'Kiki wheels above the island.',
        ]);
    });

    it('the fade ladder runs z 2..7 with the documented hex-alpha bands', () => {
        // The fade-band export — the scenario merges it into every canvas'
        // states option so all representations fade birds the same way
        expect(BIRD_ALTITUDE_STATES).toEqual({
            'flying-2': '#7ec8e3bf',
            'flying-3': '#7ec8e39f',
            'flying-4': '#7ec8e380',
            'flying-5': '#7ec8e360',
            'flying-6': '#7ec8e340',
            'flying-7': '#7ec8e320',
        });
        // The limits are the product owner's numbers: n = 10 (the ceiling —
        // the nonexistent scale 2), fully invisible at n − 2
        expect(ALTITUDE_CEILING).toBe(10);
        expect(ALTITUDE_FADE_LIMIT).toBe(8);
    });

    it('climbing to z 8 fades the bird out of the coordinate space (aloft)', () => {
        // Forced climb: the altitude roll fires EVERY minute and the walk
        // never glides or lands (reference run, seed 7) — the climb bounces
        // up and down until minute 36 reaches z 8
        const { world, birds } = buildStack({
            landChancePerMinute: 0,
            altitudeChancePerMinute: 1,
            arriveChancePerMinute: 0,
        });
        birds.release();
        for (let index = 0; index < 36; index++) {
            world.step();
        }
        // Minute 36: z hit 8 — the bird LEAVES the coordinate space (the
        // memory-stack vanish at render level) while the record survives
        const record = birds.birdOf('bird-1');
        expect(record).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'aloft',
            // The private last position — x/y never move without glides
            position: { x: 0, y: 0, z: 8 },
        });
        expect(world.coordinates.all().some((entry) => entry.id === 'bird-1')).toBe(false);
        // The vanish is silent too — the flock record + the coordinate space
        // are the truth, the log keeps to its stories
        expect(world.events.log().map((event) => event.message)).toEqual([
            'Kiki wheels above the island.',
        ]);
    });

    it('an aloft bird descends back into view below the fade limit — silently', () => {
        // Reference run (seed 11, forced altitude): the walk oscillates
        // across the fade limit — out at 24, back at 25, out 26, back 27,
        // out 28, silent drift 29-30, back at 31 (z 7)
        const { world, birds } = buildStack(
            {
                landChancePerMinute: 0,
                altitudeChancePerMinute: 1,
                arriveChancePerMinute: 0,
            },
            11,
        );
        birds.release();
        for (let index = 0; index < 31; index++) {
            world.step();
        }
        expect(birds.birdOf('bird-1')).toEqual({
            id: 'bird-1',
            name: 'Kiki',
            marker: 'K',
            state: 'flying',
            position: { x: 0, y: 0, z: 7 },
        });
        // Back in the coordinate space at the private position, band z 7
        expect(world.coordinates.entryOf('bird-1')).toEqual({
            id: 'bird-1',
            position: { x: 0, y: 0, z: 7 },
            kind: 'creature',
            type: 'bird',
            name: 'Kiki',
            marker: 'K',
            state: 'flying-7',
        });
        // The whole fade cycle (out at 24, back 25, out 26, back 27, out 28,
        // back 31) ran WITHOUT a single log line
        expect(
            world.events
                .log()
                .filter((event) => event.actorId === 'bird-1')
                .map((event) => event.message),
        ).toEqual(['Kiki wheels above the island.']);
    });

    it('climbing to z 10 vanishes the bird into the nonexistent higher scale', () => {
        // Same forced climb as the fade-out run: the aloft walk continues
        // 8 → 9 (silent) → 10, and z ≥ ALTITUDE_CEILING despawns for good —
        // this world has no scale 2 to fly into
        const { world, birds } = buildStack({
            landChancePerMinute: 0,
            altitudeChancePerMinute: 1,
            arriveChancePerMinute: 0,
        });
        birds.release();
        for (let index = 0; index < 38; index++) {
            world.step();
        }
        // Gone from the record AND the coordinate space — the memory stack
        // holds nothing left to render
        expect(birds.birdOf('bird-1')).toBeUndefined();
        expect(birds.birds()).toEqual([]);
        expect(world.coordinates.all().some((entry) => entry.id === 'bird-1')).toBe(false);
        expect(world.events.log().at(-1)).toEqual({
            id: 2,
            tick: 38,
            time: 38,
            kind: 'despawn',
            message: 'Kiki climbs into the higher scale and is gone.',
            actorId: 'bird-1',
        });
    });

    it('a glide out of bounds flies past the edge of the world and vanishes', () => {
        // Pure glide walk (no landing, no altitude drift, no arrivals):
        // reference run (seed 9) — 49 glides carried Kiki to (11, 8, 2) and
        // minute 50's glide stepped out of the 25×17 canvas
        const { world, birds } = buildStack(
            {
                landChancePerMinute: 0,
                altitudeChancePerMinute: 0,
                arriveChancePerMinute: 0,
            },
            9,
        );
        birds.release();
        for (let index = 0; index < 50; index++) {
            world.step();
        }
        // Minute 49 had the bird at (11, 8, 2) — one cell inside the rim;
        // minute 50's glide stepped past it and the bird is gone for good
        expect(birds.birdOf('bird-1')).toBeUndefined();
        expect(world.coordinates.all().some((entry) => entry.id === 'bird-1')).toBe(false);
        expect(world.events.log().at(-1)).toEqual({
            // Event 2: the spawn ran before it — the 49 glides stayed silent
            id: 2,
            tick: 50,
            time: 50,
            kind: 'despawn',
            message: 'Kiki wheels past the edge of the world and vanishes.',
            actorId: 'bird-1',
        });
    });

    it('birds arrive over the sea rim and drop from the high air, capped', () => {
        // Forced arrival roll every minute (reference run, seed 7): minute 1
        // rolls the HIGH lane (Jask drops aloft at z 9), minutes 2-3 the SEA
        // lane (Tern, Sula at rim cells z 1); minute 4 the cap (4, counting
        // the released Kiki) holds the flock closed
        const { world, birds } = buildStack({
            landChancePerMinute: 0,
            altitudeChancePerMinute: 0,
            arriveChancePerMinute: 1,
        });
        birds.release();
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        expect(birds.birds()).toEqual([
            { id: 'bird-1', name: 'Kiki', marker: 'K', state: 'flying', position: { x: -3, y: 1, z: 2 } },
            // The high arrival — aloft at z 9, private position only
            { id: 'bird-2', name: 'Jask', marker: 'J', state: 'aloft', position: { x: -9, y: -8, z: 9 } },
            { id: 'bird-3', name: 'Tern', marker: 'T', state: 'flying', position: { x: -6, y: 8, z: 1 } },
            { id: 'bird-4', name: 'Sula', marker: 'S', state: 'flying', position: { x: 4, y: -8, z: 1 } },
        ]);
        // Only the visible birds live in the coordinate space
        const spaceIds = world.coordinates.all().map((entry) => entry.id);
        expect(spaceIds).toContain('bird-1');
        expect(spaceIds).toContain('bird-3');
        expect(spaceIds).toContain('bird-4');
        expect(spaceIds).not.toContain('bird-2');
        expect(
            world.events
                .log()
                .filter((event) => event.kind === 'spawn')
                .map((event) => `${event.actorId}:${event.message}`),
        ).toEqual([
            'bird-1:Kiki wheels above the island.',
            'bird-2:Jask drops from the high air.',
            'bird-3:Tern glides in from over the open sea.',
            'bird-4:Sula glides in from over the open sea.',
        ]);
    });

    it('birds never block castaways — occupancy checks scan actors only', () => {
        const { world, birds } = buildStack({ landChancePerMinute: 0, takeoffChancePerMinute: 0 });
        birds.release();
        // A castaway walks onto the bird's column without resistance
        const actor = world.spawn({
            id: 'a',
            name: 'Ael',
            kind: 'sentient',
            type: 'human',
            position: { x: -1, y: 0, z: 0 },
            marker: 'A',
            condition: 'well',
            profile: { sex: 'male' },
        });
        expect(world.actorAt(-1, 0)?.id).toBe('a');
        // The bird hovers directly above the center column (z = 2 ≠ 0)
        expect(world.coordinates.positionOf('bird-1')).toEqual({ x: 0, y: 0, z: 2 });
        void actor;
    });

    it('dispose clears the flock and drops the world binding', () => {
        const { world, birds } = buildStack();
        birds.release();
        world.plugins.remove('birds');
        expect(birds.birds()).toEqual([]);
        // Releasing before setup is a hard error
        const stray = birdsPlugin();
        expect(() => stray.release()).toThrow('birds plugin released before setup');
    });
});

describe('birdsPlugin — the entity profiles: the stat-driven flight', () => {
    /** The stack with the needs plugin + entity profiles — birds live by stats. */
    const buildStatStack = (options: Parameters<typeof birdsPlugin>[0] = {}, seed = 7) => {
        const profiles = entityPlugin();
        const needs = needsPlugin({ profiles });
        const birds = birdsPlugin({ needs, profiles, ...options });
        const world = createWorld({ seed, tickSize: 1, plugins: [islandTerrainPlugin(), needs, birds] });
        return { world, birds, needs };
    };

    it('gliding burns the fly row per tile — the roll stream never shifts', () => {
        const { world, birds, needs } = buildStatStack();
        birds.release();
        // The SAME reference path the free-flight run pinned (the energy
        // charges consume no rolls): ten minutes, nine glides, one drift
        for (let index = 0; index < 10; index++) {
            world.step();
        }
        expect(birds.birdOf('bird-1')?.position).toEqual({ x: 4, y: 0, z: 3 });
        // The flight economics: nine glides × 2.5 (the fly row, stamina 8)
        // + the species decay 0.05 × 10 minutes — the float drift pinned
        // from the reference run
        expect(needs.of('bird-1').energy).toBe(77.00000000000003);
    });

    it('a perched bird recovers faster than hopping costs — the roost nets positive', () => {
        const { world, birds, needs } = buildStatStack({ landChancePerMinute: 1, takeoffChancePerMinute: 0 });
        birds.release();
        // Start drained — the clamp at 100 would hide the arithmetic
        needs.satisfy('bird-1', { energy: -80 }); // 20
        world.step(); // minute 1: lands (decay 19.95 — the landing is free)
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
        world.step(); // minute 2: hop (−1.25 walk row) + roost (+3) − decay
        expect(needs.of('bird-1').energy).toBe(21.65);
        world.step(); // minute 3: the roost drifts the gull UP the ladder
        expect(needs.of('bird-1').energy).toBe(23.349999999999998);
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
    });

    it('a spent gull stays perched — the takeoff gate reopens above the line', () => {
        const { world, birds, needs } = buildStatStack({ landChancePerMinute: 1, takeoffChancePerMinute: 1 });
        birds.release();
        needs.satisfy('bird-1', { energy: -85 }); // 15 — below the 25 line
        world.step(); // minute 1: lands (the landing needs no energy)
        // Minutes 2-4: the takeoff roll fires every minute (chance 1) but
        // the gate holds the spent gull down; the roost climbs meanwhile
        // (three perched minutes: 15 − landing decay, +1.7 net each)
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
        expect(needs.of('bird-1').energy).toBe(20.049999999999997);
        // Over the line: the very next perched minute takes off
        needs.satisfy('bird-1', { energy: 30 });
        world.step();
        expect(birds.birdOf('bird-1')?.state).toBe('flying');
        // The climb charged the fly row: (20.05 + 30) − decay − 2.5
        expect(needs.of('bird-1').energy).toBe(47.5);
    });
});
