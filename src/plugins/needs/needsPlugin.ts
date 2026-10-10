// The needs environment plugin — hunger, thirst, energy AND health for
// EVERY entity.
//
// Every tick hook call covers ONE world-minute (engine/world.ts sub-steps a
// step's minutes one at a time), so the decay rates are plain per-minute
// rates: survival pressure is identical at every view scale. The actor's
// `condition` is derived here.
//
// ALL ENTITIES, NOT ONLY CASTAWAYS: every living thing in the coordinate
// space (world.actors AND the creatures the bird/shark/predator plugins
// coin) carries the survival stats. Per-type decay rates and starting
// values come from the entity profiles plugin (plugins/entity/entityPlugin.ts
// — passed as the `profiles` option); species without a profile (or runs
// without the entity plugin) fall back to the stock castaway rates.
//
// ── HEALTH — the reservoir between an entity and death ──────────────────────
// Health is a WELLBEING value (100 = healthy, 0 = dead), the fourth survival
// stat. It only moves when something hurts the entity:
//   starvation   — hunger and thirst each carry their OWN realistic health
//                  drain while they sit at the 100 (empty) line, calibrated
//                  to real-life-equivalent in-game horizons (1440 minutes a
//                  day, scenario/dayCycle.ts):
//                    thirst empty — 100 / (3.5 × 1440) health per minute:
//                                  a body at FULL health dies of thirst in
//                                  3.5 in-game days (the 3–4 day window)
//                    hunger empty — 100 / (10 × 1440) health per minute:
//                                  a body at FULL health starves in ~10
//                                  in-game days
//                  Both empty the drains are ADDITIVE (death ≈ 2.6 days).
//                  There is no rapid 30-minute doom any more — the deficit
//                  itself is the slow wound, and a FED belly's regen never
//                  negates it (damage and regen stay mutually exclusive:
//                  any empty line wounds, they never heal the same minute).
//   wounds       — a predator's bite drains health straight through
//                  satisfy (plugins/predators).
//   regen        — a FED and WATERED entity (hunger ≤ 50, thirst ≤ 50)
//                  heals `healthRegenPerMinute` per world minute — wounds
//                  close while the belly is full.
//   passive      — the species profile's stats.health drain (0 for every
//                  stock species — no species sickens on its own).
// EXHAUSTION stays a SEPARATE axis: energy at 0 reads critical and forces
// the rest/sleep rungs (plugins/sleep, plugins/behavior) but never drains
// health by itself — tired is not wounded; sleep is what fixes it, and the
// recovery service's metabolic charge (below) is what pays for it.
// DEATH AT ZERO — THE ONE KILLER: when health reaches 0 the entity dies.
// EVERY entity — castaway or creature. The health reservoir IS the doom
// (its two deficit drains are calibrated to the realistic horizons above),
// and a creature whose health bottoms out dies the same way its registry
// cousins do. A dead coordinate-space creature is removed from the space
// directly (world.despawn only reaches the actor registry).
//
// Creature conditions are NOT written into the coordinate facet: a bird's
// facet state is its altitude band ('flying-N', plugins/birds), which the
// needs sweep must never overwrite. The god-view derives a creature's
// condition dot from its stat values (the exported conditionOf + the
// roster's needsDisplay).
//
// ── OFF-SPACE RESIDENTS — the living bodies outside the coordinate space ────
// An aloft seabird (plugins/birds) leaves the coordinate space at the fade
// limit while its flock record keeps it ALIVE — the vanish is a render-level
// fade, not a death. The sweep therefore decays provider-reported residents
// exactly like every visible body: the species profile's rates (the flight
// metabolism's energy drain rides the same rates — aloft drift crosses no
// tiles, so the per-tile fly-row charges stay on the birds plugin's actual
// glides), the stat record RETAINED across the fade (a descent continues the
// same life — no fresh full-stat body), and a health-zero death buried
// through the provider's remove (the flock record goes with the body — no
// resurrection on a later descent).
//
// Threshold crossings are NOT logged — the log is a story teller (the
// scenario system's encounters), and a need crossing is a solo state
// change, not a story between entities. Death stays in the log: it is the
// story's ending.

