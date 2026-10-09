// The predators environment plugin — wild boars roaming the island, the
// land beasts a castaway can meet and be hurt by.
//
// Boars are coordinate-space residents (kind 'creature' / type 'boar',
// state 'roaming') but never world.actors — no needs, no behavior loop,
// the same registry pattern as the sharks plugin
// (plugins/sharks/sharksPlugin.ts). They come in over the far shore: one
// arrival roll per world-minute spawns a fresh boar on a rim LAND cell
// while the population stays under the cap, and each boar roams the island
// one land tile at a time — never beaching itself in the water — paced at
// one tile every `paceMinutes` world minutes (the lumbering gait).
//
// THE HURT: a boar sharing a tile with a castaway can maul them — one
// bite roll per world-minute; a bite drains `biteDrain` energy points AND
// `biteDamage` HEALTH points (needs.satisfy) and lands in the log as an
// 'attack' event. The health wound is what makes a mauling potentially
// FATAL: health is the reservoir between an entity and death (plugins/
// needs — at health 0 the entity dies), so a boar that keeps its victim
// cornered can kill it outright. The hurt is also what the survival
// behaviour (plugins/survival/survivalPlugin.ts) reacts to: a boar within
// its threat range pre-empts the victim's task queue with a flee, which
// is why the meetings stay dramatic instead of fatal — a fleeing castaway
// only bleeds when it is cornered.
//
// THE TASK RESPECT: boars planned through the task ledger (the behavior
// plugin plans every grounded dry-land creature — forage, rest, wander)
// do not ALSO roam through their random rolls while the ledger is busy
// with them: the `tasks` handle's busy(id) gate keeps the two drivers
// from double-stepping the same beast in one minute.
//
// Everything is deterministic from the plugin's own keyed random stream.
// Boars block castaway fine steps (they are grounded coordinate residents
// — plugins/movement/fineMovement.ts fineSpotTaken).

import { arrayEach } from '@presource/core';
import {
    NEIGHBOR_OFFSETS,
    position3,
    type PluginContext,
    type WorldPlugin,
} from '@godspace/core';
import type { World } from '../../engine/world';
import type { EntityProfiles } from '../entity/entityPlugin';
import type { NeedsState } from '../needs/needsPlugin';

export type PredatorsPluginOptions = {
    /** Chance per world-minute a boar wanders in past the far shore.
     * Default 0.006. */
    arriveChancePerMinute?: number;
    /** Population cap. Default 2. */
    maxPredators?: number;
    /** Chance per world-minute that a boar sharing a tile with a castaway
     * mauls them. Default 0.5. */
    biteChancePerMinute?: number;
    /** Energy points one bite drains. Default 15. */
    biteDrain?: number;
    /** Health points one bite wounds. Default 20 — a health reservoir at
     * 0 kills the entity (plugins/needs), so a cornered castaway can die
     * of its wounds. */
    biteDamage?: number;
    /**
     * The task ledger's busy gate — a boar that carries queued tasks (the
     * behavior plugin plans grounded dry-land creatures through the ledger)
     * skips its random roam that minute so the two drivers never
     * double-step it. Absent: no ledger, the rolls drive alone.
     */
    tasks?: {
        /** Whether the entity has at least one queued task. */
        busy(entityId: string): boolean;
    };
    /**
     * World minutes between a boar's roaming steps. Default: DERIVED from
     * the boar's species profile when the entity profiles are mounted (the
     * Speed attribute's walk adjustment — the lumbering gait IS the
     * attribute), falling back to 2.
     */
    paceMinutes?: number;
    /**
     * The needs plugin — the bite drains the victim's energy through it.
     * Without it bites never land (the roll still runs, the maul stays
     * unwounded). With it AND the entity profiles, roaming burns the walk
     * row and an exhausted boar holds where it stands instead of roaming.
     */
    needs?: {
        of(entityId: string): NeedsState;
        satisfy(entityId: string, deltas: Partial<NeedsState>): void;
        moved(entityId: string, moveKind?: string): void;
    };
    /** The entity profiles — the pace derivation + the stat-driven roam. */
    profiles?: EntityProfiles;
};

/** One boar's record — position is read live from the coordinate space. */
export type PredatorRecord = {
    id: string;
    name: string;
    marker: string;
    x: number;
    y: number;
};

export type PredatorsPlugin = WorldPlugin<World> & {
    /** Places one boar at a rim land cell (the god-view manual release). */
    release(name?: string): PredatorRecord | undefined;
    /** One boar's record, or undefined. */
    predatorOf(id: string): PredatorRecord | undefined;
    /** All live boars. */
    predators(): PredatorRecord[];
};

/** Roster for default boar names — markers are the first letters, all distinct. */
const BOAR_NAMES = ['Tusk', 'Bristle', 'Snout', 'Gore'];

/**
 * THE EXHAUSTION LINE (stat-driven, when needs + profiles are mounted): a
 * boar whose energy has drained to this line stops roaming and holds where
 * it stands. The line HOLDS the body only — R4 routes every energy gain
 * through the ledger's rest/sleep tasks (the behavior ladder plans the
 * spent boar's rest at the tired line; the needs recovery service backs it
 * with equal hunger/thirst), so the plugin never grants energy directly.
 * Holding costs no roll and logs nothing — the wilds' own telemetry.
 */
