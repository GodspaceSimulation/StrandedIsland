// The sleep environment plugin — the DAILY SLEEP QUOTA as a ledger
// behaviour (R4/T6).
//
// Sleeping is a TASK: the plugin registers one 'sleep' behaviour module
// into the task ledger (plugins/tasks/taskLedger.ts) at priority 30 — high
// enough to SHADOW the behavior plugin's priority-25 'rest' fallback rung
// (plugins/behavior/behaviorPlugin.ts), low enough that the survival rungs
// (thirst 50, hunger 40, the roost 33, the flee 60) interrupt it. The
// behaviour add/remove → task list update rule in action: removing this
// plugin drops the module AND cancels its queued sleep tasks (the ledger's
// update-on-remove rule), and exhausted actors fall back to the old
// instant-rest ladder.
//
// THE DAILY QUOTA — every living body owes 360 world minutes (six hours)
// of sleep per sleep day. A sleep day starts at 06:00 (WAKE_MINUTE, the
// shared clock contract in src/scenario/dayCycle.ts — imported, never
// edited here); the PREFERRED window is 22:00–06:00 (SLEEP_START_MINUTE …
// the wake line), so the gate sleeps a body whose quota is unmet through
// the night EVEN AT FULL ENERGY, and leaves it awake through the day. The
// accounting is exact per minute:
//
//   counted minute — a world minute the sleep task actually PROGRESSED
//                    (its remaining dropped under this plugin's cursor)
//                    or the completing minute (the ledger's completion
//                    event). A PREEMPTED minute — flee, hunger, thirst
//                    pulling the body off its slumber mid-work — counts
//                    NOTHING (the ledger abandons the in-progress task;
//                    the abandoned decrement is lost progress like every
//                    interrupted task's).
//   quota first    — counted minutes fill today's 360; minutes past a full
//                    quota (oversleep, catch-up naps) pay the DEBT.
//   debt           — at the day rollover every unmet quota minute becomes
//                    debt (capped at one quota — a body never owes more
//                    than a night). Debt is caught up ANY time the gate
//                    finds it: the daytime catch-up runs in bounded chunks
//                    (catchUpChunkMinutes) so the body still lives its day
//                    between naps. Under continuous threats the quota may
//                    never fill — the debt model tracks the shortfall
//                    honestly instead of promising an impossible six hours.
//
// THE RESTORE — energy recovers ONLY while the sleep task actually runs,
// one world-minute at a time, and ALWAYS through the needs plugin's
// recovery service (needs.recovery — the R4 resource-backed route: the
// restore charges the body's hunger/thirst equally at the service's
// metabolic ratio, capped by the energy headroom, blocked by an empty
// resource). One restore per PROGRESSED minute, applied in this plugin's
// tick — one tick hook call covers exactly ONE world-minute (engine/world.ts
// sub-stepping). The plan minute restores NOTHING (the queued task has not
// consumed a world minute yet — the taskLedger's rhythm: planned at minute
// M, the first decrement is minute M+1), and the COMPLETING minute restores
// through the ledger's completion event — restore count == task minutes
// elapsed, exactly.
//
// THE SHELTER TREK (R3) — when the construction plugin exposes usable
// shelter gates (the `shelters` provider option — built roofed structures'
// walkable doorways), a body that OWES sleep (night quota or debt) TREKS to
// the nearest gate before lying down: it walks one fine step per minute
// toward the exact gate cell (fineTargetStep — the construction workers'
// own approach), and only once standing ON the gate does the slumber task
// plan. The trek minutes are awake minutes (they eat the window honestly —
// the shortfall rolls into debt like any interrupted minute); the sheltered
// sleep itself is governed by the construction plugin's shelter sweep
// (faster recovery + healing on the gate — the sheltered night is the safe
// night). An EMERGENCY exhaustion nap (energy at the trigger, nothing
// owed) only treks when a gate is within `shelterNapRange` tiles — a spent
// body crawls a short way to cover, then sleeps where it stands. With no
// provider mounted (a run without construction, or before the first
// shelter stands) every body sleeps exactly where it falls — the location-
// agnostic behavior, kept as the safe fallback.
//
// THE SHELTERED RECOVERY (R1 — the injured seek shelter) — a second
// behaviour module (priority 26, between the slumber 30 and the rest
// fallback 25): a SENTIENT body whose health has fallen to `injuredHealth`
// or below, while a usable shelter gate exists, heads for the nearest gate
// and lies down in a recovery REST on it. The rest rides the construction
// plugin's sheltered-sleep sweep (healing on the gate); the survival rungs
// (thirst 50, hunger 40) and the flee (60) still outrank it, and the
// slumber (30) outranks it at night — where the shelter trek already
// carries the sleeper to the same gate. Creatures are exempt (the roost
// rung owns the birds' safe sleep; beasts do not sleep in people's shelters).
//
// The resting minute's METABOLISM is the needs sweep's business (the
// resting-metabolism read keyed on the head task kind, needsPlugin): the
// awake hunger/thirst decay is suspended while the head task is a sleep or
// a rest, so the recovery charge is the minute's whole spend — equal, never
// stacked over the unequal baseline.
//
// Sleep/wake transitions are NOT logged — the log is a story teller (the
// scenario system's encounters), and dozing off is a solo beat, not a
// story between entities.