import { arrayEach } from '@presource/core';
import type { World } from '../../engine/world';
import type { ActorCondition } from '../../engine/types';
import type { MoveKind, EntityProfiles, EntityStats } from '../entity/entityPlugin';
// R6-INTEGRATION — the human belly-accumulation defaults are the entity
// registry's own derived rates (the day-horizon constants above the stock
// human profile, plugins/entity/entityPlugin.ts) — one vocabulary: the
// no-profile fallback and the mounted human profile can never disagree.
import { HUMAN_HUNGER_PER_MINUTE, HUMAN_THIRST_PER_MINUTE } from '../entity/entityPlugin';
// R6 — the shared clock contract (DAY_MINUTES 1440): the starvation horizons
// are stated in IN-GAME DAYS, so the per-minute drains derive from this file
// (imported, never edited here — the terrain worker owns it).
import { DAY_MINUTES } from '../../scenario/dayCycle';
import type { PluginContext, WorldPlugin } from '@godspace/core';

export type NeedsPluginOptions = {
    /**
     * R4/T6 — the task ledger read (plugins/tasks/taskLedger.ts, passed by
     * the scenario assembly). The sweep reads each body's HEAD task kind to
     * know whether it is mid-REST-or-SLEEP this minute: a resting body's
     * awake hunger/thirst decay is SUSPENDED — the recovery service's equal
     * charge (needs.recovery, called by the sleep/rest governance while the
     * task executes) is the only hunger/thirst movement of a resting
     * minute, so the minute's total spend is EQUAL, never the unequal awake
     * baseline plus an extra equal cost on top. Absent (a run without the
     * tasks plugin): no body ever reads as resting and the flat awake
     * metabolism applies to everyone (the pre-ledger behavior).
     */
    tasks?: {
        taskOf(entityId: string): { kind: string } | undefined;
    };
    /**
     * Hunger points per world minute. Default 100/(2×1440) ≈ 0.0347 — the
     * no-profile fallback, derived from the human hunger accumulation horizon
     * (2 in-game days 0→empty, entityPlugin's HUMAN_HUNGER_HORIZON_DAYS).
     */
    hungerPerMinute?: number;
    /**
     * Thirst points per world minute. Default 100/1440 ≈ 0.0694 — the
     * no-profile fallback, derived from the human thirst accumulation
     * horizon (1 in-game day 0→empty, HUMAN_THIRST_HORIZON_DAYS).
     */
    thirstPerMinute?: number;
    /** Energy drain per world minute. Default 0.06. */
    energyPerMinute?: number;
    /**
     * R6 — Health points one world minute of EMPTY THIRST (thirst at the
     * 100 line) drains. Default 100 / (3.5 × 1440): a body at full health
     * dies of thirst exactly 3.5 in-game days (5040 world minutes) after
     * the line — the real-life-equivalent 3–4 day window. An explicit
     * option pins its own pace (tests use fast horizons).
     */
    thirstDamagePerMinute?: number;
    /**
     * R6 — Health points one world minute of EMPTY HUNGER (hunger at the
     * 100 line) drains. Default 100 / (10 × 1440): a body at full health
     * starves ~10 in-game days (14400 world minutes) after the line. With
     * BOTH lines empty the two drains are additive.
     */
    hungerDamagePerMinute?: number;
    /**
     * R4 — the recovery service's METABOLIC CHARGE RATIO: hunger AND thirst
     * points charged per energy point restored (each, equally). Default
     * 0.25 — the old 1:1 made a night's sanctioned sleep the dominant
     * consumption of the day (78 restored energy = 78 hunger + 78 thirst,
     * ~12× the awake per-minute belly rates); at 0.25 a full night's
     * recovery costs a quarter of what it restored, comfortably under the
     * awake day's own spend, so REST pays for itself without eating the
     * cast alive. The charge stays EQUAL across the charged resources and
     * still scales with the ACTUAL restore (capped requests charge less).
     */
    recoveryChargeRatio?: number;
    /**
     * Health points a FED entity (hunger ≤ 50 AND thirst ≤ 50) heals per
     * world minute. Default 0.2 — a full belly closes wounds slowly.
     */
    healthRegenPerMinute?: number;
    /**
     * The entity profiles (plugins/entity/entityPlugin.ts) — per-type stat
     * decay rates and starting values for EVERY entity. Absent: the legacy
     * flat rates above apply to everyone.
     */
    profiles?: EntityProfiles;
};

