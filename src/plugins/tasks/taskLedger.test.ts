// Tests for the task ledger (plugins/tasks/taskLedger.ts).
//
// Deterministic and exact: every assertion pins the FULL task shape with
// toEqual (never ranges), on tiny hand-built actors — no world, no
// randomness. The ledger is pure logic; the one-world-minute heartbeat it
// counts down is contracted by engine/world.ts step() sub-stepping.

import { describe, it, expect } from 'vitest';
import { createTaskLedger } from './taskLedger';
import type { ActiveTask, TaskBehaviour, TaskSpec } from './taskLedger';
import type { Actor } from '../../engine/types';

// Tiny hand-built actor records — the ledger only reads the actor itself
const makeActor = (id: string, name: string): Actor => ({
    id,
    name,
    kind: 'sentient',
    type: 'human',
    position: { x: 0, y: 0, z: 0 },
    marker: name.slice(0, 1),
    condition: 'well',
});

// A behaviour module that always applies and always queues the given specs
const planning = (id: string, priority: number, specs: TaskSpec[]): TaskBehaviour => ({
    id,
    priority,
    appliesTo: () => true,
    plan: () => specs,
});

// One tile of travel = 10 world minutes at scale 0 (pinned by the island engine)
const stepEast: TaskSpec = { kind: 'move', label: 'steps east', minutes: 10, payload: { dx: 1, dy: 0 } };
const sleep = (minutes: number): TaskSpec => ({ kind: 'sleep', label: 'sleeps', minutes });

