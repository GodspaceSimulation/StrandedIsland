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
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
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

    it('a perched bird pays the walk row per hop — the perch grants nothing (R4)', () => {
        const { world, birds, needs } = buildStatStack({ landChancePerMinute: 1, takeoffChancePerMinute: 0 });
        birds.release();
        // Start drained — the clamp at 100 would hide the arithmetic
        needs.satisfy('bird-1', { energy: -80 }); // 20
        world.step(); // minute 1: lands (decay 19.95 — the landing is free)
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
        world.step(); // minute 2: the hop pays the walk row (−1.25) + the decay (−0.05)
        expect(needs.of('bird-1').energy).toBe(18.65);
        world.step(); // minute 3: another perched minute — and NO roost grant:
        // the perch recovers NOTHING plugin-side (R4 routes every energy
        // gain through the ledger's rest/sleep tasks — the sleep plugin's
        // slumber, backed by the needs recovery service out of equal
        // hunger/thirst). The gull nets NEGATIVE while it waits: the
        // sanctioned recovery is the ledger's, tested with the live
        // ledger in the behavior plugin's bird-slumber tests.
        expect(needs.of('bird-1').energy).toBe(17.349999999999998);
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
    });

    it('a spent gull stays perched — the takeoff gate reopens above the line', () => {
        const { world, birds, needs } = buildStatStack({ landChancePerMinute: 1, takeoffChancePerMinute: 1 });
        birds.release();
        needs.satisfy('bird-1', { energy: -85 }); // 15 — below the 25 line
        world.step(); // minute 1: lands (the landing needs no energy)
        // Minutes 2-4: the takeoff roll fires every minute (chance 1) but
        // the gate holds the spent gull down; the hops drain meanwhile
        // (three perched minutes: 15 − the landing decay, −1.3 each — the
        // hop's walk row 1.25 and the decay 0.05; the perch grants
        // NOTHING, R4 — the recovery is the ledger's slumber)
        for (let index = 0; index < 3; index++) {
            world.step();
        }
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
        expect(needs.of('bird-1').energy).toBe(11.049999999999997);
        // Over the line (the god's hand stands in for the ledger's
        // slumber): the very next perched minute takes off
        needs.satisfy('bird-1', { energy: 30 });
        world.step();
        expect(birds.birdOf('bird-1')?.state).toBe('flying');
        // The climb charged the fly row: (11.05 + 30) − decay − 2.5
        expect(needs.of('bird-1').energy).toBe(38.5);
    });
});