/** The four survival stats. hunger/thirst press UP, energy/health are
 * wellbeing reservoirs that count DOWN (0 = collapsing / dying). */
export type NeedsState = {
    hunger: number;
    thirst: number;
    energy: number;
    /** Wellbeing reservoir — 100 = healthy, 0 = dead (the killer stat). */
    health: number;
};

// ── Off-space residents ─────────────────────────────────────────────────────
// The living bodies that live OUTSIDE the coordinate space — an aloft
// seabird's fade-out (plugins/birds removes the coordinate entry at z ≥ the
// fade limit while the flock record keeps the body alive). The needs sweep
// reads them through this provider so their stats decay like every visible
// body's, and buries them through it at health zero.

/** One living off-space body — the identity the sweep decays by. */
export type OffSpaceResident = {
    /** The body's id (the stat record's key). */
    id: string;
    /** WHICH the body is — the species profile key ('bird', …). */
    type: string;
    /** The display name — the death line reads it ("Kiki has died."). */
    name?: string;
};

/** A provider plugin's registry of its living off-space bodies. */
export type OffSpaceResidents = {
    /**
     * The living off-space residents at this minute — the sweep builds its
     * entity set from these (deduped against the registry and the space).
     */
    all(): OffSpaceResident[];
    /**
     * Removes a dead body's off-space residence — the flock record and any
     * private state go with it, so nothing can resurrect the body later (a
     * descent re-places only ids the provider still holds). Unknown ids are
     * a silent no-op.
     */
    remove(entityId: string): void;
};