describe('createTaskLedger', () => {
    it('plans through behaviour modules in priority order — highest first', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour(planning('wander', 5, [{ kind: 'wander', label: 'wanders', minutes: 10 }]));
        ledger.behaviour(planning('sleep', 10, [sleep(480)]));
        const planned = ledger.plan(ael);
        // The priority-10 sleep module is consulted first and wins the queue
        expect(planned).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'sleep',
            kind: 'sleep',
            label: 'sleeps',
            minutes: 480,
            total: 480,
            remaining: 480,
        });
        expect(ledger.taskOf('a')).toEqual(planned);
    });

    it('breaks priority ties by first-registration order', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour(planning('first', 3, [{ kind: 'wander', label: 'first wanders', minutes: 10 }]));
        ledger.behaviour(planning('second', 3, [{ kind: 'eat', label: 'second eats', minutes: 5 }]));
        ledger.plan(ael);
        expect(ledger.taskOf('a')?.behaviour).toBe('first');
        expect(ledger.taskOf('a')?.label).toBe('first wanders');
    });

    it('behaviours() lists modules in planning order, registration order as tiebreak', () => {
        const ledger = createTaskLedger();
        ledger.behaviour({ id: 'low', priority: 5 });
        ledger.behaviour({ id: 'mid' });
        ledger.behaviour({ id: 'high', priority: 10 });
        ledger.behaviour({ id: 'alsoLow', priority: 5 });
        // priority DESC; the two 5s keep registration order; no priority = 0
        expect(ledger.behaviours().map((module) => module.id)).toEqual([
            'high',
            'low',
            'alsoLow',
            'mid',
        ]);
    });

    it('skips a behaviour whose gate declines and plans with the next one', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        let seen: unknown;
        ledger.behaviour({
            id: 'sleep',
            priority: 10,
            // The gate reads the handed subject and declines this moment
            appliesTo: (subject) => {
                seen = subject.actor;
                return false;
            },
            plan: () => [sleep(480)],
        });
        ledger.behaviour(planning('wander', 0, [{ kind: 'wander', label: 'wanders', minutes: 10 }]));
        ledger.plan(ael);
        // The gate saw the exact actor record…
        expect(seen).toEqual(ael);
        // …and the walk module picked the task up instead
        expect(ledger.taskOf('a')?.behaviour).toBe('wander');
    });

    it('continues planning when a gate-passing module declines (void plan)', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour({
            id: 'social',
            priority: 10,
            appliesTo: () => true,
            // Void plan = declined this moment — planning moves on
            plan: () => undefined,
        });
        // Nothing queued at all → undefined, actor stays idle
        expect(ledger.plan(ael)).toBeUndefined();
        expect(ledger.busy('a')).toBe(false);
        // A lower-priority module gets its turn on the next planning round
        ledger.behaviour(planning('drink', 0, [{ kind: 'drink', label: 'drinks', minutes: 2 }]));
        ledger.plan(ael);
        expect(ledger.taskOf('a')?.behaviour).toBe('drink');
    });

    it('queues every spec of a multi-spec plan in order', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour(planning('walk', 0, [stepEast, stepEast]));
        ledger.plan(ael);
        expect(ledger.queueOf('a')).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'walk',
                kind: 'move',
                label: 'steps east',
                minutes: 10,
                payload: { dx: 1, dy: 0 },
                total: 10,
                remaining: 10,
            },
            {
                id: 't-2',
                actorId: 'a',
                behaviour: 'walk',
                kind: 'move',
                label: 'steps east',
                minutes: 10,
                payload: { dx: 1, dy: 0 },
                total: 10,
                remaining: 10,
            },
        ]);
        expect(ledger.busy('a')).toBe(true);
    });

    it('stores a spec payload as a copy — later caller mutations cannot reach the queue', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        const payload: Record<string, unknown> = { dx: 1, dy: 0 };
        const spec: TaskSpec = { kind: 'move', label: 'steps east', minutes: 10, payload };
        ledger.behaviour(planning('walk', 0, [spec]));
        ledger.plan(ael);
        // Mutating the caller's payload (and the spec object) after queueing
        payload.dx = 9;
        spec.label = 'hacked';
        expect(ledger.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'walk',
            kind: 'move',
            label: 'steps east',
            minutes: 10,
            payload: { dx: 1, dy: 0 },
            total: 10,
            remaining: 10,
        });
    });

    it('does not plan for a busy actor', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour(planning('sleep', 10, [sleep(480)]));
        ledger.queue('a', 'walk', [stepEast]);
        expect(ledger.plan(ael)).toBeUndefined();
        // The pre-existing queue is untouched — head still the walk task
        expect(ledger.taskOf('a')?.behaviour).toBe('walk');
        expect(ledger.queueOf('a')).toHaveLength(1);
    });

    it('counts a task down one world-minute per tick and completes it at 0', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour(planning('rest', 0, [sleep(3)]));
        ledger.plan(ael);
        const completions: ActiveTask[] = [];
        ledger.onComplete((task) => {
            completions.push(task);
        });

        // Minute 1 and 2 — progress, no completion yet
        expect(ledger.tick()).toEqual([]);
        expect(ledger.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'rest',
            kind: 'sleep',
            label: 'sleeps',
            minutes: 3,
            total: 3,
            remaining: 2,
        });
        expect(ledger.busy('a')).toBe(true);
        expect(ledger.tick()).toEqual([]);
        expect(ledger.taskOf('a')?.remaining).toBe(1);

        // Minute 3 — the task completes: popped, reported, announced
        const done = ledger.tick();
        expect(done).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'rest',
                kind: 'sleep',
                label: 'sleeps',
                minutes: 3,
                total: 3,
                remaining: 0,
            },
        ]);
        expect(completions).toEqual(done);
        expect(ledger.queueOf('a')).toEqual([]);
        expect(ledger.busy('a')).toBe(false);
    });

    it('advances every queue head one minute per tick', () => {
        const ledger = createTaskLedger();
        // Ael walks for 2 minutes; Bo naps for exactly 1
        ledger.queue('a', 'walk', [{ ...stepEast, minutes: 2 }]);
        ledger.queue('b', 'rest', [{ kind: 'sleep', label: 'naps', minutes: 1 }]);
        // Actor-insertion order (a then b), queue order inside each actor
        expect(ledger.tasks()).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'walk',
                kind: 'move',
                label: 'steps east',
                minutes: 2,
                payload: { dx: 1, dy: 0 },
                total: 2,
                remaining: 2,
            },
            {
                id: 't-2',
                actorId: 'b',
                behaviour: 'rest',
                kind: 'sleep',
                label: 'naps',
                minutes: 1,
                total: 1,
                remaining: 1,
            },
        ]);

        const done = ledger.tick();
        // B's 1-minute task completed; only it is returned
        expect(done).toEqual([
            {
                id: 't-2',
                actorId: 'b',
                behaviour: 'rest',
                kind: 'sleep',
                label: 'naps',
                minutes: 1,
                total: 1,
                remaining: 0,
            },
        ]);
        // B's drained queue left the map entirely; A's head keeps counting
        expect(ledger.queueOf('b')).toEqual([]);
        expect(ledger.tasks()).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'walk',
                kind: 'move',
                label: 'steps east',
                minutes: 2,
                payload: { dx: 1, dy: 0 },
                total: 2,
                remaining: 1,
            },
        ]);
    });

    it('lets a completion listener queue follow-up work that becomes the new head', () => {
        const ledger = createTaskLedger();
        ledger.queue('a', 'walk', [{ ...stepEast, minutes: 1 }]);
        // On completion the walk behaviour queues the next step. The ledger
        // notifies only after all decrementing is done, so the follow-up is
        // not decremented by the same heartbeat (time is serial)
        ledger.onComplete((task) => {
            if (task.kind === 'move') {
                ledger.queue(task.actorId, 'walk', [{ ...stepEast, minutes: 2, label: 'steps east again' }]);
            }
        });
        const done = ledger.tick();
        expect(done).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'walk',
                kind: 'move',
                label: 'steps east',
                minutes: 1,
                payload: { dx: 1, dy: 0 },
                total: 1,
                remaining: 0,
            },
        ]);
        // The follow-up is the new head, still at full remaining
        expect(ledger.taskOf('a')).toEqual({
            id: 't-2',
            actorId: 'a',
            behaviour: 'walk',
            kind: 'move',
            label: 'steps east again',
            minutes: 2,
            payload: { dx: 1, dy: 0 },
            total: 2,
            remaining: 2,
        });
        // …and it counts down from there
        expect(ledger.tick()).toEqual([]);
        expect(ledger.taskOf('a')?.remaining).toBe(1);
    });

    it('cancels exactly the tasks of the dropped behaviour — drained actors go idle', () => {
        const ledger = createTaskLedger();
        // Ael: two walk tasks then one rest task; Bo: walk tasks only
        ledger.behaviour({ id: 'walk' });
        ledger.behaviour({ id: 'rest' });
        ledger.queue('a', 'walk', [stepEast, stepEast]);
        ledger.queue('a', 'rest', [sleep(480)]);
        ledger.queue('b', 'walk', [stepEast]);
        expect(ledger.dropBehaviour('walk')).toBe(true);
        // Exactly the walk tasks vanish — the rest task survives untouched
        expect(ledger.queueOf('a')).toEqual([
            {
                id: 't-3',
                actorId: 'a',
                behaviour: 'rest',
                kind: 'sleep',
                label: 'sleeps',
                minutes: 480,
                total: 480,
                remaining: 480,
            },
        ]);
        // Bo's queue came entirely from walk → idle again, queue entry gone
        expect(ledger.queueOf('b')).toEqual([]);
        expect(ledger.busy('b')).toBe(false);
        expect(ledger.tasks().map((task) => task.id)).toEqual(['t-3']);
        // Unknown id — and an already-dropped id — report false
        expect(ledger.dropBehaviour('ghost')).toBe(false);
        expect(ledger.dropBehaviour('walk')).toBe(false);
    });

    it('overwrites a behaviour in place — new plan wins, registration order holds', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        ledger.behaviour(planning('walk', 0, [stepEast]));
        ledger.behaviour({ id: 'idle', priority: 0 });
        // Re-register walk with a different plan — a Map re-set keeps position
        ledger.behaviour(planning('walk', 0, [{ kind: 'wander', label: 'wanders', minutes: 20 }]));
        // Registration order unchanged: walk first, idle second
        expect(ledger.behaviours().map((module) => module.id)).toEqual(['walk', 'idle']);
        ledger.plan(ael);
        // …and the NEW plan output is what gets queued next round
        expect(ledger.taskOf('a')).toEqual({
            id: 't-1',
            actorId: 'a',
            behaviour: 'walk',
            kind: 'wander',
            label: 'wanders',
            minutes: 20,
            total: 20,
            remaining: 20,
        });
    });

    it('queue accepts a single spec object; an empty specs array queues nothing', () => {
        const ledger = createTaskLedger();
        const created = ledger.queue('a', 'rest', sleep(480));
        expect(created).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'rest',
                kind: 'sleep',
                label: 'sleeps',
                minutes: 480,
                total: 480,
                remaining: 480,
            },
        ]);
        expect(ledger.queue('a', 'walk', [])).toEqual([]);
        expect(ledger.queueOf('a')).toHaveLength(1);
        expect(ledger.busy('a')).toBe(true);
    });

    it('clear() wipes queues, behaviours and listeners, resetting the id counter', () => {
        const ledger = createTaskLedger();
        const ael = makeActor('a', 'Ael');
        const completions: ActiveTask[] = [];
        ledger.onComplete((task) => {
            completions.push(task);
        });
        ledger.behaviour(planning('rest', 0, [sleep(2)]));
        ledger.plan(ael);
        ledger.clear();
        expect(ledger.tasks()).toEqual([]);
        expect(ledger.behaviours()).toEqual([]);
        expect(ledger.busy('a')).toBe(false);
        // The wiped listener never hears about later completions
        ledger.queue('a', 'rest', [{ kind: 'sleep', label: 'naps', minutes: 1 }]);
        // The 1-minute nap completes on this tick — reported, but to no one
        expect(ledger.tick()).toEqual([
            {
                id: 't-1',
                actorId: 'a',
                behaviour: 'rest',
                kind: 'sleep',
                label: 'naps',
                minutes: 1,
                total: 1,
                remaining: 0,
            },
        ]);
        expect(completions).toEqual([]);
        // The id counter reset — the post-clear nap above came out as "t-1"
        // again; the next queued task simply continues at "t-2"
        expect(ledger.queue('a', 'walk', [stepEast])).toEqual([
            {
                id: 't-2',
                actorId: 'a',
                behaviour: 'walk',
                kind: 'move',
                label: 'steps east',
                minutes: 10,
                payload: { dx: 1, dy: 0 },
                total: 10,
                remaining: 10,
            },
        ]);
    });
});
