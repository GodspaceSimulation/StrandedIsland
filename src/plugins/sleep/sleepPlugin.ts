// The sleep environment plugin — timed sleep as a ledger behaviour.
//
// Sleeping is now a TASK: the plugin registers one 'sleep' behaviour module
// into the task ledger (plugins/tasks/taskLedger.ts) at priority 30 — high
// enough to SHADOW the behavior plugin's priority-25 'rest' fallback rung
// (plugins/behavior/behaviorPlugin.ts), so a sleeping world rests properly.
// The behaviour add/remove → task list update rule in action: removing this
// plugin drops the module AND cancels its queued sleep tasks (the ledger's
// update-on-remove rule), and exhausted actors fall back to the old
// instant-rest ladder.
//
// The sleep task itself costs `durationMinutes` world minutes (default 45)
// and restores energy WHILE it runs: one restore per world-minute, applied
// in this plugin's tick — one tick hook call covers exactly ONE world-minute
// (engine/world.ts sub-stepping), so `restorePerMinute` applies directly.
// This is deliberately different from the instant-rest fallback (which
// restores once, on completion, through the behavior plugin's completion
// listener — a 'sleep' task never routes there).
//
// Sleep/wake transitions are logged: the first minute a sleeping task is
// seen emits "curls up and sleeps", the first minute the actor is no longer
// sleeping emits "wakes up".

import { arrayEach } from '@presource/core';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';

export type SleepPluginOptions = {
    needs: NeedsPlugin;
    tasks: TasksPlugin;
    /** Energy level that triggers sleep. Default 22 (the old rest trigger). */
    trigger?: number;
    /** Energy restored per world-minute of sleep. Default 1.2. */
    restorePerMinute?: number;
    /** Sleep task length in world minutes. Default 45. */
    durationMinutes?: number;
};

export type SleepPlugin = WorldPlugin & {};

export const sleepPlugin = (options: SleepPluginOptions): SleepPlugin => {
    const { needs, tasks } = options;
    const trigger = options.trigger ?? 22;
    const restorePerMinute = options.restorePerMinute ?? 1.2;
    const durationMinutes = options.durationMinutes ?? 45;

    // The world reference arrives with setup — the tick reads actors and
    // emits sleep/wake log lines through it
    let world: PluginContext['world'] | null = null;

    // Which actors were sleeping at the END of the previous minute — the
    // transition detector for the sleep/wake log lines (per-actor flag)
    const sleeping = new Set<string>();

    return {
        id: 'sleep',
        label: 'Sleep',

        setup: (context) => {
            world = context.world;

            // The behaviour module — priority 30 shadows the 'rest' fallback
            // (25). The gate reads the actor's live energy; the plan queues a
            // single timed sleep task
            tasks.behaviour({
                id: 'sleep',
                label: 'Sleep',
                priority: 30,
                appliesTo: (subject) => needs.of(subject.actor.id).energy <= trigger,
                plan: () => ({
                    kind: 'sleep',
                    label: 'sleeps',
                    minutes: durationMinutes,
                }),
            });
        },

        dispose: () => {
            // Drop the module and cancel its queued sleep tasks — tired
            // actors fall back to the 'rest' ladder immediately (the ledger
            // update-on-remove rule). Own state goes with the plugin.
            tasks.dropBehaviour('sleep');
            sleeping.clear();
            world = null;
        },

        tick: () => {
            const active = world;
            if (!active) {
                return;
            }
            // One world-minute of sleep per tick hook call — the restore rate
            // applies directly. Spawn-order snapshot; despawned actors skip.
            const actorIds = Array.from(active.actors.keys());
            arrayEach(actorIds, ({ value: actorId }) => {
                const actor = active.actors.get(actorId);
                if (!actor) {
                    return;
                }
                const task = tasks.taskOf(actorId);
                if (task?.kind === 'sleep') {
                    // Restoring while the sleep task is the queue head
                    needs.satisfy(actorId, { energy: restorePerMinute });
                    if (!sleeping.has(actorId)) {
                        // Sleep start transition — logged once per slumber
                        sleeping.add(actorId);
                        active.events.emit({
                            kind: 'sleep',
                            actorId,
                            message: `${actor.name} curls up and sleeps.`,
                        });
                    }
                    return;
                }
                // No sleep task this minute — the wake transition
                if (sleeping.has(actorId)) {
                    sleeping.delete(actorId);
                    active.events.emit({
                        kind: 'sleep',
                        actorId,
                        message: `${actor.name} wakes up.`,
                    });
                }
            });
        },
    };
};