describe('birdsPlugin — the off-space residence: the aloft stats live on', () => {
    /** The stat stack the off-space tests share — needs + profiles + birds,
     * the same construction the stat-driven flight tests (and the scenario)
     * mount. The provider registration runs inside the birds plugin's
     * setup. */
    const buildStatStack = (options: Parameters<typeof birdsPlugin>[0] = {}, seed = 7) => {
        const profiles = entityPlugin();
        const needs = needsPlugin({ profiles });
        const birds = birdsPlugin({ needs, profiles, ...options });
        const world = createWorld({ seed, tickSize: 1, plugins: [islandTerrainPlugin(), needs, birds] });
        return { world, birds, needs };
    };

    // The aloft fade (z ≥ ALTITUDE_FADE_LIMIT) removes the bird from the
    // coordinate space while the flock record keeps it ALIVE — so the needs
    // sweep needs the flock's own registry (the off-space residence
    // provider the plugin registers in setup) to keep the bird decaying by
    // its species profile while it flies unseen, to retain its stat record
    // across the fade (a descent continues the same life — no fresh
    // full-stat body), and to bury a health-zero death through the
    // provider's remove (the flock record goes with the body — no
    // resurrection on a later descent).

    it('an aloft bird keeps decaying by its species profile — the stats survive the fade', () => {
        // Seed 11 forced-altitude reference (the SAME walk the descent test
        // pinned — the stats never consume plugin rolls): out at 24, back
        // at 25, out 26, back 27, out 28, aloft drift 29-30, back at 31
        // (z 7). Hunger/thirst/energy decay by the bird profile EVERY
        // minute — visible or aloft — and the pre-fix reset (the prune
        // wiping the record, the re-entry waking it at the starting values
        // hunger 10 / energy 100) is gone.
        const { world, birds, needs } = buildStatStack(
            {
                landChancePerMinute: 0,
                altitudeChancePerMinute: 1,
                arriveChancePerMinute: 0,
            },
            11,
        );
        birds.release();
        // The bird profile's rates: hunger +0.02, thirst +0.03, energy
        // −0.05 per world-minute. The altitude roll owns every minute
        // (chance 1) — no glides fire, so energy runs on the flight
        // metabolism alone (the per-tile fly-row charges stay on actual
        // glides; aloft drift crosses no tiles).
        for (let index = 0; index < 24; index++) {
            world.step();
        }
        // Minute 24: the fade hit — the bird is aloft (out of the space),
        // and the sweep decayed it this minute while it was still visible
        expect(birds.birdOf('bird-1')?.state).toBe('aloft');
        expect(world.coordinates.entryOf('bird-1')).toBeUndefined();
        expect(needs.of('bird-1')).toEqual({
            hunger: 10.47999999999999,
            thirst: 10.719999999999985,
            energy: 98.80000000000007,
            health: 100,
        });
        world.step();
        // Minute 25: the bird descended (z 7) — and the sweep decayed it
        // THROUGH the aloft minute: one more profile step advanced
        // off-space (the pre-fix prune would have wiped the record here
        // and re-created it at the starting values on the next touch)
        expect(birds.birdOf('bird-1')).toMatchObject({ state: 'flying', position: { x: 0, y: 0, z: 7 } });
        expect(needs.of('bird-1')).toEqual({
            hunger: 10.49999999999999,
            thirst: 10.749999999999984,
            energy: 98.75000000000007,
            health: 100,
        });
        // The whole episode: three fade cycles later the bird is still the
        // same continuously-decaying life — 31 minutes of profile decay,
        // no reset anywhere
        for (let index = 26; index <= 31; index++) {
            world.step();
        }
        expect(birds.birdOf('bird-1')).toMatchObject({ state: 'flying', position: { x: 0, y: 0, z: 7 } });
        expect(needs.of('bird-1')).toEqual({
            hunger: 10.619999999999987,
            thirst: 10.92999999999998,
            energy: 98.45000000000009,
            health: 100,
        });
    });

    it('a health-zero death while aloft buries the flock record — no resurrection', () => {
        // Seed 7 forced-altitude reference (the fade tests' walk): the
        // climb reaches z 8 at minute 36 (aloft), would drift to z 9 at 37
        // and hit the ceiling despawn at 38. With the reservoir drained
        // while aloft, the death lands FIRST — the flock record goes with
        // the body, so no drift, no ceiling despawn, and no descent can
        // resurrect the bird.
        const { world, birds, needs } = buildStatStack({
            landChancePerMinute: 0,
            altitudeChancePerMinute: 1,
            arriveChancePerMinute: 0,
        });
        birds.release();
        for (let index = 0; index < 36; index++) {
            world.step();
        }
        // Minute 36: aloft — alive, out of the space, stats decaying on
        expect(birds.birdOf('bird-1')?.state).toBe('aloft');
        expect(world.coordinates.entryOf('bird-1')).toBeUndefined();
        expect(needs.of('bird-1').health).toBe(100);
        // The reservoir runs dry while the bird is out of the space
        needs.satisfy('bird-1', { health: -100 });
        world.step(); // minute 37: the sweep decays the aloft body, finds 0, kills
        // THE DEATH — off-space and final: the line reads the provider's
        // name, and the pre-fix ceiling despawn never fires (there is no
        // body left to climb into the higher scale)
        expect(world.events.log().at(-1)).toEqual({
            id: 2,
            tick: 37,
            time: 37,
            kind: 'death',
            message: 'Kiki has died.',
            actorId: 'bird-1',
        });
        expect(birds.birds()).toEqual([]);
        expect(birds.birdOf('bird-1')).toBeUndefined();
        expect(world.coordinates.all()).toEqual([]);
        // NO RESURRECTION: forty more minutes of forced drift — a
        // surviving aloft record would descend below the fade limit and
        // re-place the body; the dead bird never comes back
        for (let index = 38; index <= 77; index++) {
            world.step();
        }
        expect(birds.birds()).toEqual([]);
        expect(world.coordinates.all()).toEqual([]);
        // The bird's whole chronicle: the spawn and the death — nothing else
        expect(world.events.log().filter((event) => event.actorId === 'bird-1').map((event) => event.kind)).toEqual([
            'spawn',
            'death',
        ]);
    });

    it('a perched bird\u2019s health-zero death cancels its ledger tasks and buries the flock record', () => {
        // The FULL island mount slice (scenario/island.ts order): profiles,
        // inventory, needs, relationship, tasks, behavior, birds — the bird
        // plans through the ledger (a grounded creature) and its death must
        // take the queued tasks AND the flock record with it (the pre-fix
        // ghost: a perched body whose coordinate entry dies while its flock
        // record lingers on, unplannable and unkillable).
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const needs = needsPlugin({ profiles });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const birds = birdsPlugin({
            needs,
            profiles,
            tasks,
            landChancePerMinute: 1,
            takeoffChancePerMinute: 0,
            arriveChancePerMinute: 0,
        });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, birds],
        });
        birds.release();
        world.step(); // minute 1: lands onto the ground plane at (0, 0)
        expect(birds.birdOf('bird-1')?.state).toBe('perched');
        // A hungry gull plans through the ledger: no food in the beak, none
        // underfoot (the highland stocks stone + flint) — the travel rung
        // walks it toward the nearest food, a queued 1-minute move task
        needs.satisfy('bird-1', { hunger: 55 }); // 65 ≥ 60
        world.step(); // minute 2: the hunger rung queues the trek
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'hunger',
            kind: 'move',
            label: 'travels to food',
            minutes: 1,
            payload: { dx: 1, dy: 0 },
            total: 1,
            remaining: 1,
        });
        // The reservoir runs dry: the sweep kills the body on the next
        // minute
        needs.satisfy('bird-1', { health: -100 });
        world.step(); // minute 3: death
        expect(world.events.log().at(-1)).toEqual({
            id: 2,
            tick: 3,
            time: 3,
            kind: 'death',
            message: 'Kiki has died.',
            actorId: 'bird-1',
        });
        // The queued trek cancelled with the body (the tasks plugin's
        // despawn/death subscription) — no stale task outlives the gull
        expect(tasks.taskOf('bird-1')).toBeUndefined();
        expect(tasks.tasks()).toEqual([]);
        // The flock record is buried with the bird — the ghost is gone
        expect(birds.birds()).toEqual([]);
        expect(world.coordinates.all()).toEqual([]);
        // The dead gull is never re-planned and never comes back
        for (let index = 4; index <= 8; index++) {
            world.step();
        }
        expect(tasks.tasks()).toEqual([]);
        expect(birds.birds()).toEqual([]);
    });

    it('disposing the birds plugin ends the aloft decay — the provider unsubscribes', () => {
        const { world, birds, needs } = buildStatStack(
            {
                landChancePerMinute: 0,
                altitudeChancePerMinute: 1,
                arriveChancePerMinute: 0,
            },
            11,
        );
        birds.release();
        for (let index = 0; index < 24; index++) {
            world.step();
        }
        // Aloft with the retained, decaying record
        expect(birds.birdOf('bird-1')?.state).toBe('aloft');
        expect(needs.of('bird-1').hunger).toBe(10.47999999999999);
        // The environment is gone: the provider unsubscribes (the dispose
        // hook — the same listener-cleanup rule the tasks plugin's event
        // subscription follows), the flock clears — the orphaned stat
        // record prunes on the next sweep, exactly like any other vanished
        // body
        world.plugins.remove('birds');
        world.step();
        expect(birds.birds()).toEqual([]);
        // Re-touching re-creates the legacy fallback — the bird's record
        // did not survive its environment
        expect(needs.of('bird-1')).toEqual({ hunger: 20, thirst: 20, energy: 100, health: 100 });
    });
});

