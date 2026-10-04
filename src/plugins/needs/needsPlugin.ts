// The needs environment plugin — hunger, thirst and energy.
//
// Every tick each actor's needs drift by rates scaled to the tick size, so
// survival pressure stays consistent whether a tick is a minute or an hour
// (per-minute rates × minutes-per-tick = per-tick decay). Threshold
// crossings are logged to the world event bus, the actor's `condition` is
// derived here, and actors that stay at 100 hunger/thirst for too long die
// (condition 'gone' → despawned from the world).

import { arrayEach } from '@presource/core';
import type { ActorCondition } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';

export type NeedsPluginOptions = {
    /** Hunger points per world minute. Default 0.1 (→ +1 per 10-min tick). */
    hungerPerMinute?: number;
    /** Thirst points per world minute. Default 0.15. */
    thirstPerMinute?: number;
    /** Energy drain per world minute. Default 0.06. */
    energyPerMinute?: number;
    /** Ticks an actor survives at 100 hunger/thirst before dying. Default 3. */
    doomTicks?: number;
};

/** The three survival needs, all in 0..100. */
export type NeedsState = {
    hunger: number;
    thirst: number;
    energy: number;
};

export type NeedsPlugin = WorldPlugin & {
    /** An actor's needs — auto-created at starting values on first touch. */
    of(actorId: string): NeedsState;
    /**
     * Applies deltas (e.g. `{ hunger: -14 }` after eating, `{ energy: 12 }`
     * after resting). All three values clamp to 0..100.
     */
    satisfy(actorId: string, deltas: Partial<NeedsState>): void;
    /** Charges the extra energy cost of moving one cell. */
    moved(actorId: string): void;
};

/** Starting values — a fresh arrival is a little hungry and thirsty. */
const STARTING_STATE: NeedsState = { hunger: 20, thirst: 20, energy: 100 };

/** Thresholds that fire one-shot events when crossed upwards. */
const THRESHOLDS: Array<{ key: keyof NeedsState; at: number; message: (name: string) => string }> = [
    { key: 'hunger', at: 70, message: (name) => `${name} feels hunger pangs.` },
    { key: 'hunger', at: 90, message: (name) => `${name} is starving.` },
    { key: 'thirst', at: 70, message: (name) => `${name} is parched.` },
    { key: 'thirst', at: 90, message: (name) => `${name} is dying of thirst.` },
    { key: 'energy', at: 10, message: (name) => `${name} is collapsing from exhaustion.` },
];

/** Energy crossing works downwards; hunger/thirst upwards. */
const DOWNWARD_KEYS: Array<keyof NeedsState> = ['energy'];

/** Condition ladder from the worst need. */
const conditionOf = (state: NeedsState): Exclude<ActorCondition, 'gone'> => {
    if (state.hunger >= 90 || state.thirst >= 90 || state.energy <= 10) {
        return 'critical';
    }
    if (state.hunger >= 70 || state.thirst >= 70 || state.energy <= 25) {
        return 'weak';
    }
    return 'well';
};

const clamp01 = (value: number): number => Math.max(0, Math.min(100, value));

export const needsPlugin = (options: NeedsPluginOptions = {}): NeedsPlugin => {
    const hungerPerMinute = options.hungerPerMinute ?? 0.1;
    const thirstPerMinute = options.thirstPerMinute ?? 0.15;
    const energyPerMinute = options.energyPerMinute ?? 0.06;
    const doomTicks = options.doomTicks ?? 3;

    const states = new Map<string, NeedsState & { doom: number }>();

    const stateOf = (actorId: string) => {
        const existing = states.get(actorId);
        if (existing) {
            return existing;
        }
        const fresh = { ...STARTING_STATE, doom: 0 };
        states.set(actorId, fresh);
        return fresh;
    };

    return {
        id: 'needs',
        label: 'Survival Needs',

        of: (actorId) => {
            const state = stateOf(actorId);
            // Expose the plain needs triple without the internal doom counter
            return { hunger: state.hunger, thirst: state.thirst, energy: state.energy };
        },

        satisfy: (actorId, deltas) => {
            const state = stateOf(actorId);
            if (deltas.hunger !== undefined) {
                state.hunger = clamp01(state.hunger + deltas.hunger);
            }
            if (deltas.thirst !== undefined) {
                state.thirst = clamp01(state.thirst + deltas.thirst);
            }
            if (deltas.energy !== undefined) {
                state.energy = clamp01(state.energy + deltas.energy);
            }
        },

        moved: (actorId) => {
            const state = stateOf(actorId);
            state.energy = clamp01(state.energy - 1);
        },

        dispose: () => {
            states.clear();
        },

        tick: (context: PluginContext) => {
            const { world } = context;
            // Per-tick decay = per-minute rate × minutes per tick
            const minutes = world.ticker.tickSize();
            const dHunger = hungerPerMinute * minutes;
            const dThirst = thirstPerMinute * minutes;
            const dEnergy = energyPerMinute * minutes;

            // Snapshot the actor ids — despawning during the sweep must not
            // shift the iteration
            const actorIds = Array.from(world.actors.keys());
            arrayEach(actorIds, ({ value: actorId }) => {
                const actor = world.actors.get(actorId);
                if (!actor) {
                    // Despawned mid-sweep by an earlier doom
                    return;
                }
                const state = stateOf(actorId);

                // Track crossings: hunger/thirst rise, energy falls
                const before: NeedsState = {
                    hunger: state.hunger,
                    thirst: state.thirst,
                    energy: state.energy,
                };

                state.hunger = clamp01(state.hunger + dHunger);
                state.thirst = clamp01(state.thirst + dThirst);
                state.energy = clamp01(state.energy - dEnergy);

                arrayEach(THRESHOLDS, ({ value: threshold }) => {
                    const crossed = DOWNWARD_KEYS.includes(threshold.key)
                        ? before[threshold.key] > threshold.at && state[threshold.key] <= threshold.at
                        : before[threshold.key] < threshold.at && state[threshold.key] >= threshold.at;
                    if (crossed) {
                        world.events.emit({
                            kind: 'needs',
                            actorId,
                            message: threshold.message(actor.name),
                        });
                    }
                });

                // Doom: consecutive ticks fully starved or dehydrated
                if (state.hunger >= 100 || state.thirst >= 100) {
                    state.doom = state.doom + 1;
                    if (state.doom >= doomTicks) {
                        world.despawn(actorId);
                        world.events.emit({
                            kind: 'death',
                            actorId,
                            message: `${actor.name} has died.`,
                        });
                        states.delete(actorId);
                        return;
                    }
                } else {
                    state.doom = 0;
                }

                // Derive the visible condition
                actor.condition = conditionOf(state);
            });
        },
    };
};
