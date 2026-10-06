// The task ledger — the per-entity list of tasks an actor is going to do,
// where every task costs WORLD MINUTES and pluggable "behaviour modules"
// decide what gets queued.
//
// THE SHARED SCHEDULER — this module is now a THIN ISLAND ADAPTER over the
// generic task scheduler extracted into @godspace/core (src/task): the
// island's exact queue/priority/pre-emption/completion/cancel semantics
// (planning priority DESC walk, strictly-higher pre-emption, one-minute
// serial heartbeats, completion listeners after all decrementing, drop-
// behaviour and despawn cancellation) were lifted INTO the shared core
// (packages/godspace/core/src/task/index.ts) and this file re-exports them
// under the island's public interface. NO duplicate scheduler lives here —
// createTaskLedger() delegates every operation to one core
// createTaskScheduler() instance and translates at the boundary:
//   TaskSpec      — re-exported from the core unchanged (identical shape)
//   ActiveTask    — the core's record renames subjectId → actorId (the
//                   island's public field name since the first ledger)
//   TaskSubject   — the island's actor-carrying subject widened with the
//                   core's structural minimum: the plan() call hands the
//                   core `{ ...entity, actor: entity }`, so behaviour
//                   modules read `subject.actor` exactly as before AND the
//                   core's stock behaviour factories
//                   (needTaskBehaviour/gatherTaskBehaviour/craftTaskBehaviour/
//                   buildTaskBehaviour — plugins/construction composes the
//                   craft/build ones) type against the same subject.
// The island's concrete TaskEntity stays local to the distribution; the
// core scheduler plans through the structural minimum ({ id } + open
// fields) only.
//
// The heartbeat contract: the world runs one world-minute per plugin tick
// hook call (the engine core's step() sub-stepping), so one scheduler tick()
// decrements task progress by exactly one minute — and ONLY each queue's
// head advances (time is serial; queued followers wait their turn).
//
// PRIORITIZATION PER TICK — an actor can hold many tasks and not all of
// them complete. plan() runs for BUSY actors too: a behaviour whose
// priority is STRICTLY HIGHER than the head task's behaviour priority
// pre-empts — the in-progress task is abandoned mid-work (its remaining
// minutes and effect are lost) and the urgent task takes the head, the
// old queue's survivors following behind. So an actor travelling to water
// (thirst) drops everything the tick a wild animal closes in (the
// survival plugin's higher-priority flee), and picks the find-food /
// find-water queue back up once the threat is gone. Equal priorities
// never churn a running queue.
//
// Behaviour modules are pluggable slices of conduct ('sleep', 'thirst', …).
// The add/remove update rule: registering one changes future planning only;
// dropping one cancels every task queued under it immediately — actors whose
// task list came from that behaviour lose those tasks and become idle again
// (the next plan() round re-plans them). How long a task takes is governed
// entirely by the behaviour module that queues it — the island engine pins
// one Scale-0 tile = 1 world minute (TRAVEL_MINUTES_PER_TILE); the scheduler
// only counts the minutes down. No randomness, no world access — pure logic.

import {
    createTaskScheduler,
    type ActiveTask as CoreActiveTask,
    type TaskBehaviour as CoreTaskBehaviour,
    type TaskSpec as CoreTaskSpec,
} from '@godspace/core';
import type { Position3D } from '@godspace/core';

// The spec type is the CORE's — the shared scheduler validates and stores
// exactly this shape (the island's original TaskSpec was structurally
// identical, so the re-export preserves the public interface 1:1).
export type TaskSpec = CoreTaskSpec;

/** One queued task: the spec plus identity and the live countdown. */
export type ActiveTask = TaskSpec & {
    /** Scheduler-unique task id, "t-1", "t-2", … monotonic (resets on clear). */
    id: string;
    /** The actor the task belongs to (the core's subjectId, island-named). */
    actorId: string;
    /** The behaviour module that queued the task (its registry id). */
    behaviour: string;
    /** Total world minutes (a copy of the spec's minutes). */
    total: number;
    /** Minutes remaining; decremented once per scheduler tick. */
    remaining: number;
};

/**
 * The minimal entity shape the scheduler plans through. EVERY living thing
 * can hold tasks (all entities plan through the behaviours plugin script): a
 * castaway satisfies this with its full Actor record, and a coordinate-space
 * creature (a seabird, a wild boar — plugins/birds, plugins/predators) is
 * planned through the same id/name/position identity. The `kind`/`type`
 * facets ride along so behaviour modules can gate per species (the survival
 * flee and the lumber chop stay sentient-only; the hunger/rest rungs apply
 * to every living thing).
 */
export type TaskEntity = {
    id: string;
    name: string;
    position: Position3D;
    kind?: string;
    type?: string;
    marker?: string;
};