import { arrayEach } from '@presource/core';
import { position3, type PluginContext, type WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
// R3 — the fine approach to an EXACT gate cell (the construction workers'
// own walker) + the tile metric the nap-range read uses. Shared machinery,
// never reinvented here (plugins/movement/fineMovement.ts).
import { chebyshev, fineTargetStep } from '../movement/fineMovement';
// THE SHARED CLOCK CONTRACT (terrain worker owns the file — never edited
// here): DAY_MINUTES 1440, SLEEP_START_MINUTE 1320 (22:00), WAKE_MINUTE
// 360 (06:00), minuteOfDay(elapsed) with the 10:00 (minute 600) epoch.
import {
    DAY_MINUTES,
    SLEEP_START_MINUTE,
    WAKE_MINUTE,
    minuteOfDay,
} from '../../scenario/dayCycle';

/**
 * R3 — one usable SHELTER GATE: the walkable doorway cell of a built roofed
 * structure, as the construction plugin's shelter service reports it
 * (ConstructionPlugin.shelters() returns this exact shape — the provider is
 * structural so the sleep plugin never imports construction).
 */
export type ShelterGate = { tileX: number; tileY: number; x: number; y: number };

export type SleepPluginOptions = {
    needs: NeedsPlugin;
    tasks: TasksPlugin;
    /** Energy level that triggers an emergency nap whatever the clock says. Default 22 (the old rest trigger). */
    trigger?: number;
    /** Energy requested per world-minute of sleep (through needs.recovery — the actual restore is resource-capped). Default 1.2. */
    restorePerMinute?: number;
    /** The emergency nap's length in world minutes (the exhausted body's bridge nap when no quota or debt is owed). Default 45. */
    durationMinutes?: number;
    /** The daily sleep quota in world minutes. Default 360 — six hours. */
    quotaMinutes?: number;
    /** One daytime catch-up task's cap in world minutes (debt is paid in chunks so the day continues between them). Default 90. */
    catchUpChunkMinutes?: number;
    /**
     * R3 — the deferred SHELTER SERVICE: a getter for the usable shelter
     * gates (built roofed structures' walkable doorways). The scenario
     * mounts sleep BEFORE construction, so the provider is a function the
     * assembly wires to `() => construction.shelters()` — it resolves at
     * plan time, after every plugin stands. Absent (or empty until the
     * first roof stands): the location-agnostic sleep — every body sleeps
     * where it falls.
     */
    shelters?: () => ShelterGate[] | undefined;
    /** World minutes to move ONE SCALE-0 tile (the shelter trek's stride). Default 1 (the distribution's distance rule). */
    travelMinutesPerTile?: number;
    /** R3 — how far (tiles, Chebyshev) an EMERGENCY exhaustion nap will crawl to a shelter gate before napping in place. Default 3. */
    shelterNapRange?: number;
    /** R1 — health at or below which a sentient body seeks a shelter gate to recover (the 'weak' condition line). Default 50. */
    injuredHealth?: number;
    /** R1 — one sheltered recovery rest's length in world minutes. Default 60. */
    recoveryRestMinutes?: number;
};

/** One body's sleep accounting (per sleep day + the carried debt). */
export type SleepAccount = {
    /** The sleep-day index the counters are for (a sleep day starts at 06:00). */
    day: number;
    /** Sleep minutes counted toward the current day's quota. */
    slept: number;
    /** Owed minutes carried from earlier unmet days (capped at the quota). */
    debt: number;
};

export type SleepPlugin = WorldPlugin<World> & {
    /**
     * One body's sleep accounting — the quota read the rosters and tests
     * use (a body that never planned sleep reads zeroed for the current
     * day). Never throws for an unknown id.
     */
    accountOf(entityId: string): SleepAccount;
};

export const sleepPlugin = (options: SleepPluginOptions): SleepPlugin => {
    const { needs, tasks } = options;
    const trigger = options.trigger ?? 22;
    const restorePerMinute = options.restorePerMinute ?? 1.2;
    const durationMinutes = options.durationMinutes ?? 45;
    const quota = options.quotaMinutes ?? 360;
    const catchUpChunk = options.catchUpChunkMinutes ?? 90;
    // R3 — the deferred shelter service (see the option doc). Null: the
    // location-agnostic sleep (the pre-shelter behavior, the safe fallback).
    const shelters = options.shelters ?? null;
    const travel = options.travelMinutesPerTile ?? 1;
    const shelterNapRange = options.shelterNapRange ?? 3;
    const injuredHealth = options.injuredHealth ?? 50;
    const recoveryRestMinutes = options.recoveryRestMinutes ?? 60;

    // The world reference arrives with setup — the tick reads the cast's
    // live tasks, the clock and the accounting through it
    let world: PluginContext<World>['world'] | null = null;

    // ── the sleep-day clock ───────────────────────────────────────────────
    // minuteOfDay's epoch is 600 (10:00 — the cast's arrival clock). The
    // sleep day starts the first elapsed minute whose minute-of-day is the
    // wake line (06:00), so day 0 is the arrival day's partial cycle
    // (10:00 → 06:00 next morning) and every later day runs wake-to-wake.
    const EPOCH_MINUTE = minuteOfDay(0);
    const DAY_START_ELAPSED =
        (((WAKE_MINUTE - EPOCH_MINUTE) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

    /** Which sleep day an elapsed world minute belongs to (0 from arrival). */
    const sleepDayOf = (elapsed: number): number =>
        Math.floor((elapsed - DAY_START_ELAPSED + DAY_MINUTES) / DAY_MINUTES);

    /** THE PREFERRED WINDOW — 22:00–06:00 (SLEEP_START_MINUTE wraps into WAKE_MINUTE). */
    const inPreferredWindow = (minute: number): boolean =>
        minute >= SLEEP_START_MINUTE || minute < WAKE_MINUTE;

    /** World minutes until the window closes at 06:00 (from a minute-of-day inside it). */
    const windowRemaining = (minute: number): number =>
        minute >= SLEEP_START_MINUTE ? DAY_MINUTES - minute + WAKE_MINUTE : WAKE_MINUTE - minute;

    // ── the per-body accounting ──────────────────────────────────────────
    // Created lazily when a body first PLANS a sleep (bodies that never
    // sleep hold no record). The rollover is idempotent per day, so both
    // the gate and the tick may run it.
    const accounts = new Map<string, SleepAccount>();

    // The restore cursor per body: the sleep task id and the remaining we
    // last observed. A DECREASE means world minutes of sleep elapsed — the
    // restore and the accounting count ride exactly that observation, so a
    // preempted minute (the task abandoned before this plugin's tick) is
    // never counted and never restores.
    const cursors = new Map<string, { taskId: string; remaining: number }>();

    // The completion listener handle (the ledger's unsubscribe), torn down
    // at dispose
    let unsubscribeComplete: (() => void) | null = null;

    /** The body's account, rolled over to `today` (idempotent). */
    const currentEntry = (entityId: string, today: number): SleepAccount => {
        let entry = accounts.get(entityId);
        if (!entry) {
            entry = { day: today, slept: 0, debt: 0 };
            accounts.set(entityId, entry);
            return entry;
        }
        if (entry.day !== today) {
            // THE ROLLOVER — the unmet quota becomes debt (capped at one
            // quota: a body never owes more than a night's shortfall), the
            // day's counter resets
            entry.debt = Math.min(quota, entry.debt + Math.max(0, quota - entry.slept));
            entry.slept = 0;
            entry.day = today;
        }
        return entry;
    };

    /** Counts progressed sleep minutes: the quota fills first, overflow pays the debt. */
    const countSlept = (entityId: string, minutes: number): void => {
        const entry = accounts.get(entityId);
        if (!entry) {
            return;
        }
        const quotaRoom = Math.max(0, quota - entry.slept);
        const toQuota = Math.min(minutes, quotaRoom);
        entry.slept += toQuota;
        const overflow = minutes - toQuota;
        if (overflow > 0) {
            entry.debt = Math.max(0, entry.debt - overflow);
        }
    };

    /** ONE SLEEP MINUTE — one restore (through the recovery service) + one count, the same event. */
    const sleepMinute = (entityId: string, minutes: number): void => {
        const active = world;
        // A despawned/dead body restores nothing and counts nothing (its
        // stat record is gone; the cancel event already tore its queue down)
        if (
            !active ||
            (!active.actors.has(entityId) && active.coordinates.entryOf(entityId) === undefined)
        ) {
            return;
        }
        needs.recovery(entityId, restorePerMinute * minutes);
        countSlept(entityId, minutes);
    };

    /** The schedule read for one body at one minute: quota room + debt. */
    const scheduleOf = (entityId: string, now: number): { quotaRemaining: number; debt: number } => {
        const entry = currentEntry(entityId, sleepDayOf(now));
        return { quotaRemaining: Math.max(0, quota - entry.slept), debt: entry.debt };
    };

    // ── R3 — the shelter reads ─────────────────────────────────────────────
    // The usable gates RIGHT NOW (the deferred provider — empty before the
    // first roof stands, absent without the construction wiring). The
    // provider may throw during a half-mounted teardown; a failed read is
    // simply "no shelter" — the safe location-agnostic fallback.
    const gatesNow = (): ShelterGate[] => {
        try {
            return shelters?.() ?? [];
        } catch {
            return [];
        }
    };

    /** Whether the body stands exactly ON one of the usable gates. */
    const onGate = (active: World, actor: { id: string; position: { x: number; y: number } }, gates: ShelterGate[]): boolean => {
        const sub = active.subOf(actor.id);
        if (!sub) {
            return false;
        }
        return gates.some(
            (gate) =>
                gate.tileX === actor.position.x &&
                gate.tileY === actor.position.y &&
                gate.x === sub.x &&
                gate.y === sub.y,
        );
    };

    /** The nearest usable gate by tile Chebyshev (ties: provider order — deterministic). */
    const nearestGate = (
        // Position3D — the registry actor's real position shape (engine/types.ts
        // line 256); chebyshev reads the plane, the z is carried but ignored
        actor: { position: { x: number; y: number; z: number } },
        gates: ShelterGate[],
    ): ShelterGate | undefined => {
        let best: ShelterGate | undefined;
        let bestDistance = Infinity;
        gates.forEach((gate) => {
            const distance = chebyshev(actor.position, position3(gate.tileX, gate.tileY));
            if (distance < bestDistance) {
                best = gate;
                bestDistance = distance;
            }
        });
        return best;
    };

    /**
     * THE SHELTER TREK — one fine step toward the nearest usable gate, or
     * undefined when the body should simply sleep where it stands: no
     * gates, already on one, an emergency nap beyond the crawl range
     * (`allowLongTrek` false — only quota/debt sleeps trek any distance),
     * or no step currently possible (blocked — the caller falls back to
     * sleeping in place rather than standing idle forever).
     */
    const shelterTrek = (
        active: World,
        actor: { id: string; position: { x: number; y: number; z: number } },
        allowLongTrek: boolean,
    ): { kind: string; label: string; minutes: number; payload: { dx: number; dy: number } } | undefined => {
        const gates = gatesNow();
        if (gates.length === 0 || onGate(active, actor, gates)) {
            return undefined;
        }
        const gate = nearestGate(actor, gates);
        if (!gate) {
            return undefined;
        }
        if (!allowLongTrek && chebyshev(actor.position, position3(gate.tileX, gate.tileY)) > shelterNapRange) {
            return undefined;
        }
        const step = fineTargetStep(active, actor, { x: gate.tileX, y: gate.tileY }, { x: gate.x, y: gate.y });
        if (!step) {
            return undefined;
        }
        return {
            kind: 'move',
            label: 'heads for the shelter',
            minutes: travel,
            payload: { dx: step[0], dy: step[1] },
        };
    };

    return {
        id: 'sleep',
        label: 'Sleep',

        setup: (context) => {
            world = context.world;

            // The behaviour module — priority 30 shadows the 'rest' fallback
            // (25) and yields to every survival rung above it. The gate
            // reads the body's live energy AND the daily schedule; the plan
            // queues ONE timed sleep task whose length is the remaining
            // need (capped by the window or the catch-up chunk).
            tasks.behaviour({
                id: 'sleep',
                label: 'Sleep',
                priority: 30,
                appliesTo: (subject) => {
                    const active = world;
                    if (!active) {
                        return false;
                    }
                    const id = subject.actor.id;
                    // EMERGENCY — the exhausted body naps whatever the
                    // clock says (the old energy trigger, kept as the
                    // bottom rung of the schedule)
                    if (needs.of(id).energy <= trigger) {
                        return true;
                    }
                    const now = active.ticker.elapsed();
                    const { quotaRemaining, debt } = scheduleOf(id, now);
                    // THE NIGHT QUOTA — the preferred window sleeps every
                    // body whose day's quota is unmet, EVEN AT FULL ENERGY
                    // (the six hours are owed by the clock, not by fatigue)
                    if (quotaRemaining > 0 && inPreferredWindow(minuteOfDay(now))) {
                        return true;
                    }
                    // THE CATCH-UP — an interrupted night's minutes are
                    // owed any time, day or night, until the debt clears
                    return debt > 0;
                },
                plan: (subject) => {
                    const active = world;
                    if (!active) {
                        return undefined;
                    }
                    const id = subject.actor.id;
                    const now = active.ticker.elapsed();
                    const { quotaRemaining, debt } = scheduleOf(id, now);
                    const need = quotaRemaining + debt;
                    const minute = minuteOfDay(now);
                    // R3 — THE SHELTER TREK: a body that OWES sleep RIGHT
                    // NOW (the night window with quota unmet, or a debt to
                    // catch) walks to the nearest usable gate FIRST — any
                    // distance, the window bounds it honestly; a bare
                    // emergency exhaustion nap (nothing owed yet) only
                    // crawls the short range. On the gate (or with no
                    // shelter to seek) the slumber plans exactly as before.
                    const owesNow = (quotaRemaining > 0 && inPreferredWindow(minute)) || debt > 0;
                    const trek = shelterTrek(active, subject.actor, owesNow);
                    if (trek) {
                        return trek;
                    }
                    if (need > 0 && inPreferredWindow(minute)) {
                        // THE NIGHT SLUMBER — sleep until the need is
                        // filled or 06:00 ends the window (interrupted
                        // minutes become debt at the rollover)
                        return {
                            kind: 'sleep',
                            label: 'sleeps',
                            minutes: Math.max(1, Math.min(need, windowRemaining(minute))),
                        };
                    }
                    if (debt > 0) {
                        // THE CATCH-UP NAP — the debt paid in bounded
                        // chunks; the gate re-opens after each chunk until
                        // the debt clears
                        return {
                            kind: 'sleep',
                            label: 'sleeps',
                            minutes: Math.max(1, Math.min(debt, catchUpChunk)),
                        };
                    }
                    // THE EMERGENCY NAP — exhaustion with nothing owed
                    // (quota met, no debt): the legacy bridge nap. Its
                    // minutes are oversleep — the accounting counts quota
                    // minutes first and there are none to fill, so nothing
                    // is counted (an honest non-debt doze).
                    return { kind: 'sleep', label: 'sleeps', minutes: durationMinutes };
                },
            });

            // R1 — THE SHELTERED RECOVERY (priority 26): an INJURED sentient
            // body (health at or under the 'weak' line) with a usable shelter
            // gate nearby seeks the gate and lies down in a recovery rest ON
            // it — the construction shelter sweep heals sleepers and resters
            // on the gate (the sheltered night is the safe night; the
            // sheltered day mends the wounded). Sits BELOW the slumber (30)
            // so a nightfall's sleep trek serves the same gate, and ABOVE
            // the plain rest fallback (25); the survival rungs (thirst 50,
            // hunger 40) and the flee (60) still interrupt it — recovery
            // never sleeps through a threat or an empty belly. Creatures
            // are exempt (the roost rung owns the birds' safe sleep).
            tasks.behaviour({
                id: 'shelter',
                label: 'Shelter',
                priority: 26,
                appliesTo: (subject) => {
                    if (subject.actor.kind === 'creature') {
                        return false;
                    }
                    if (needs.of(subject.actor.id).health > injuredHealth) {
                        return false;
                    }
                    return gatesNow().length > 0;
                },
                plan: (subject) => {
                    const active = world;
                    if (!active) {
                        return undefined;
                    }
                    const gates = gatesNow();
                    // ON a gate already — the recovery rest (the sheltered
                    // sweep does the healing while the task runs; the rest
                    // completion's one-shot energy rides the behavior
                    // plugin's rest effect as always)
                    if (onGate(active, subject.actor, gates)) {
                        return {
                            kind: 'rest',
                            label: 'recovers in the shelter',
                            minutes: recoveryRestMinutes,
                        };
                    }
                    // Not there yet — trek to the nearest gate (any distance:
                    // the wounded walk slowly, one fine step a minute, and
                    // the needs rungs outrank the whole rung anyway). No
                    // step possible — idle this minute, re-plan the next.
                    return shelterTrek(active, subject.actor, true);
                },
            });

            // THE COMPLETING MINUTE — the task's final remaining minute
            // pops inside the ledger's tick and its head is gone before
            // this plugin's sweep runs, so the last restore + count ride
            // the completion event instead (the cursor is dropped with it).
            // CANCELED tasks never complete — a preempted slumber counts
            // nothing here.
            unsubscribeComplete = tasks.ledger.onComplete((task) => {
                if (task.kind !== 'sleep') {
                    return;
                }
                cursors.delete(task.actorId);
                sleepMinute(task.actorId, 1);
            });
        },

        dispose: () => {
            // Drop the module and cancel its queued sleep tasks — tired
            // actors fall back to the 'rest' ladder immediately (the ledger
            // update-on-remove rule). The completion listener goes with the
            // environment (a swapped-out sleep plugin must not restore into
            // its replacement), then the plugin's own state.
            tasks.dropBehaviour('sleep');
            // R1 — the sheltered-recovery rung goes with the slumber (its
            // queued treks and rests cancel under the ledger's
            // update-on-remove rule)
            tasks.dropBehaviour('shelter');
            unsubscribeComplete?.();
            unsubscribeComplete = null;
            accounts.clear();
            cursors.clear();
            world = null;
        },

        accountOf: (entityId) => {
            const active = world;
            const today = active ? sleepDayOf(active.ticker.elapsed()) : 0;
            const entry = currentEntry(entityId, today);
            return { day: entry.day, slept: entry.slept, debt: entry.debt };
        },

        tick: () => {
            const active = world;
            if (!active) {
                return;
            }
            const now = active.ticker.elapsed();
            const today = sleepDayOf(now);

            // THE ROLLOVER — every tracked account crosses the 06:00 line
            // (unmet quota → debt, capped; counters reset). The map only
            // holds bodies that planned sleep at least once.
            accounts.forEach((_, entityId) => {
                currentEntry(entityId, today);
            });

            /**
             * ONE BODY'S SLEEP SWEEP — restore + count exactly the world
             * minutes the head sleep task PROGRESSED since the last look.
             * First sight (the plan minute: remaining == total) restores
             * nothing — no world minute of sleep has elapsed yet. A body
             * whose head is no longer a sleep task (it completed — handled
             * by the completion event — or was preempted/canceled) drops
             * its cursor and counts nothing this minute.
             */
            const sweep = (entityId: string) => {
                const task = tasks.taskOf(entityId);
                if (task?.kind !== 'sleep') {
                    cursors.delete(entityId);
                    return;
                }
                const cursor = cursors.get(entityId);
                if (!cursor || cursor.taskId !== task.id) {
                    // First sight — park the cursor on the fresh task
                    cursors.set(entityId, { taskId: task.id, remaining: task.remaining });
                    return;
                }
                if (task.remaining < cursor.remaining) {
                    // Progressed minutes since the last look (normally one
                    // per tick — one world-minute per tick hook call)
                    const progressed = cursor.remaining - task.remaining;
                    cursors.set(entityId, { taskId: task.id, remaining: task.remaining });
                    sleepMinute(entityId, progressed);
                }
            };

            // Spawn-order snapshot; despawned actors skip. EVERY living
            // thing sleeps by the same schedule: the castaway registry AND
            // the coordinate-space creatures (a sleeping bird roosts back
            // to full the same way a sleeping castaway does).
            const seen = new Set<string>(active.actors.keys());
            arrayEach(Array.from(active.actors.keys()), ({ value: actorId }) => {
                sweep(actorId);
            });
            active.coordinates.all().forEach((entry) => {
                if (seen.has(entry.id)) {
                    return;
                }
                seen.add(entry.id);
                sweep(entry.id);
            });
        },
    };
};
