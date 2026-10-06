// The task ledger — the per-entity list of tasks an actor is going to do,
// where every task costs WORLD MINUTES and pluggable "behaviour modules"
// decide what gets queued.
//
// The behaviour plugins queue time-costing tasks (moving one Scale-0 tile
// = 1 world minute — TRAVEL_MINUTES_PER_TILE —, sleeping = tens, …) and
// the actor stays busy while the head task counts down. The heartbeat
// contract: the world runs one world-minute per plugin tick hook call
// (the engine core's step() sub-stepping), so one ledger tick() call
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
// one Scale-0 tile = 1 world minute (TRAVEL_MINUTES_PER_TILE); the ledger
// only counts the minutes down. No randomness, no world access — pure logic.

import { arrayEach } from '@presource/core';
import type { Position3D } from '@godspace/core';
import type { Actor } from '../../engine/types';

/** What a behaviour wants queued: one unit of work with a time cost. */
export type TaskSpec = {
    /** Task kind — 'move' | 'wander' | 'eat' | 'drink' | 'gather' | 'social' | 'sleep' | … open set. */
    kind: string;
    /** Human readable label for log lines and rosters ("travels east", "sleeps"). */
    label: string;
    /** World minutes the task occupies the actor. */
    minutes: number;
    /** Open payload the kind needs (move deltas, target item id, …). */
    payload?: Record<string, unknown>;
};

/** One queued task: the spec plus identity and the live countdown. */
export type ActiveTask = TaskSpec & {
    /** Ledger-unique task id, "t-1", "t-2", … monotonic. */
    id: string;
    /** The actor the task belongs to. */
    actorId: string;
    /** The behaviour module that queued the task (its registry id). */
    behaviour: string;
    /** Total world minutes (a copy of the spec's minutes). */
    total: number;
    /** Minutes remaining; decremented once per ledger tick. */
    remaining: number;
};

/**
 * The minimal entity shape the ledger plans through. EVERY living thing can
 * hold tasks (all entities plan through the behaviours plugin script): a
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
 * over whatever plugin APIs they need (needs, inventory, …); the ledger only
 * hands them the entity.
 */