export type NeedsPlugin = WorldPlugin<World> & {
    /** An entity's needs — auto-created at starting values on first touch. */
    of(entityId: string): NeedsState;
    /**
     * Applies deltas (e.g. `{ hunger: -14 }` after eating, `{ health: -20 }`
     * after a bite). All four values clamp to 0..100.
     *
     * THE GOD ROUTE — satisfy is the direct, unaccounted write and stays
     * that way on purpose: the god-view handle and the test fixtures drive
     * it (an explicit out-of-simulation intervention). R4 keeps the
     * IN-SIMULATION callers honest instead — every sanctioned rest/sleep
     * energy gain routes through `recovery` below, and the story
     * encounters' positive energy deltas are dropped at the story plugin's
     * stage boundary (plugins/story/storyPlugin.ts — a story is not a
     * rest/sleep task, so nothing restores; the negative deltas ride).
     * NO unaccounted positive-energy caller remains: the construction
     * plugin's shelter rest bonus (plugins/construction/
     * constructionPlugin.ts shelterRest — +0.5/min during a sleep/rest
     * task on a built roofed gate) rides `recovery` too (T6), so the
     * bonus energy is charged against hunger/thirst exactly like every
     * other rest gain.
     */
    satisfy(entityId: string, deltas: Partial<NeedsState>): void;
    /**
     * R4 — THE RECOVERY SERVICE: the ONLY sanctioned route for rest/sleep
     * energy gains. Converts a requested energy top-up into an actual
     * restore that is BACKED BY THE BODY'S RESOURCES: every point of
     * energy restored charges the body's hunger AND thirst equally (each
     * by `recoveryChargeRatio` — the metabolic conversion cost, default
     * 0.25 so rest is never the dominant consumption; a species without a
     * pressure — the shark's rate-0 thirst — is not charged it, so
     * "equal" binds within the resources the body actually spends).
     * Limits, all enforced here:
     *   energy cap   — the restore is capped at the 100 headroom and the
     *                  charge equals the ACTUAL restore: a capped request
     *                  charges nothing (no phantom cost at the cap).
     *   empty source — the charge room is the TIGHTER of the charged
     *                  resources' headroom divided by the ratio: a resource
     *                  at 100 (no room to consume) yields NO energy (nothing
     *                  converts from an empty source) and charges nothing.
     * Returns the actual energy points restored (0 when capped or
     * resource-blocked). Call sites: the sleep plugin's per-minute restore
     * (while the sleep task progresses) and the behavior plugin's rest
     * completion (+12 once per rest task) — energy increases only while an
     * actual rest/sleep task runs, resource-backed.
     */
    recovery(entityId: string, requestedEnergy: number): number;
    /**
     * Charges the movement energy of crossing ONE Scale-0 tile. The cost
     * comes from the entity profile's movement table (attributes-derived —
     * see the entity plugin); `moveKind` selects the table row (walk, run,
     * swim, fly). A kind the entity has no ability for falls back to its
     * walk cost, then to the legacy flat point. Without profiles the cost
     * is the legacy flat point (1 energy per crossing).
     */
    moved(entityId: string, moveKind?: MoveKind): void;
    /**
     * Registers a provider of living OFF-SPACE residents (see
     * OffSpaceResidents) — an aloft seabird's fade-out lives outside the
     * coordinate space, and the sweep decays those bodies like every living
     * thing (their stat records retained across the fade) and buries them
     * at health zero through the provider's remove. Returns the
     * unsubscribe — the provider plugin's dispose hook tears the
     * registration down with its environment.
     */
    residents(provider: OffSpaceResidents): () => void;
};

/** Starting values — a fresh arrival is a little hungry and thirsty, and unharmed. */
const STARTING_STATE: NeedsState = { hunger: 20, thirst: 20, energy: 100, health: 100 };

/** The legacy flat move energy (one point per tile crossing). */
const LEGACY_MOVE_ENERGY = 1;

/** Hunger/thirst line at which starvation starts draining health. */
const STARVATION_LINE = 100;

/** Hunger/thirst a body must be under to heal (the belly-full rule). */
const REGEN_LINE = 50;

/**
 * R6 — the realistic health-attrition horizons in in-game days (1440
 * world-minutes each, scenario/dayCycle.ts DAY_MINUTES): empty thirst kills
 * a full-health body in 3.5 days (the 3–4 day window the island asks for),
 * empty hunger in 10 days. The per-minute drains are derived from these so
 * the death timing IS the horizon, exactly.
 */
const THIRST_DOOM_DAYS = 3.5;
const HUNGER_DOOM_DAYS = 10;

/**
 * The condition ladder from the worst need. Shared by the sweep (castaway
 * condition writes) and the god-view (creature condition dots) — the same
 * thresholds everywhere. Health joins the ladder: a wounded body reads
 * weak at ≤ 50 and critical at ≤ 25 whatever its belly says.
 */
export const conditionOf = (state: NeedsState): Exclude<ActorCondition, 'gone'> => {
    if (state.hunger >= 90 || state.thirst >= 90 || state.energy <= 10 || state.health <= 25) {
        return 'critical';
    }
    if (state.hunger >= 70 || state.thirst >= 70 || state.energy <= 25 || state.health <= 50) {
        return 'weak';
    }
    return 'well';
};

const clamp01 = (value: number): number => Math.max(0, Math.min(100, value));