const GRAZE_ENERGY = 20;

/** The legacy pace — the lumbering gait without entity profiles. */
const LEGACY_PACE = 2;

/**
 * The far-shore band: land cells whose normalized rim distance
 * (max(|x|/halfX, |y|/halfY)) reaches this fraction count as the shore the
 * boars wander in from. 0.85 keeps the band to the outermost dry ring —
 * the beach hugging the sea (the canvas edge itself is always water).
 */
const SHORE_BAND = 0.85;

/**
 * Canvas type-glyph for boars — the unicode/svg canvases resolve an
 * entry's TYPE through their type map, so boar entries (type 'boar') draw
 * the boar emoji. Merged into the canvas palettes by the scenario
 * (scenario/island.ts) next to ITEM_TYPE_GLYPHS and SHARK_TYPE_GLYPH.
 */
export const BOAR_TYPE_GLYPH: Record<string, string> = { boar: '🐗' };

export const predatorsPlugin = (options: PredatorsPluginOptions = {}): PredatorsPlugin => {
    // Chances are per world-minute — every tick hook call covers exactly one
    // world-minute (engine/world.ts sub-steps), so the rolls apply directly
    const arriveChance = options.arriveChancePerMinute ?? 0.006;
    const maxPredators = options.maxPredators ?? 2;
    const biteChance = options.biteChancePerMinute ?? 0.5;
    const biteDrain = options.biteDrain ?? 15;
    const biteDamage = options.biteDamage ?? 20;
    // The task ledger's busy gate — see the option docs
    const tasks = options.tasks ?? null;

    // The stat-driven roam economics — active only when BOTH the needs
    // plugin and the entity profiles are mounted (the same gating shape as
    // the birds and sharks plugins)
    const needs = options.needs ?? null;
    const profiles = options.profiles ?? null;
    const statRoam = needs !== null && profiles !== null;

    // THE PACE — the boar's Speed attribute IS the lumbering gait: the
    // profile's walk row says how many world minutes one tile costs
    // (Speed 6 → 2 minutes). An explicit option pins it over the derivation;
    // no profiles → the legacy pace.
    const pace = options.paceMinutes ?? profiles?.moveMinutesOf('boar', 'walk') ?? LEGACY_PACE;

    // Boar identity records — positions live in the coordinate space only
    const beasts = new Map<string, { name: string; marker: string }>();
    let released = 0;
    // The plugin's own fine clock — one world-minute per tick hook call.
    // The roaming pace reads THIS, not the ticker's step count: within one
    // step every minute must see its own time.
    let minute = 0;

    // The world + the plugin's persistent random stream arrive with setup —
    // release() draws its rim pick from the SAME stream the tick rolls use
    // (the registry caches one context per plugin id, engine/plugin.ts)
    let world: World | null = null;
    let random: (() => number) | null = null;

    /** Composes the public record: identity + live position from the space. */
    const recordOf = (id: string): PredatorRecord | undefined => {
        const beast = beasts.get(id);
        const position = world?.coordinates.positionOf(id);
        if (!beast || !position) {
            return undefined;
        }
        return { id, name: beast.name, marker: beast.marker, x: position.x, y: position.y };
    };

    /**
     * The outermost dry band of the island — the far shore boars wander in
     * from. The canvas EDGE is always open sea (the terrain generator's
     * island rule), so the rim itself is water everywhere; the band is the
     * dry land hugging it: land cells whose normalized rim distance
     * max(|x|/halfX, |y|/halfY) reaches `shoreBand` (0.85 — the same
     * elliptical metric the cast's shore ranking uses). Row-major over the
     * canvas cells.
     */
    const rimLandCells = (
        canvas: {
            width: number;
            height: number;
            cells: Array<{ x: number; y: number; passable: boolean }>;
        },
    ): Array<{ x: number; y: number }> => {
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const rim: Array<{ x: number; y: number }> = [];
        arrayEach(canvas.cells, ({ value: cell }) => {
            const shore = Math.max(Math.abs(cell.x) / (halfX || 1), Math.abs(cell.y) / (halfY || 1));
            if (cell.passable && shore >= SHORE_BAND) {
                rim.push({ x: cell.x, y: cell.y });
            }
        });
        return rim;
    };

    /** Spawns one boar at an explicit cell: monotonic id (despawned ids are
     * never reused), roster name, full facet into the coordinate space (never
     * into world.actors). */
    const spawnPredator = (
        active: World,
        cell: { x: number; y: number },
        name?: string,
    ): PredatorRecord => {
        released = released + 1;
        const id = `boar-${released}`;
        const boarName = name ?? BOAR_NAMES[(released - 1) % BOAR_NAMES.length];
        const marker = boarName.slice(0, 1);
        beasts.set(id, { name: boarName, marker });
        active.coordinates.place({
            id,
            position: position3(cell.x, cell.y),
            // The two-level taxonomy: a boar is a creature of type boar
            kind: 'creature',
            type: 'boar',
            name: boarName,
            marker,
            state: 'roaming',
        });
        active.events.emit({
            kind: 'spawn',
            actorId: id,
            message: `${boarName} wanders in from the wilds.`,
        });
        return recordOf(id) as PredatorRecord;
    };

    return {
        id: 'predators',
        label: 'Predators',

        setup: (context: PluginContext<World>) => {
            world = context.world;
            random = context.random;
        },

        release: (name) => {
            if (!world || !random) {
                throw new Error('predators plugin released before setup');
            }
            const active = world;
            const stream = random;
            const rim = rimLandCells(active.canvas);
            // Deterministic pick from the plugin's own stream; a canvas with
            // no rim land (all-water rim) leaves the wilds empty
            if (rim.length === 0) {
                return undefined;
            }
            return spawnPredator(active, rim[Math.floor(stream() * rim.length)], name);
        },

        predatorOf: recordOf,

        predators: () => Array.from(beasts.keys()).map((id) => recordOf(id) as PredatorRecord),

        dispose: () => {
            // The environment is gone entirely: boar records leave the
            // coordinate space along with the plugin's own state
            if (world) {
                beasts.forEach((_, id) => {
                    world?.coordinates.remove(id);
                });
            }
            beasts.clear();
            released = 0;
            minute = 0;
            world = null;
            random = null;
        },

        tick: (context: PluginContext<World>) => {
            if (!world) {
                return;
            }
            minute = minute + 1;
            // Local alias — the null check above does not survive into the
            // arrayEach closures (mutable outer variable)
            const active = world;
            const stream = context.random;

            // ── Fixed roll order ── ONE herd-level arrival roll comes FIRST
            // (before any per-boar roll — deterministic), then the per-boar
            // rolls run in id order. The roster is snapshotted before the
            // arrival: a boar that arrives this minute starts rolling next
            // minute.
            const order = Array.from(beasts.keys());
            if (stream() < arriveChance && beasts.size < maxPredators) {
                const rim = rimLandCells(active.canvas);
                if (rim.length > 0) {
                    spawnPredator(active, rim[Math.floor(stream() * rim.length)]);
                }
            }

            arrayEach(order, ({ value: id }) => {
                const beast = beasts.get(id);
                const position = active.coordinates.positionOf(id);
                if (!beast || !position) {
                    return;
                }
                // The bite: a castaway stands on the boar's tile — one roll
                // per world-minute. The hurt drains the victim's energy
                // (the needs plugin derives the weak/critical conditions
                // from it) and the mauling is a story between two entities
                // — it stays in the log.
                const victim = active.actorAt(position.x, position.y);
                if (victim && stream() < biteChance && needs) {
                    // The maul: the drain AND the wound — the health
                    // reservoir is what a cornered castaway can bleed dry
                    needs.satisfy(victim.id, { energy: -biteDrain, health: -biteDamage });
                    active.events.emit({
                        kind: 'attack',
                        actorId: victim.id,
                        message: `${beast.name} mauls ${victim.name}.`,
                    });
                }
                // THE TASK RESPECT — a boar with queued ledger tasks skips
                // its random roam this minute: the ledger's move tasks are
                // already walking it (the behavior plugin plans grounded
                // dry-land creatures), and two drivers would double-step
                if (tasks?.busy(id)) {
                    return;
                }
                // Roam: one land tile every `pace` world minutes — the
                // lumbering gait. A random in-bounds LAND neighbor — boars
                // never beach themselves in the water (a passable check
                // keeps the step dry); a cell with no land neighbor → the
                // boar stays put (no roll, no event). Silent roaming — the
                // log tells stories of meetings, not beast telemetry.
                if (minute % pace !== 0) {
                    return;
                }
                const halfX = (active.canvas.width - 1) / 2;
                const halfY = (active.canvas.height - 1) / 2;
                const land: Array<{ x: number; y: number }> = [];
                arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                    const x = position.x + offset.dx;
                    const y = position.y + offset.dy;
                    const inBounds = x >= -halfX && x <= halfX && y >= -halfY && y <= halfY;
                    if (inBounds && active.cellAt(x, y)?.passable === true) {
                        land.push({ x, y });
                    }
                });
                if (land.length === 0) {
                    return;
                }
                const step = land[Math.floor(stream() * land.length)];
                // THE EXHAUSTION HOLD — the land-pick roll is consumed either
                // way (the stream never shifts), but an exhausted boar stays
                // put instead of lumbering on. NO energy grant here (R4): the
                // recovery is the ledger's rest task (the behavior ladder
                // plans it at the tired line — the busy gate above yields
                // the roam to it while it runs), paid by the needs recovery
                // service out of equal hunger/thirst.
                if (statRoam && needs && needs.of(id).energy <= GRAZE_ENERGY) {
                    return;
                }
                active.coordinates.move(id, position3(step.x, step.y));
                // The tile's burn: roaming charges the profile's walk row
                // (stamina-scaled — see entityPlugin)
                if (statRoam && needs) {
                    needs.moved(id, 'walk');
                }
            });
        },
    };
};
