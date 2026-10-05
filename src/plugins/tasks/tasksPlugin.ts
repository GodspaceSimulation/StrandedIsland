// The tasks environment plugin — a thin WorldPlugin wrapper around the task
// ledger (plugins/tasks/taskLedger.ts).
//
// The ledger is pure logic with no world access; this plugin gives it the
// engine heartbeat: every tick hook call covers exactly ONE world-minute
// (engine/world.ts sub-steps a step's minutes one at a time), and one tick
// call is one ledger.tick() — the world's time costs count down exactly one
// minute per world-minute at every view scale. Behaviour modules (the agent
// decision slices, e.g. plugins/behavior/behaviorPlugin.ts and
// plugins/sleep/sleepPlugin.ts) register through here into the ledger.
//
// dispose wipes the ledger entirely (queues + behaviours + listeners) — the
// environment is gone, exactly what a plugin swap means (see
// plugins/inventory/inventoryPlugin.ts dispose).

import { createTaskLedger, type ActiveTask, type TaskBehaviour, type TaskLedger } from './taskLedger';
import type { WorldPlugin } from '../../engine/plugin';

export type TasksPlugin = WorldPlugin & {
    /** The raw ledger (see taskLedger.ts) — behaviour registration, queues, tick. */
    ledger: TaskLedger;
    /** The actor's in-progress task (the queue head), or undefined. */
    taskOf(actorId: string): ActiveTask | undefined;
    /** Whether the actor has at least one queued task. */
    busy(actorId: string): boolean;
    /** Every queued task across all actors. */
    tasks(): ActiveTask[];
    /** Registers (or overwrites) a behaviour module — passthrough. */
    behaviour(module: TaskBehaviour): void;
    /** Removes a behaviour and cancels its queued tasks — passthrough. */
    dropBehaviour(id: string): boolean;
};

export const tasksPlugin = (): TasksPlugin => {
    const ledger = createTaskLedger();

    return {
        id: 'tasks',
        label: 'Task Ledger',

        ledger,

        // Passthroughs — the roster is the convenient entry point, the ledger
        // the raw one (tests and the god-view may read either)
        taskOf: (actorId) => ledger.taskOf(actorId),
        busy: (actorId) => ledger.busy(actorId),
        tasks: () => ledger.tasks(),
        behaviour: (module) => ledger.behaviour(module),
        dropBehaviour: (id) => ledger.dropBehaviour(id),

        dispose: () => {
            ledger.clear();
        },

        // One world-minute per tick hook call (engine/world.ts sub-stepping) —
        // the exact ledger heartbeat contract
        tick: () => {
            ledger.tick();
        },
    };
};
