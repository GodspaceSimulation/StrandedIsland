// The survival environment plugin — fleeing wild animals, as a ledger
// behaviour.
//
// Survival is the HIGHEST ladder rung: this plugin registers one 'survival'
// behaviour module into the task ledger (plugins/tasks/taskLedger.ts) at
// priority 60 — above thirst (50), hunger (40), sleep (30) and everything
// else — so the per-tick prioritization always reads it first. The gate is
// a PURE threat scan over the world's coordinate space: a wild animal
// (any creature of a THREAT type — the predators plugin's boars, the sharks
// swimming past the shore) within `threatRange` tiles (Chebyshev, the grid
// step metric) of the actor is a meeting that can hurt. The plan queues
// ONE flee task: one fine step AWAY from the nearest threat (1 world
// minute — the Scale-0 distance rule), or blind flight (any valid step)
// when the animal already shares the actor's tile.
//
// The flee task is a 'move' task — its completion effect (the relocation,
// the tile-crossing energy charge) is the behavior plugin's move effect
// (plugins/behavior/behaviorPlugin.ts), which every move task flows
// through. The plugin therefore needs the behavior plugin mounted to
// actually flee (the scenario guards the mount, scenario/island.ts).
//
// While the threat stands, the ladder re-plans the flee every minute —
// the actor keeps running; the tick the threat moves off (or is outrun),
// survival declines and the interrupted find-food / find-water queue
// resumes. An interrupted task is abandoned mid-work (the ledger's
// pre-emption rule) — not every task completes.

import { arrayEach } from '@presource/core';
import { NEIGHBOR_OFFSETS, type WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { TaskSpec, TaskEntity } from '../tasks/taskLedger';
import { chebyshev, fineStep, greedyFineStep } from '../movement/fineMovement';

export type SurvivalPluginOptions = {
    tasks: TasksPlugin;
    /**
     * Threat range in tiles (Chebyshev) — a wild animal within it is a
     * meeting that can hurt. Default 1: the animal's tile or one beside it.
     */
    threatRange?: number;
    /** World minutes to move ONE SCALE-0 tile. Default 1 (the
     * distribution's distance rule, scenario/island.ts). */
    travelMinutesPerTile?: number;
};

/**
 * The creature types a castaway flees — the predators plugin's boars (the
 * land threats) and the sharks (the sea ones off the shore). Open set:
 * future beast plugins coin types into the coordinate space and extend
 * this list.
 */
const THREAT_TYPES: readonly string[] = ['boar', 'shark'];

export type SurvivalPlugin = WorldPlugin<World> & {};

export const survivalPlugin = (options: SurvivalPluginOptions): SurvivalPlugin => {
    const { tasks } = options;
    const threatRange = options.threatRange ?? 1;
    const travel = options.travelMinutesPerTile ?? 1;

    // The world + the plugin's own persistent random stream arrive with
    // setup (the engine registry caches one context per plugin id) — the
    // blind-flight pick draws from the stream
    let world: World | null = null;
    let random: (() => number) | null = null;

    /**
     * The nearest threat to the entity RIGHT NOW — a PURE read over the
     * coordinate space (the single position registry every creature lives
     * in). A creature of a THREAT type within `threatRange` tiles
     * (Chebyshev, plane footprints). Undefined when the coast is clear.
     */
    const threatNear = (entity: TaskEntity): { id: string; x: number; y: number } | undefined => {
        const active = world;
        if (!active) {
            return undefined;
        }
        let found: { id: string; x: number; y: number } | undefined;
        let best = Infinity;
        arrayEach(active.coordinates.all(), ({ value: entry }) => {
            if (entry.kind !== 'creature' || !THREAT_TYPES.includes(entry.type ?? '')) {
                return;
            }
            const distance = chebyshev(entity.position, entry.position);
            if (distance <= threatRange && distance < best) {
                found = { id: entry.id, x: entry.position.x, y: entry.position.y };
                best = distance;
            }
        });
        return found;
    };

    return {
        id: 'survival',
        label: 'Survival',

        setup: (context) => {
            const active = context.world;
            world = active;
            random = context.random;

            // The behaviour module — priority 60 outranks the whole survival
            // ladder; the ledger pre-empts a busy queue with it (the
            // per-tick prioritization). Fleeing stays a SENTIENT conduct:
            // the ladder plans creatures too (the behavior plugin's every-
            // living-thing sweep), but a wild boar is itself the threat —
            // beasts do not flee beasts.
            tasks.behaviour({
                id: 'survival',
                label: 'Survival',
                priority: 60,
                appliesTo: (subject) =>
                    subject.actor.kind !== 'creature' && threatNear(subject.actor) !== undefined,
                plan: (subject) => {
                    const actor = subject.actor;
                    const threat = threatNear(actor);
                    if (!threat) {
                        return undefined;
                    }
                    // Away from the threat: the tile one step beyond the
                    // actor, on the far side — the greedy walker turns that
                    // into the best fine step away
                    const dx = Math.sign(actor.position.x - threat.x);
                    const dy = Math.sign(actor.position.y - threat.y);
                    if (dx !== 0 || dy !== 0) {
                        const step = greedyFineStep(
                            active,
                            actor,
                            actor.position.x + dx,
                            actor.position.y + dy,
                        );
                        if (step) {
                            return fleeSpec(step[0], step[1], travel);
                        }
                    }
                    // The animal shares the actor's tile (or every away
                    // step is blocked) — blind flight: any valid fine step,
                    // drawn from the plugin's own stream
                    const open: Array<[number, number]> = [];
                    arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                        if (fineStep(active, actor, offset.dx, offset.dy)) {
                            open.push([offset.dx, offset.dy]);
                        }
                    });
                    if (open.length === 0 || !random) {
                        // Cornered — the threat bites next minute
                        return undefined;
                    }
                    const [dx2, dy2] = open[Math.floor(random() * open.length)];
                    return fleeSpec(dx2, dy2, travel);
                },
            });
        },

        dispose: () => {
            // Drop the module and cancel its queued flee tasks (the
            // ledger's update-on-remove rule) — fleeing actors re-join the
            // wider behaviour ladder immediately
            tasks.dropBehaviour('survival');
            world = null;
            random = null;
        },
    };
};

/** One flee step — a 'move' task tagged `flee` (the behavior plugin's move
 * effect applies every move task identically; the tag reads in payloads). */
const fleeSpec = (dx: number, dy: number, travel: number): TaskSpec => ({
    kind: 'move',
    label: 'flees',
    minutes: travel,
    payload: { dx, dy, flee: true },
});
