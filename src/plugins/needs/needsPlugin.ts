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
//   starvation   — hunger or thirst sitting at the 100 line damages health
//                  every minute (`starveDamagePerMinute`, defaulting to
//                  100 / doomMinutes so the death timing is the doom
//                  window's: an entity that stays maxed dies exactly
//                  `doomMinutes` world minutes after the line is reached).
//   wounds       — a predator's bite drains health straight through
//                  satisfy (plugins/predators).
//   regen        — a FED and WATERED entity (hunger ≤ 50, thirst ≤ 50)
//                  heals `healthRegenPerMinute` per world minute — wounds
//                  close while the belly is full.
//   passive      — the species profile's stats.health drain (0 for every
//                  stock species — no species sickens on its own).
// DEATH AT ZERO — THE ONE KILLER: when health reaches 0 the entity dies.
// EVERY entity — castaway or creature. The old castaway-only doom ladder is
// gone: the health reservoir IS the doom (its drain rate is calibrated so a
// starving castaway still dies exactly `doomMinutes` after the hunger/thirst
// line), and a creature whose health bottoms out dies the same way its
// registry cousins do. A dead coordinate-space creature is removed from the
// space directly (world.despawn only reaches the actor registry).
//
// Creature conditions are NOT written into the coordinate facet: a bird's
// facet state is its altitude band ('flying-N', plugins/birds), which the
// needs sweep must never overwrite. The god-view derives a creature's
// condition dot from its stat values (the exported conditionOf + the
// roster's needsDisplay).
//
// Threshold crossings are NOT logged — the log is a story teller (the
// scenario system's encounters), and a need crossing is a solo state
// change, not a story between entities. Death stays in the log: it is the
// story's ending.

import { arrayEach } from '@presource/core';
import type { World } from '../../engine/world';
import type { ActorCondition } from '../../engine/types';
import type { MoveKind, EntityProfiles, EntityStats } from '../entity/entityPlugin';
import type { PluginContext, WorldPlugin } from '@godspace/core';

export type NeedsPluginOptions = {
    /** Hunger points per world minute. Default 0.1 — the no-profile fallback. */
    hungerPerMinute?: number;
    /** Thirst points per world minute. Default 0.15. */
    thirstPerMinute?: number;
    /** Energy drain per world minute. Default 0.06. */
    energyPerMinute?: number;
    /**
     * Minutes an entity survives AT THE 100 hunger/thirst line before
     * dying. Default 30 world minutes. The starvation damage default is
     * derived from it (100 / doomMinutes per minute) so the death timing
     * stays exactly this window — through the health reservoir now.
     */
    doomMinutes?: number;
    /**
     * Health points one world minute of starvation (hunger or thirst at
     * 100) drains. Default 100 / doomMinutes — death exactly one doom
     * window after the line is hit.
     */
    starveDamagePerMinute?: number;
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

export type NeedsPlugin = WorldPlugin<World> & {
    /** An entity's needs — auto-created at starting values on first touch. */
    of(entityId: string): NeedsState;
    /**
     * Applies deltas (e.g. `{ hunger: -14 }` after eating, `{ energy: 12 }`
     * after resting, `{ health: -20 }` after a bite). All four values clamp
     * to 0..100.
     */
    satisfy(entityId: string, deltas: Partial<NeedsState>): void;
    /**
     * Charges the movement energy of crossing ONE Scale-0 tile. The cost
     * comes from the entity profile's movement table (attributes-derived —
     * see the entity plugin); `moveKind` selects the table row (walk, run,
     * swim, fly). A kind the entity has no ability for falls back to its
     * walk cost, then to the legacy flat point. Without profiles the cost
     * is the legacy flat point (1 energy per crossing).
     */
    moved(entityId: string, moveKind?: MoveKind): void;
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
    const hungerPerMinute = options.hungerPerMinute ?? 0.1;
    const thirstPerMinute = options.thirstPerMinute ?? 0.15;
    const energyPerMinute = options.energyPerMinute ?? 0.06;
    const doomMinutes = options.doomMinutes ?? 30;
    // The starvation damage — calibrated off the doom window so a starving
    // entity dies exactly `doomMinutes` after its hunger/thirst hits the
    // line (100 health / damage-per-minute = the window). An explicit
    // option pins its own pace.
    const starveDamage =
        options.starveDamagePerMinute ?? (doomMinutes > 0 ? 100 / doomMinutes : 100);
    const healthRegen = options.healthRegenPerMinute ?? 0.2;
    // The entity profiles — per-type rates and starts. Null: the legacy
    // flat castaway rates apply to every entity (the pre-entity behavior).
    const profiles = options.profiles ?? null;

    // Internal stat records — the health reservoir rides along
    const states = new Map<string, NeedsState>();

    // The world arrives with setup — the per-type rate/start resolution
    // reads entity types through it (world.actors for castaways, the
    // coordinate space's facet for creatures)
    let world: World | null = null;

    /** WHICH an entity is — the profile key. Actors carry it in the
     * registry, creatures in their coordinate facet. Unknown → undefined. */
    const typeOf = (entityId: string): string | undefined =>
        world?.actors.get(entityId)?.type ?? world?.coordinates.entryOf(entityId)?.type;

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
     * registry). Either way the death lands in the log — it is the
     * story's ending — and the stat record goes with the body. */
    const kill = (active: World, entityId: string, name: string) => {
        const actor = active.actors.get(entityId);
        if (actor) {
            active.despawn(entityId);
        } else {
            active.coordinates.remove(entityId);
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

        moved: (entityId, moveKind = 'walk') => {
            const state = stateOf(entityId);
            state.energy = clamp01(state.energy - moveCostOf(entityId, moveKind));
        },

        dispose: () => {
            states.clear();
            world = null;
        },

        tick: (context: PluginContext<World>) => {
            const { world: active } = context;
            // One tick hook call = one world-minute (the world sub-steps its
            // steps) — decay applies per entity from ITS species' rates
            // (profiles) or the flat legacy rates.

            // EVERY living entity: the castaway registry PLUS every creature
            // in the coordinate space, deduped (castaways live in both).
            const entityIds = new Set<string>(active.actors.keys());
            active.coordinates.all().forEach((entry) => entityIds.add(entry.id));
            arrayEach(Array.from(entityIds), ({ value: entityId }) => {
                const state = stateOf(entityId);
                const rates = ratesOf(entityId);

                state.hunger = clamp01(state.hunger + rates.hunger);
                state.thirst = clamp01(state.thirst + rates.thirst);
                state.energy = clamp01(state.energy - rates.energy);
                // The passive species drain — 0 for every stock species; an
                // ailing species profile could sicken its bodies slowly
                if (rates.health > 0) {
                    state.health = clamp01(state.health - rates.health);
                }

                // ── THE HEALTH RESERVOIR ── starvation wounds, a fed body
                // heals. Damage and regen are mutually exclusive (a body is
                // never starving and full-bellied in the same minute). A
                // DRY reservoir never regenerates — health 0 is death, not
                // a scratch to sleep off.
                const starving =
                    state.hunger >= STARVATION_LINE || state.thirst >= STARVATION_LINE;
                if (starving) {
                    state.health = clamp01(state.health - starveDamage);
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
                    kill(active, entityId, entry?.name ?? entityId);
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
            // are cleaned up here
            states.forEach((_, entityId) => {
                if (
                    !active.actors.has(entityId) &&
                    active.coordinates.entryOf(entityId) === undefined
                ) {
                    states.delete(entityId);
                }
            });
        },
    };
};