/**
 * The subject a behaviour module's gate/plan reads. Behaviour modules close
 * over whatever plugin APIs they need (needs, inventory, …); the scheduler
 * only hands them the entity — carried under `actor`, beside the core's
 * structural `id` (the plan() call builds `{ ...entity, actor: entity }`).
 * The `id` key is what makes this subject type satisfy @godspace/core's
 * TaskSubject structurally, so the core's stock behaviour factories
 * (craftTaskBehaviour, buildTaskBehaviour, …) compose directly with island
 * behaviour modules.
 */
export type TaskSubject = {
    id: string;
    actor: TaskEntity;
    [key: string]: unknown;
};

/** A pluggable behaviour module — one named slice of conduct that queues tasks. */
export type TaskBehaviour = {
    /** Registry id ('sleep', 'thirst', …). Re-registering overwrites in place. */
    id: string;
    /** Display label for rosters. */
    label?: string;
    /**
     * Planning priority — higher modules are consulted first. Default 0.
     * The priority also governs pre-emption: while an actor is busy, only
     * a module with a STRICTLY higher priority may interrupt its queue.
     */
    priority?: number;
    /** Circumstance gate — does this behaviour want to act for this actor now? */
    appliesTo?: (subject: TaskSubject) => boolean;
    /**
     * The task(s) to queue when the actor is idle and the gate passes.
     * Returning nothing (void) means "declined this moment" — planning
     * continues with the next behaviour.
     */
    plan?: (subject: TaskSubject) => TaskSpec | TaskSpec[] | void;
};

export type TaskLedger = {
    /** Registers (or overwrites) a behaviour module. */
    behaviour(module: TaskBehaviour): void;
    /**
     * Removes a behaviour module AND cancels every task queued under it —
     * the update-on-remove rule: actors whose task list came from that
     * behaviour lose those tasks and become idle again.
     */
    dropBehaviour(id: string): boolean;
    /**
     * Cancels EVERY queued task of one actor — the queue entry leaves the
     * map entirely (the actor goes idle). The cleanup the world calls when
     * the body behind an id LEAVES it: a dead castaway, a bird glided past
     * the world's edge, a shark swept back out to sea. Without it the dead
     * body's queue would keep ticking down as stale tasks (the head task's
     * completion effect resolving to nothing — actorOf undefined). Returns
     * the cancelled tasks in queue order (empty when the actor held none).
     */
    cancel(actorId: string): ActiveTask[];
    /**
     * All registered behaviour modules, planning order: priority DESC, then
     * first-registration order as the tiebreak (deterministic).
     */
    behaviours(): TaskBehaviour[];
    /**
     * Appends one or more task specs to an actor's FIFO queue under the
     * given behaviour id. Returns the created ActiveTask records (queue
     * order). Empty specs array queues nothing. Malformed specs throw —
     * the shared scheduler validates at the queue boundary (a blank kind,
     * a non-positive-integer minutes, …) so a broken spec is a caller bug,
     * never a silently ticking task.
     */
    queue(actorId: string, behaviourId: string, specs: TaskSpec | TaskSpec[]): ActiveTask[];
    /** The actor's in-progress task (the queue head), or undefined. */
    taskOf(actorId: string): ActiveTask | undefined;
    /** The actor's full FIFO queue, head first. */
    queueOf(actorId: string): ActiveTask[];
    /** Every queued task across all actors, actor-insertion order then queue order. */
    tasks(): ActiveTask[];
    /** Whether the actor has at least one queued task. */
    busy(actorId: string): boolean;
    /**
     * Consults the registered behaviour modules for an entity. IDLE
     * entities: the first module (planning order) whose gate passes and
     * whose plan yields specs gets them queued. BUSY entities: only a
     * module whose priority is STRICTLY HIGHER than the head task's
     * behaviour priority may pre-empt — the in-progress task is abandoned
     * mid-work (not every task completes) and the new specs take the head,
     * the old queue's survivors following behind. Equal or lower priorities
     * never churn a running queue. Accepts ANY living entity — a castaway
     * (the registry Actor) or a coordinate-space creature (a seabird, a
     * wild boar) planned through the same behaviour ladder. Returns the
     * newly queued head task, or undefined when nothing was queued.
     */
    plan(entity: TaskEntity): ActiveTask | undefined;
    /**
     * One world-minute heartbeat: ONLY the head task of each non-empty queue
     * progresses (time is serial). Its remaining decrements by 1; a task
     * reaching 0 pops off the queue and fires the completion listeners.
     * Returns the completed tasks, in completion order.
     */
    tick(): ActiveTask[];
    /** Subscribes to task completion; returns the unsubscribe function. */
    onComplete(listener: (task: ActiveTask) => void): () => void;
    /** Wipes queues, behaviours, listeners and the id counter (plugin dispose). */
    clear(): void;
};