export const needsPlugin = (options: NeedsPluginOptions = {}): NeedsPlugin => {
    // R6-INTEGRATION — the fallback belly rates ARE the human profile's
    // day-horizon-derived rates (see the option docs + entityPlugin)
    const hungerPerMinute = options.hungerPerMinute ?? HUMAN_HUNGER_PER_MINUTE;
    const thirstPerMinute = options.thirstPerMinute ?? HUMAN_THIRST_PER_MINUTE;
    const energyPerMinute = options.energyPerMinute ?? 0.06;
    // R6 — THE TWO DEFICIT DRAINS — each empty line wounds health at its own
    // realistic pace: thirst kills a full-health body in THIRST_DOOM_DAYS
    // in-game days, hunger in HUNGER_DOOM_DAYS (100 health / the horizon's
    // minutes). With BOTH lines empty the drains stack additively. An
    // explicit option pins its own pace (fast-horizon tests).
    const thirstDamage =
        options.thirstDamagePerMinute ?? 100 / (THIRST_DOOM_DAYS * DAY_MINUTES);
    const hungerDamage =
        options.hungerDamagePerMinute ?? 100 / (HUNGER_DOOM_DAYS * DAY_MINUTES);
    // R4 — the recovery service's metabolic charge per restored point
    const chargeRatio = options.recoveryChargeRatio ?? 0.25;
    const healthRegen = options.healthRegenPerMinute ?? 0.2;
    // The entity profiles — per-type rates and starts. Null: the legacy
    // flat castaway rates apply to every entity (the pre-entity behavior).
    const profiles = options.profiles ?? null;
    // The ledger read — the sweep's resting-metabolism signal (see the
    // option doc). Null: nobody ever rests (the flat awake metabolism runs
    // for every entity every minute).
    const tasksDep = options.tasks ?? null;

    // The head-task kinds that mark a body as resting this minute: the
    // sleep plugin's timed slumber and the behavior plugin's rest fallback.
    // Both route their energy gains through the recovery service, so a
    // resting minute's hunger/thirst spend is the service's EQUAL charge
    // alone — the awake baseline is suspended for the minute.
    const RESTING_KINDS = new Set(['sleep', 'rest']);

    // Internal stat records — the health reservoir rides along
    const states = new Map<string, NeedsState>();

    // The off-space resident providers — the living bodies outside the
    // coordinate space (an aloft bird's fade-out, plugins/birds). Registered
    // at the provider plugin's setup, torn down at its dispose.
    const residents = new Set<OffSpaceResidents>();

    // The world arrives with setup — the per-type rate/start resolution
    // reads entity types through it (world.actors for castaways, the
    // coordinate space's facet for creatures)
    let world: World | null = null;

    /** WHICH an entity is — the profile key. Actors carry it in the
     * registry, creatures in their coordinate facet, and the OFF-SPACE
     * residents (an aloft bird) in their provider's registry. Unknown →
     * undefined. */
    const typeOf = (entityId: string): string | undefined => {
        const registered = world?.actors.get(entityId)?.type;
        if (registered !== undefined) {
            return registered;
        }
        const entry = world?.coordinates.entryOf(entityId);
        if (entry?.type !== undefined) {
            return entry.type;
        }
        // Off-space residents: the provider plugins hold the living species
        // identity (arrayEach returns the first non-undefined callback
        // value — the first provider that knows the id wins)
        return arrayEach(Array.from(residents), ({ value: provider }) => {
            const found = provider.all().find((candidate) => candidate.id === entityId);
            return found ? found.type : undefined;
        });
    };

    /** The decay rates of one entity — its species profile or the legacy flat rates. */
    const ratesOf = (entityId: string): EntityStats => {
        const profile = profiles?.profileOf(typeOf(entityId) ?? '');
        return (
            profile?.stats ?? {
                hunger: hungerPerMinute,
                thirst: thirstPerMinute,
                energy: energyPerMinute,
                health: 0,
            }
        );
    };

    /** The starting stats of one entity — its species profile or the stock
     * arrival. A profile without a health start (older test doubles) wakes
     * with a full reservoir. */
    const startOf = (entityId: string): NeedsState => {
        const profile = profiles?.profileOf(typeOf(entityId) ?? '');
        if (!profile) {
            return STARTING_STATE;
        }
        const start = profile.start;
        return {
            hunger: start.hunger,
            thirst: start.thirst,
            energy: start.energy,
            health: start.health ?? 100,
        };
    };

    /** The energy cost of crossing one tile with a movement kind — the
     * profile's row, falling back to the entity's walk row, then the
     * legacy flat point. */
    const moveCostOf = (entityId: string, moveKind: MoveKind): number => {
        if (!profiles) {
            return LEGACY_MOVE_ENERGY;
        }
        const type = typeOf(entityId) ?? '';
        return (
            profiles.moveEnergyOf(type, moveKind) ??
            profiles.moveEnergyOf(type, 'walk') ??
            LEGACY_MOVE_ENERGY
        );
    };

    const stateOf = (entityId: string) => {
        const existing = states.get(entityId);
        if (existing) {
            return existing;
        }
        const fresh = { ...startOf(entityId) };
        states.set(entityId, fresh);
        return fresh;
    };

    /** Kills one entity: a registry actor despawns through the world (the
     * "is no more." line + registry + coordinate cleanup), a coordinate-only
     * creature leaves the space directly (world.despawn only reaches the
     * registry) — and the OFF-SPACE residents (an aloft bird) lose their
     * provider-held residence too: the flock record goes with the body, so
     * a later descent cannot resurrect the dead (the birds plugin re-places
     * only ids its flock still holds). Either way the death lands in the
     * log — it is the story's ending — and the stat record goes with the
     * body. */
    const kill = (active: World, entityId: string, name: string) => {
        const actor = active.actors.get(entityId);
        if (actor) {
            active.despawn(entityId);
        } else {
            // The coordinate cleanup first (a visible creature's facet
            // leaves the space; a no-op for an off-space resident — it
            // holds no entry), then every provider drops its own living
            // residence. Block body: all providers are consulted, none may
            // short-circuit the walk.
            active.coordinates.remove(entityId);
            arrayEach(Array.from(residents), ({ value: provider }) => {
                provider.remove(entityId);
            });
        }
        active.events.emit({
            kind: 'death',
            actorId: entityId,
            message: `${name} has died.`,
        });
        states.delete(entityId);
    };

    return {
        id: 'needs',
        label: 'Survival Needs',

        setup: (context: PluginContext<World>) => {
            // The per-type resolution reads the world through this handle
            world = context.world;
        },

        of: (entityId) => {
            const state = stateOf(entityId);
            // Expose the plain needs quadruple
            return {
                hunger: state.hunger,
                thirst: state.thirst,
                energy: state.energy,
                health: state.health,
            };
        },

        satisfy: (entityId, deltas) => {
            const state = stateOf(entityId);
            if (deltas.hunger !== undefined) {
                state.hunger = clamp01(state.hunger + deltas.hunger);
            }
            if (deltas.thirst !== undefined) {
                state.thirst = clamp01(state.thirst + deltas.thirst);
            }
            if (deltas.energy !== undefined) {
                state.energy = clamp01(state.energy + deltas.energy);
            }
            if (deltas.health !== undefined) {
                state.health = clamp01(state.health + deltas.health);
            }
        },

        recovery: (entityId, requestedEnergy) => {
            // Nothing converts from nothing: a non-positive request is a
            // silent no-op (the callers only ever ask for positive rates).
            if (!(requestedEnergy > 0)) {
                return 0;
            }
            const state = stateOf(entityId);
            // THE CHARGE SET — the resources the body's metabolism actually
            // consumes (its species' hunger/thirst decay rates; the legacy
            // flat rates when no profiles stand). A species without a
            // pressure is never charged it: the shark lives in its drink
            // (rate-0 thirst), so its recovery cost is hunger alone.
            const rates = ratesOf(entityId);
            const charged: Array<'hunger' | 'thirst'> = [];
            if (rates.hunger > 0) {
                charged.push('hunger');
            }
            if (rates.thirst > 0) {
                charged.push('thirst');
            }
            // THE ROOM — the tighter charged resource's headroom DIVIDED by
            // the charge ratio: the equal charge (actual × ratio) can only
            // rise until the FIRST resource fills. An empty charged resource
            // (at the 100 line) yields no energy at all — nothing converts
            // from an empty source.
            let room = Infinity;
            charged.forEach((key) => {
                room = Math.min(room, (100 - state[key]) / chargeRatio);
            });
            // THE ACTUAL RESTORE — the request capped by the energy headroom
            // (at the cap the restore is 0 and NOTHING is charged — no
            // phantom cost) and by the resource room (an empty source
            // blocks the gain entirely).
            const actual = Math.min(requestedEnergy, 100 - state.energy, room);
            if (!(actual > 0)) {
                return 0;
            }
            // The restore and the EQUAL metabolic charge: every charged
            // resource rises by the same amount — the restored energy times
            // the charge ratio (default 0.25: rest pays for itself at a
            // quarter of its gain, never the day's dominant consumption).
            // The cost is limited by the actual restore, never the request.
            state.energy = clamp01(state.energy + actual);
            charged.forEach((key) => {
                state[key] = clamp01(state[key] + actual * chargeRatio);
            });
            return actual;
        },

        moved: (entityId, moveKind = 'walk') => {
            const state = stateOf(entityId);
            state.energy = clamp01(state.energy - moveCostOf(entityId, moveKind));
        },

        residents: (provider) => {
            // The provider registry — one entry per resident plugin (the
            // birds plugin registers in setup, unsubscribes in dispose)
            residents.add(provider);
            return () => {
                residents.delete(provider);
            };
        },

        dispose: () => {
            states.clear();
            // The provider registry goes with the environment — a swapped-out
            // needs plugin must not keep decaying into its replacement (the
            // provider plugins' own unsubscribes become no-ops, which is
            // exactly what a dispose means)
            residents.clear();
            world = null;
        },

        tick: (context: PluginContext<World>) => {
            const { world: active } = context;
            // One tick hook call = one world-minute (the world sub-steps its
            // steps) — decay applies per entity from ITS species' rates
            // (profiles) or the flat legacy rates.

            // EVERY living entity: the castaway registry PLUS every creature
            // in the coordinate space, deduped (castaways live in both), PLUS
            // the OFF-SPACE residents the provider plugins report — an aloft
            // bird left the space at the fade limit while its flock record
            // keeps it alive, so the sweep keeps decaying it here (by its
            // species profile — the flight metabolism's drain rides the same
            // rates; the per-tile fly-row charges stay on the birds plugin's
            // actual glides, and aloft drift crosses no tiles).
            const entityIds = new Set<string>(active.actors.keys());
            active.coordinates.all().forEach((entry) => entityIds.add(entry.id));
            const offSpace = new Map<string, OffSpaceResident>();
            arrayEach(Array.from(residents), ({ value: provider }) => {
                arrayEach(provider.all(), ({ value: resident }) => {
                    // Dedup: a body the registry or the space already holds
                    // is not off-space (a provider's view may lag a minute)
                    if (!entityIds.has(resident.id) && !offSpace.has(resident.id)) {
                        offSpace.set(resident.id, resident);
                        entityIds.add(resident.id);
                    }
                });
            });
            arrayEach(Array.from(entityIds), ({ value: entityId }) => {
                const state = stateOf(entityId);
                const rates = ratesOf(entityId);

                // ── THE RESTING METABOLISM (R4/T6) ── a body whose head
                // task is the sleep plugin's slumber or the behavior
                // plugin's rest fallback is RECOVERING: its awake
                // hunger/thirst decay is suspended for the minute — the
                // recovery service's EQUAL charge (needs.recovery, applied
                // by the sleep/rest governance later in this same minute)
                // is the minute's whole hunger/thirst movement, so the
                // total spend of a recovery minute is equal, never the
                // unequal awake baseline with an extra equal cost on top.
                // The energy decay still runs (the body's idle burn — the
                // restore outpaces it), and everything else (the passive
                // species drain, the starvation damage, the fed regen)
                // applies exactly as awake.
                const head = tasksDep?.taskOf(entityId);
                const resting = head !== undefined && RESTING_KINDS.has(head.kind);

                if (!resting) {
                    state.hunger = clamp01(state.hunger + rates.hunger);
                    state.thirst = clamp01(state.thirst + rates.thirst);
                }
                state.energy = clamp01(state.energy - rates.energy);
                // The passive species drain — 0 for every stock species; an
                // ailing species profile could sicken its bodies slowly
                if (rates.health > 0) {
                    state.health = clamp01(state.health - rates.health);
                }

                // ── THE HEALTH RESERVOIR (R6) ── each empty line wounds at
                // its own realistic pace (thirst 3.5 days, hunger ~10 days
                // from full health; additive when BOTH are empty), a fed
                // body heals. Damage and regen stay mutually exclusive — a
                // fed belly NEVER negates the deficit's wound in the same
                // minute (any line at 100 means damage only). A DRY
                // reservoir never regenerates — health 0 is death, not a
                // scratch to sleep off.
                const thirstEmpty = state.thirst >= STARVATION_LINE;
                const hungerEmpty = state.hunger >= STARVATION_LINE;
                const deficitDamage =
                    (thirstEmpty ? thirstDamage : 0) + (hungerEmpty ? hungerDamage : 0);
                if (deficitDamage > 0) {
                    state.health = clamp01(state.health - deficitDamage);
                } else if (
                    state.hunger <= REGEN_LINE &&
                    state.thirst <= REGEN_LINE &&
                    state.health > 0 &&
                    state.health < 100
                ) {
                    state.health = clamp01(state.health + healthRegen);
                }

                // DEATH AT ZERO — the one killer, for EVERY entity. A
                // starved castaway, a mauled castaway, a gull at the end of
                // its metabolism: the reservoir runs dry and the body goes.
                if (state.health <= 0) {
                    const entry = active.coordinates.entryOf(entityId);
                    // The name: the coordinate facet's, the off-space
                    // resident's, or the bare id
                    const resident = offSpace.get(entityId);
                    kill(active, entityId, entry?.name ?? resident?.name ?? entityId);
                    return;
                }

                // Derive the visible condition — castaways carry it on the
                // record and mirror it into the coordinate facet so the
                // representation plugins color the glyph live
                const actor = active.actors.get(entityId);
                if (actor) {
                    actor.condition = conditionOf(state);
                    active.retag(entityId, { state: actor.condition });
                }
                // Creatures: no facet write — a bird's facet state is its
                // altitude band (plugins/birds), never a condition
            });

            // Prune states of entities no longer in the world — despawned
            // bodies delete their own state above; vanished creatures
            // (a glide past the world's edge, a sweep out with the tide)
            // are cleaned up here. The OFF-SPACE residents keep theirs: an
            // aloft bird is alive and flying outside the space's reach —
            // its record decays on, so a descent continues the same life
            // instead of waking a fresh full-stat body.
            states.forEach((_, entityId) => {
                if (
                    !active.actors.has(entityId) &&
                    active.coordinates.entryOf(entityId) === undefined &&
                    !offSpace.has(entityId)
                ) {
                    states.delete(entityId);
                }
            });
        },
    };
};