export type TaskSubject = {
    actor: TaskEntity;
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
     * All registered behaviour modules, planning order: priority DESC, then
     * first-registration order as the tiebreak (deterministic).
     */
    behaviours(): TaskBehaviour[];
    /**
     * Appends one or more task specs to an actor's FIFO queue under the
     * given behaviour id. Returns the created ActiveTask records (queue
     * order). Empty specs array queues nothing.
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

export const createTaskLedger = (): TaskLedger => {
    // Behaviour registry keyed by id — Map insertion order is the
    // first-registration tiebreak for planning (a re-set keeps its position)
    const behaviours = new Map<string, TaskBehaviour>();
    // FIFO task queues keyed by actor id, insertion-ordered by first queue
    const queues = new Map<string, ActiveTask[]>();
    // Completion listeners in subscription order (see engine/events.ts style)
    const listeners = new Set<(task: ActiveTask) => void>();
    // Monotonic task id counter — "t-1", "t-2", …
    let taskCounter = 0;

    // ── helpers ──────────────────────────────────────────────────────────────

    /**
     * The planning-order snapshot: priority DESC with Map insertion order as
     * the tiebreak. Sorts a fresh array — the registry's own order is never
     * mutated. Array#sort is stable, so equal priorities keep registration
     * order (deterministic).
     */
    const planningOrder = (): TaskBehaviour[] =>
        Array.from(behaviours.values()).sort(
            (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
        );

    /** Normalizes a plan's specs result: single spec object → one-element array. */
    const specList = (specs: TaskSpec | TaskSpec[]): TaskSpec[] =>
        Array.isArray(specs) ? specs : [specs];

    /**
     * The internal queue writer: builds ActiveTask records from specs and
     * appends them to the actor's queue (the queue entry is created with the
     * first task). The spec's payload is stored as a shallow copy so later
     * caller mutations cannot alter a queued task.
     */
    const enqueue = (actorId: string, behaviourId: string, specs: TaskSpec[]): ActiveTask[] => {
        const created: ActiveTask[] = [];
        // Block body — task creation must never short-circuit the walk
        arrayEach(specs, ({ value: spec }) => {
            taskCounter = taskCounter + 1;
            const task: ActiveTask = {
                id: `t-${taskCounter}`,
                actorId,
                behaviour: behaviourId,
                kind: spec.kind,
                label: spec.label,
                minutes: spec.minutes,
                // Payload only when the spec carries one — keeps the exact
                // task shape (same rule as EventBus actorId, engine/events.ts)
                ...(spec.payload !== undefined ? { payload: { ...spec.payload } } : {}),
                total: spec.minutes,
                remaining: spec.minutes,
            };
            created.push(task);
        });
        if (created.length > 0) {
            const existing = queues.get(actorId);
            // `target` is the live queue array; `created` stays detached so
            // the queue() caller cannot mutate the queue through its return
            const target = existing ?? [];
            if (!existing) {
                queues.set(actorId, target);
            }
            arrayEach(created, ({ value: task }) => {
                target.push(task);
            });
        }
        return created;
    };

    return {
        behaviour: (module) => {
            // Map#set overwrites in place — the original insertion position
            // is kept, so registration order (the planning tiebreak) never moves
            behaviours.set(module.id, module);
        },

        dropBehaviour: (id) => {
            const removed = behaviours.delete(id);
            if (removed) {
                // Update-on-remove: cancel every queued task that came from
                // this behaviour — actors whose whole list came from it go
                // idle again, and a queue drained to empty leaves the map
                // (keeps tasks()/actor-insertion order clean). Snapshot the
                // keys: the map is mutated inside the walk.
                arrayEach(Array.from(queues.keys()), ({ value: actorId }) => {
                    const queue = queues.get(actorId);
                    if (!queue) {
                        return;
                    }
                    const survivors = queue.filter((task) => task.behaviour !== id);
                    if (survivors.length === 0) {
                        queues.delete(actorId);
                    } else {
                        queues.set(actorId, survivors);
                    }
                });
            }
            return removed;
        },

        behaviours: () => planningOrder(),

        queue: (actorId, behaviourId, specs) => enqueue(actorId, behaviourId, specList(specs)),

        taskOf: (actorId) => queues.get(actorId)?.[0],

        queueOf: (actorId) => {
            const queue = queues.get(actorId);
            return queue ? queue.slice() : [];
        },

        tasks: () => {
            const all: ActiveTask[] = [];
            // Actor-insertion order (the queue map's), then queue order inside
            arrayEach(Array.from(queues.values()), ({ value: queue }) => {
                arrayEach(queue, ({ value: task }) => {
                    all.push(task);
                });
            });
            return all;
        },

        busy: (actorId) => (queues.get(actorId)?.length ?? 0) > 0,

        plan: (entity) => {
            const queue = queues.get(entity.id);
            const head = queue?.[0];
            // The bar a pre-empting module must clear: the head task's own
            // behaviour priority. An idle entity (no head) accepts anything —
            // the walk below consults every module in planning order.
            const floor = head ? behaviours.get(head.behaviour)?.priority ?? 0 : -Infinity;
            const subject: TaskSubject = { actor: entity };
            let queued: ActiveTask[] | undefined;
            // Block-bodied walk in planning order: gates and plans vary per
            // module, so nothing may short-circuit the consultation
            arrayEach(planningOrder(), ({ value: module }) => {
                if (!queued) {
                    // A busy entity only yields to a STRICTLY higher-priority
                    // module — equal priorities never churn the queue (the
                    // in-progress task keeps its turn; time is serial)
                    if (head && (module.priority ?? 0) <= floor) {
                        return;
                    }
                    // No gate = the behaviour always applies
                    const applies = module.appliesTo ? module.appliesTo(subject) : true;
                    if (applies) {
                        const specs = module.plan?.(subject);
                        // void (undefined) = declined this moment — planning
                        // continues with the next behaviour; an empty specs
                        // array queues nothing and counts as declined too
                        if (specs !== undefined) {
                            const created = enqueue(entity.id, module.id, specList(specs));
                            if (created.length > 0) {
                                queued = created;
                            }
                        }
                    }
                }
            });
            if (!queued) {
                return undefined;
            }
            if (head) {
                // Pre-emption: the in-progress task is abandoned mid-work —
                // its remaining minutes and its eventual effect are lost
                // (not every task completes). The freshly queued specs were
                // APPENDED by enqueue; lift them to the head so they run
                // before the old queue's surviving followers.
                const live = queues.get(entity.id) as ActiveTask[];
                live.shift();
                const created = queued;
                const lifted = live.splice(live.length - created.length, created.length);
                // Unshift in REVERSE so the lifted block keeps its order at
                // the head (head first)
                for (let index = lifted.length - 1; index >= 0; index--) {
                    live.unshift(lifted[index]);
                }
                return live[0];
            }
            return queued[0];
        },

        tick: () => {
            const completed: ActiveTask[] = [];
            // Snapshot the queue ENTRIES up front: a completion listener below
            // may queue follow-up work, and a follow-up queued DURING this
            // heartbeat must not also be decremented by it (time is serial —
            // only what existed before the tick progresses this minute)
            arrayEach(Array.from(queues.entries()), ({ value: entry }) => {
                const [actorId, queue] = entry;
                const head = queue[0];
                if (!head) {
                    return;
                }
                // One world-minute of progress for the head task only
                head.remaining = head.remaining - 1;
                if (head.remaining === 0) {
                    // Finished: pop the head (the next task becomes the new one)
                    queue.shift();
                    completed.push(head);
                    // A queue drained to empty leaves the map — tasks() and
                    // the actor-insertion order stay clean
                    if (queue.length === 0) {
                        queues.delete(actorId);
                    }
                }
            });
            // Notify AFTER all decrementing is done — a listener that queues
            // follow-up work sees a consistent ledger. Block body so a
            // listener's return value can never short-circuit the walk.
            arrayEach(completed, ({ value: task }) => {
                arrayEach(Array.from(listeners), ({ value: listener }) => {
                    listener(task);
                });
            });
            return completed;
        },

        onComplete: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        clear: () => {
            // Full dispose: queues, behaviours, listeners and the id counter —
            // a cleared ledger behaves as if never used ("t-1" again)
            queues.clear();
            behaviours.clear();
            listeners.clear();
            taskCounter = 0;
        },
    };
};
