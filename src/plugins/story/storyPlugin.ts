// The story environment plugin — the island's scenario runner.
//
// Every world minute the plugin looks for an ENCOUNTER: two castaways close
// enough to interact (on the same tile or across the Chebyshev-1 ring —
// neighbours, not positions on a map). When one is found, ONE unused
// scenario is sampled from the deck (@godspace/core src/scenario) and
// played against a stage wired to the island's systems:
//
//   stage.profile → needs.satisfy  (hunger, thirst — clamped 0..100; energy
//                  DRAINS only — R4 drops the positive deltas at this stage
//                  boundary: a story is an instant encounter, never a
//                  rest/sleep task, so nothing may restore; the recovery
//                  service is the only sanctioned energy route)
//   stage.bond    → relationship.adjust (signed, reason logged)
//
// The play returns its narrative lines, and the plugin injects them into
// the log as ONE story block (kind 'story'): the message is the lines
// joined into a paragraph, and the structured `detail` carries the
// scenario id, title, cast and the separate lines for the view's story
// feed. The log reads as a story teller — meetings and what happened
// between the entities — never as position plumbing.
//
// ONE-SHOT POOL: the deck starts with the standard island scenarios
// (scenario/scenarios.ts). Each plays at most once per world — after the
// well runs dry the encounters fall silent (sampling returns nothing).
//
// Encounter pacing: at most ONE story per world minute, and each castaway
// observes a per-actor cooldown between encounters. Pair choice and
// sampling are deterministic (roster order + the plugin's seeded stream).

import { arrayEach } from '@presource/core';
import {
    createScenarioDeck,
    planeDistance,
    type PluginContext,
    type ScenarioDeck,
    type ScenarioDefinition,
    type ScenarioStage,
    type WorldPlugin,
} from '@godspace/core';
import { STANDARD_SCENARIOS } from '../../scenario/scenarios';
import type { World } from '../../engine/world';
import type { Actor } from '../../engine/types';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { RelationshipPlugin } from '../relationship/relationshipPlugin';

export type StoryPluginOptions = {
    needs: NeedsPlugin;
    relationship: RelationshipPlugin;
    /** Chebyshev radius (tiles) two castaways may meet across. Default 1. */
    encounterRadius?: number;
    /** World minutes a castaway must wait between encounters. Default 45. */
    encounterCooldownMinutes?: number;
    /**
     * A custom deck replaces the standard island scenarios (the god-view
     * and tests can play bespoke wells). When omitted the plugin defines
     * the standard ten.
     */
    deck?: ScenarioDeck;
};

export type StoryPlugin = WorldPlugin<World> & {
    /** The deck this plugin plays from (defined at setup). */
    deck(): ScenarioDeck;
};