/**
 * The core record → the island record: the shared scheduler keys tasks by
 * `subjectId`; the island's public field has been `actorId` since the first
 * ledger. Built explicitly (never spread) so the island shape carries no
 * `subjectId` field — the exact task shape the rosters and tests pin. The
 * payload is copied once more so a caller mutating the handed-out record
 * can never reach the queue.
 */
const toIslandTask = (task: CoreActiveTask): ActiveTask => ({
    id: task.id,
    actorId: task.subjectId,
    behaviour: task.behaviour,
    kind: task.kind,
    label: task.label,
    minutes: task.minutes,
    // Payload only when the spec carried one — keeps the exact task shape
    ...(task.payload !== undefined ? { payload: { ...task.payload } } : {}),
    total: task.total,
    remaining: task.remaining,
});

/**
 * Creates the island task ledger — a thin adapter over the SHARED core
 * scheduler (packages/godspace/core/src/task createTaskScheduler). Every
 * operation delegates; the boundary translations are the subject wrap
 * (`{ ...entity, actor: entity }`) and the ActiveTask rename
 * (subjectId → actorId). The island keeps its public interface; the core
 * owns the one scheduler implementation.
 */
export const createTaskLedger = (): TaskLedger => {
    // The one shared scheduler — the island never re-implements the queue,
    // the planning walk, the pre-emption lift or the heartbeat
    const scheduler = createTaskScheduler();

    // The ORIGINAL island modules by id — behaviours() hands these back (the
    // caller registered them; the core holds wrapped copies it plans through)
    const originals = new Map<string, TaskBehaviour>();

    /**
     * Wraps an island module for the core registry: the core hands every
     * gate/plan the subject the adapter's plan() built — the entity record
     * spread WITH its `actor` key — so the wrapper re-presents it as the
     * island's actor-carrying TaskSubject unchanged. The cast is sound by
     * construction: the adapter is the only caller of the core's plan()
     * and always builds subjects carrying `actor`.
     */
    const wrapModule = (module: TaskBehaviour): CoreTaskBehaviour => ({
        id: module.id,
        label: module.label,
        priority: module.priority,
        appliesTo: module.appliesTo
            ? (subject) => module.appliesTo?.(subject as TaskSubject) ?? false
            : undefined,
        plan: module.plan
            ? (subject) => module.plan?.(subject as TaskSubject)
            : undefined,
    });

    return {
        behaviour: (module) => {
            originals.set(module.id, module);
            // Map#set overwrites in place inside the core too — the original
            // insertion position (the planning tiebreak) never moves
            scheduler.behaviour(wrapModule(module));
        },

        dropBehaviour: (id) => {
            // The core's drop cancels every queued task under the id (the
            // update-on-remove rule) — the original registry mirrors it
            originals.delete(id);
            return scheduler.dropBehaviour(id);
        },

        cancel: (actorId) => scheduler.cancel(actorId).map((task) => toIslandTask(task)),

        behaviours: () =>
            // The core's planning order (priority DESC, registration order as
            // the tiebreak) resolved back to the ORIGINAL modules
            scheduler
                .behaviours()
                .map((wrapped) => originals.get(wrapped.id))
                .filter((module) => module !== undefined) as TaskBehaviour[],

        queue: (actorId, behaviourId, specs) =>
            scheduler.queue(actorId, behaviourId, specs).map((task) => toIslandTask(task)),

        taskOf: (actorId) => {
            const task = scheduler.taskOf(actorId);
            return task ? toIslandTask(task) : undefined;
        },

        queueOf: (actorId) => scheduler.queueOf(actorId).map((task) => toIslandTask(task)),

        tasks: () => scheduler.tasks().map((task) => toIslandTask(task)),

        busy: (actorId) => scheduler.busy(actorId),

        plan: (entity) => {
            // The subject handed to the core AND to every behaviour module:
            // the full entity record spread at the top level (the core's
            // structural `id` included) with the entity under `actor` (the
            // island's subject shape). Identity: `subject.actor` IS the
            // caller's record — gates read the live body.
            const subject = { ...entity, actor: entity };
            const queued = scheduler.plan(subject);
            return queued ? toIslandTask(queued) : undefined;
        },

        tick: () => scheduler.tick().map((task) => toIslandTask(task)),

        onComplete: (listener) =>
            // The listener receives the ISLAND task shape — the same record
            // layout tick()/taskOf() hand out
            scheduler.onComplete((task) => listener(toIslandTask(task))),

        clear: () => {
            originals.clear();
            scheduler.clear();
        },
    };
};