describe('birdsPlugin — bird identity: the departed and the newcomer', () => {
    // The identity contract the product owner pinned: the SAME bird fading
    // out and reappearing retains its stats (the off-space continuity tests
    // above), while a GENUINELY NEW bird is a new identity — a fresh
    // bird-profile stat record and a clean ledger, never the departed
    // bird's drained values or queues. The mechanism: the birds plugin's
    // identity counter is monotonic (birdsPlugin.ts nextIdentity — despawns
    // and deaths never walk it back, ids are never re-issued within a
    // plugin instance), so a newcomer's id cannot collide with the
    // departed bird's needs record (keyed by id, needsPlugin states) or
    // ledger queue (keyed by actorId, cancelled on the death event).

    /** The full island mount slice — the same construction the perched
     * death test runs (the bird plans through the ledger here). */
    const buildIslandStack = () => {
        const profiles = entityPlugin();
        const inventory = inventoryPlugin({ rainChancePerMinute: 0, profiles });
        const needs = needsPlugin({ profiles });
        const relationship = relationshipPlugin();
        const tasks = tasksPlugin();
        const behavior = behaviorPlugin({ inventory, needs, relationship, tasks, profiles });
        const birds = birdsPlugin({
            needs,
            profiles,
            tasks,
            landChancePerMinute: 1,
            takeoffChancePerMinute: 0,
            arriveChancePerMinute: 0,
        });
        const world = createWorld({
            seed: 7,
            tickSize: 1,
            plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, birds],
        });
        return { world, birds, needs, tasks };
    };

    it('a fresh arrival after a bird\u2019s death is a new identity — fresh profile stats, no inherited queue, no resurrection', () => {
        const { world, birds, needs, tasks } = buildIslandStack();
        // bird-1 lives, lands, drains and dies with a queued trek — the
        // departed life the newcomer must NOT inherit anything from
        birds.release();
        world.step(); // minute 1: lands onto the ground plane at (0, 0)
        // Drain the stats far off the fresh-start line (hunger 65 ≥ the
        // hunger rung's 60; energy 40 well above the rest/roost line 22 —
        // the trek, not a rest, is what queues)
        needs.satisfy('bird-1', { hunger: 55, energy: -60 });
        world.step(); // minute 2: the hunger rung queues the trek
        expect(tasks.taskOf('bird-1')).toEqual({
            id: 't-1',
            actorId: 'bird-1',
            behaviour: 'hunger',
            kind: 'move',
            label: 'travels to food',
            minutes: 1,
            payload: { dx: 1, dy: 0 },
            total: 1,
            remaining: 1,
        });
        // The drained record — the values a resurrection would inherit
        expect(needs.of('bird-1')).toEqual({
            hunger: 65.03999999999999,
            thirst: 10.059999999999999,
            energy: 39.900000000000006,
            health: 100,
        });
        needs.satisfy('bird-1', { health: -100 });
        world.step(); // minute 3: death
        expect(world.events.log().at(-1)).toEqual({
            id: 2,
            tick: 3,
            time: 3,
            kind: 'death',
            message: 'Kiki has died.',
            actorId: 'bird-1',
        });
        // The departure is total: queue cancelled, flock record buried,
        // stat record deleted with the body
        expect(tasks.tasks()).toEqual([]);
        expect(birds.birdOf('bird-1')).toBeUndefined();
        expect(world.coordinates.entryOf('bird-1')).toBeUndefined();

        // THE NEWCOMER — a genuinely new bird, not the old one returning
        const newcomer = birds.release('Sula');
        expect(newcomer).toEqual({
            // The monotonic identity: bird-1 was never re-issued
            id: 'bird-2',
            name: 'Sula',
            marker: 'S',
            state: 'flying',
            position: { x: 0, y: 0, z: 2 },
        });
        // FRESH STATS — the bird profile's starting values
        // (entityPlugin STOCK_PROFILES.bird.start), not bird-1's drained
        // record and not the legacy castaway fallback
        expect(needs.of('bird-2')).toEqual({ hunger: 10, thirst: 10, energy: 100, health: 100 });
        // NO INHERITED QUEUE — the ledger knows nothing of the newcomer
        expect(tasks.taskOf('bird-2')).toBeUndefined();
        expect(tasks.busy('bird-2')).toBe(false);
        expect(tasks.tasks()).toEqual([]);

        // THE OLD BIRD CANNOT RESURRECT: minutes of drift after the
        // newcomer's release — bird-1 holds no flock record (the descent
        // path re-places only ids the flock still holds) and no coordinate
        // entry; nothing walks it back in
        for (let index = 0; index < 5; index++) {
            world.step();
        }
        expect(birds.birdOf('bird-1')).toBeUndefined();
        expect(world.coordinates.entryOf('bird-1')).toBeUndefined();
        expect(birds.birds().map((bird) => bird.id)).toEqual(['bird-2']);
        // The two lives stay distinct in the chronicle: bird-1 spawned and
        // died, bird-2 spawned after — no event ever re-uses the dead id
        expect(
            world.events
                .log()
                .filter((event) => event.kind === 'spawn' || event.kind === 'death')
                .map((event) => `${event.actorId}:${event.kind}`),
        ).toEqual(['bird-1:spawn', 'bird-1:death', 'bird-2:spawn']);
    });
});
