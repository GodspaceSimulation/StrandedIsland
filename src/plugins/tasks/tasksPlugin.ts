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
import { createTileWorkLedger, type TileWorkLedger } from '@godspace/core';
import type { WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';

export type TasksPlugin = WorldPlugin<World> & {
    /** The raw ledger (see taskLedger.ts) — behaviour registration, queues, tick. */
    ledger: TaskLedger;
    /**
     * THE TILE WORK LEDGER (@godspace/core src/work) — the persistent
     * SHARED labor record per tile (felling a tree is many minutes several
     * skilled entities contribute to; the work survives every actor's
     * death, abort and walk-away). The scheduler counts WHO does WHAT next;
     * this counts what the WORLD remembers. Lumber's chop and construction's
     * fell both feed it, keyed `tileWorkKey(x, y, 'chop')`.
     */
    tileWork: TileWorkLedger;
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
    /**
     * Cancels every queued task of one actor — passthrough (the ledger's
     * cancel, see taskLedger.ts). The world calls this when the body behind
     * an id leaves it; the plugin also wires it automatically below.
     */
    cancel(actorId: string): ActiveTask[];
};

export const tasksPlugin = (): TasksPlugin => {
    const ledger = createTaskLedger();
    // The shared tile-work ledger (see the TasksPlugin type) — one job per
    // tile per kind, standing across actors; the lumber/construction plugins
    // feed it and the tile UI reads it
    const tileWork = createTileWorkLedger();
    // The despawn subscription (wired in setup) — the handle the dispose
    // hook tears down again
    let unsubscribe: (() => void) | null = null;

    return {
        id: 'tasks',
        label: 'Task Ledger',

        ledger,

        tileWork,

        // Passthroughs — the roster is the convenient entry point, the ledger
        // the raw one (tests and the god-view may read either)
        taskOf: (actorId) => ledger.taskOf(actorId),
        busy: (actorId) => ledger.busy(actorId),
        tasks: () => ledger.tasks(),
        behaviour: (module) => ledger.behaviour(module),
        dropBehaviour: (id) => ledger.dropBehaviour(id),
        cancel: (actorId) => ledger.cancel(actorId),

        setup: (context) => {
            // NO STALE TASKS — when the body behind a queue leaves the world
            // (a health-zero death, a bird glided past the world's edge, a
            // shark swept back out to sea — every removal lands in the log
            // as 'despawn' or 'death'), its queued tasks are cancelled at
            // once. Without this the dead body's queue would keep ticking
            // down as stale tasks, their completion effects resolving to
            // nothing (the behavior plugin's actorOf returns undefined for
            // a despawned body). Both kinds carry the actorId.
            unsubscribe = context.world.events.subscribe((event) => {
                if (
                    (event.kind === 'despawn' || event.kind === 'death') &&
                    event.actorId !== undefined
                ) {
                    ledger.cancel(event.actorId);
                }
            });
        },

        dispose: () => {
            // The subscription goes with the environment — a swapped-out
            // ledger must not keep cancelling into its replacement
            unsubscribe?.();
            unsubscribe = null;
            ledger.clear();
            // The standing tile work goes with the environment too — a
            // swapped-out world never inherits the old world's half-felled
            // trees
            tileWork.clear();
        },

        // One world-minute per tick hook call (engine/world.ts sub-stepping) —
        // the exact ledger heartbeat contract
        tick: () => {
            ledger.tick();
        },
    };
};