export const storyPlugin = (options: StoryPluginOptions): StoryPlugin => {
    const { needs, relationship } = options;
    // Chebyshev 1 — the meeting ring: same tile OR adjacent tiles (the
    // plane metric, plugins/behavior uses the same distance shape)
    const radius = options.encounterRadius ?? 1;
    // Forty-five world minutes between stories per castaway — the island
    // breathes between beats
    const cooldown = options.encounterCooldownMinutes ?? 45;

    // The world arrives with setup — the tick reads cast, clock and events
    let context: PluginContext<World> | null = null;

    // The deck is defined at setup, keyed off the world's seed (the sample
    // shuffle is deterministic per world). A custom deck rides as-is.
    let deck: ScenarioDeck | null = null;

    // Last encounter per castaway id, stamped in elapsed world minutes —
    // the per-actor breathing room between stories
    const lastEncounter = new Map<string, number>();

    /**
     * The first eligible encounter pair in roster order — two castaways
     * within the meeting ring whose cooldowns have both elapsed. Returns
     * the pair sorted by roster order (the protagonist is the earlier id),
     * or undefined when the cast are all too far apart or too tired of
     * company. A pure read — the play applies the effects exactly once.
     */
    const firstEncounter = (active: World, now: number): Array<Actor> | undefined => {
        const cast = Array.from(active.actors.values());
        let found: Array<Actor> | undefined = undefined;
        // Roster order scan — the first pair in insertion order wins, so
        // the choice never depends on Map iteration quirks
        arrayEach(cast, ({ value: first, index: firstIndex }) => {
            if (found) {
                return;
            }
            if (now - (lastEncounter.get(first.id) ?? -Infinity) < cooldown) {
                return;
            }
            arrayEach(cast.slice(firstIndex + 1), ({ value: second }) => {
                if (found) {
                    return;
                }
                if (now - (lastEncounter.get(second.id) ?? -Infinity) < cooldown) {
                    return;
                }
                // The meeting ring: within the Chebyshev radius on the
                // ground plane (same tile scores 0 — the closest meeting)
                if (planeDistance(first.position, second.position) <= radius) {
                    found = [first, second];
                }
            });
        });
        return found;
    };

    return {
        id: 'story',
        label: 'Storyteller',

        setup: (pluginContext: PluginContext<World>) => {
            context = pluginContext;
            // The deck: injected, or the standard ten keyed off the seed
            if (options.deck) {
                deck = options.deck;
            } else {
                const built = createScenarioDeck({ seed: pluginContext.world.seed });
                arrayEach(STANDARD_SCENARIOS, ({ value: scenario }) => {
                    built.define(scenario);
                });
                deck = built;
            }
        },

        deck: () => {
            if (!deck) {
                throw new Error('story plugin read before setup');
            }
            return deck;
        },

        dispose: () => {
            lastEncounter.clear();
            context = null;
            deck = null;
        },

        tick: () => {
            const active = context?.world;
            if (!active || !deck) {
                return;
            }
            const now = active.ticker.elapsed();
            // One story per world minute, tops — the first eligible pair
            const pair = firstEncounter(active, now);
            if (!pair) {
                return;
            }
            // Sample ONE unused scenario — the well is finite by design
            const [scenario]: Array<ScenarioDefinition> = deck.sample(1);
            if (!scenario) {
                // The well is dry: the story is fully told
                return;
            }
            const cast = pair.map((actor) => ({ id: actor.id, name: actor.name }));
            // The stage — the scenario's only door into the island's systems
            const stage: ScenarioStage = {
                tick: active.ticker.ticks(),
                time: now,
                cast,
                profile: (index, deltas) => {
                    const member = cast[index];
                    if (!member) {
                        return;
                    }
                    // The island's profile is the needs triple: the knobs
                    // the needs plugin knows are routed, engine-foreign
                    // keys are ignored (satisfy clamps 0..100)
                    //
                    // R4 — THE STORY ENERGY GATE: positive energy deltas are
                    // DROPPED here (Math.min(0, …)); drains ride. A story is
                    // an instant encounter, not a rest/sleep task — the R4
                    // rule grants energy only while a rest/sleep task
                    // actually RUNS, and only through the needs plugin's
                    // recovery service (needs.recovery — resource-backed:
                    // every restored point charges hunger/thirst equally).
                    // The deck's warm scenes (shared-fire's +8, storm-
                    // shelter's +8, gull-omen's +2) keep their narrative —
                    // they just stop refilling the reservoir. Routing the
                    // gains through recovery instead was considered and
                    // rejected: a watched campfire is not worked rest, and
                    // the recovery charge would tax the body's hunger and
                    // thirst for an encounter it never slept through.
                    needs.satisfy(member.id, {
                        hunger: deltas.hunger,
                        thirst: deltas.thirst,
                        energy:
                            deltas.energy === undefined
                                ? undefined
                                : Math.min(0, deltas.energy),
                    });
                },
                bond: (a, b, delta, reason) => {
                    const left = cast[a];
                    const right = cast[b];
                    if (!left || !right) {
                        return;
                    }
                    // The bond route — relationship.adjust clamps ±100 and
                    // logs notable moves with the scenario's reason
                    relationship.adjust(left.id, right.id, delta, reason);
                },
            };
            const lines = deck.run(scenario.id, stage);
            if (!lines || lines.length === 0) {
                return;
            }
            // Inject the story into the log — ONE block per scenario: the
            // message the paragraph, the detail the structured story
            active.events.emit({
                kind: 'story',
                actorId: cast[0].id,
                message: lines.join(' '),
                detail: {
                    scenario: scenario.id,
                    title: scenario.title,
                    cast: cast.map((member) => member.name),
                    lines,
                },
            });
            // Both castaways observed the cooldown — the island breathes
            arrayEach(cast, ({ value: member }) => {
                lastEncounter.set(member.id, now);
            });
        },
    };
};
