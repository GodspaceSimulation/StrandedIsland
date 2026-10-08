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
// ONE flee task: the RUNNING STRIDE — a full tile away from the nearest
// threat (1 world minute, the profile's run row), or — when the animal
// already shares the actor's tile, or the away tile is wet — a COMMITTED
// EXIT: the stride toward the nearest DRY neighbor tile that is not the
// beast's own.
//
// THE COMMITTED EXIT (the fatal-chase correction) — the old blind flight
// drew ANY valid fine step at random. The threat scan is TILE-level, so a
// beast anywhere on the actor's tile (a 25×17 sub-grid at the default
// island) keeps the flee re-planning every minute; a directionless random
// step is a pure random walk whose expected time to reach a tile edge is
// hundreds of minutes —
// the actor mills inside the threatened tile while every bite minute
// lands, and dies on the tile it was never able to leave (the seed-7
// campaign chase: Ael @4,4 mauled 8323–8341, flees re-planned every
// minute, zero net progress). The exit rung instead picks the edge the
// actor reaches in the FEWEST fine steps whose neighbor tile is dry and
// walks it — escape is bounded (≤ half+1 minutes from the tile center,
// usually far less) and deterministic; the away rung takes over the
// minute the actor crosses, and the random blind flight survives only
// as the cornered fallback (a water-locked islet with no dry edge).
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
import { chebyshev, fineStep } from '../movement/fineMovement';

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
                    // Away from the threat: the TILE one step beyond the
                    // actor, on the far side. R6-INTEGRATION — a flee is a
                    // FULL-TILE stride (the profile's RUN row: one minute a
                    // tile, threefold the energy), not a fine step: a boar
                    // crosses a tile every 2 minutes (the entity profile's
                    // walk pace), so a fine-step flee (1/25 tile a minute)
                    // can never outpace it — the victim mirrors the beast
                    // tile for tile and is mauled mid-oscillation (the
                    // seed-7 campaign: Cove @1,5↔0,5, minutes 9805–9837,
                    // health 100→0 while every flee 'succeeded'). The
                    // running stride outruns the lumbering gait: two tiles
                    // of gap per three minutes of chase.
                    const dx = Math.sign(actor.position.x - threat.x);
                    const dy = Math.sign(actor.position.y - threat.y);
                    if (dx !== 0 || dy !== 0) {
                        const tx = actor.position.x + dx;
                        const ty = actor.position.y + dy;
                        if (active.cellAt(tx, ty)?.passable === true) {
                            return tileFleeSpec(tx, ty, travel);
                        }
                    }
                    // The animal shares the actor's tile (or the away side
                    // is wet/blocked) — COMMITTED EXIT: run for the nearest
                    // DRY neighbor tile. Deterministic (no roll); the
                    // stride lands the actor a full tile away in one minute,
                    // and the away rung keeps the gap open from there.
                    const exit = exitStep(active, actor, threat);
                    if (exit) {
                        return tileFleeSpec(actor.position.x + exit[0], actor.position.y + exit[1], travel);
                    }
                    // Cornered — no dry edge to run for (a water-locked
                    // islet) and no step at all: the threat bites next
                    // minute. The random blind flight is the last resort
                    // when an edge exists but the direct walk is fully
                    // blocked this minute.
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

/**
 * The four edge directions of a tile's sub-grid, in the fixed deterministic
 * order the exit tiebreak falls back on (north, east, south, west).
 */
const EXIT_DIRECTIONS: ReadonlyArray<{ dx: number; dy: number }> = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
];

/**
 * THE COMMITTED EXIT — the fine step toward the tile edge the actor reaches
 * in the FEWEST fine steps whose neighbor tile is dry (subTileStep: the
 * step FROM the edge cell wraps into the neighbor, so the steps to cross
 * the +x edge from sub x are halfX − x + 1). A directionless random step
 * (the old blind flight) is a pure random walk on the tile's fine grid —
 * the tile-level threat scan never clears while the beast shares the tile,
 * so the flee re-plans forever, nets nothing, and the actor is mauled on
 * the tile (the seed-7 campaign chase: Ael @4,4, minutes 8323–8341). The
 * committed walk bounds escape by half+1 minutes from the tile center and
 * is fully deterministic: no roll, no stream consumption.
 *
 * Ties between equal-length dry edges prefer the one facing AWAY from the
 * beast's fine spot (run out the far side, not past the animal); the fixed
 * EXIT_DIRECTIONS order breaks what remains. Wet edges are skipped — the
 * sea is not an exit (fineStep refuses the wrap anyway). Null when no dry
 * edge exists (a water-locked islet — the caller's cornered fallback).
 */
const exitStep = (
    world: World,
    actor: TaskEntity,
    threat: { id: string; x: number; y: number },
): [number, number] | null => {
    const sub = world.subOf(actor.id);
    if (!sub) {
        return null;
    }
    const halfX = (world.canvas.width - 1) / 2;
    const halfY = (world.canvas.height - 1) / 2;
    // The beast's fine spot — the away tiebreak reads it (a beast that
    // never fine-moved carries its derived spot, same registry read)
    const beastSub = world.subOf(threat.id);
    let best: { dx: number; dy: number; steps: number; away: boolean } | null = null;
    // (a plain copy — arrayEach walks a mutable array; the registry itself
    // stays a ReadonlyArray so the direction order can never be mutated)
    arrayEach([...EXIT_DIRECTIONS], ({ value: dir }) => {
        // The edge must open onto DRY ground — running into the sea is
        // not an escape. And it must NOT open onto the BEAST's own tile —
        // the exit runs away from the threat, never into its jaws (the
        // away side may be wet while the beast's tile is dry: the tile
        // check is what keeps the committed exit honest)
        const neighbor = world.cellAt(actor.position.x + dir.dx, actor.position.y + dir.dy);
        if (
            neighbor?.passable !== true ||
            (actor.position.x + dir.dx === threat.x && actor.position.y + dir.dy === threat.y)
        ) {
            return;
        }
        // Fine steps until the wrap crosses this edge
        const steps =
            dir.dx === 1
                ? halfX - sub.x + 1
                : dir.dx === -1
                  ? sub.x + halfX + 1
                  : dir.dy === 1
                    ? halfY - sub.y + 1
                    : sub.y + halfY + 1;
        // Does this edge direction run away from the beast's fine spot?
        const away =
            beastSub !== undefined &&
            ((dir.dx !== 0 && Math.sign(sub.x - beastSub.x) === dir.dx) ||
                (dir.dy !== 0 && Math.sign(sub.y - beastSub.y) === dir.dy));
        // Fewest steps wins; ties prefer the away-facing edge; the fixed
        // direction order (arrayEach never re-orders) breaks the rest
        if (!best || steps < best.steps || (steps === best.steps && away && !best.away)) {
            best = { dx: dir.dx, dy: dir.dy, steps, away };
        }
    });
    // TS cannot see through the arrayEach closure's assignments — the
    // explicit cast re-widens the winner for the stride below
    const chosen = best as { dx: number; dy: number; steps: number; away: boolean } | null;
    if (!chosen) {
        return null;
    }
    // The committed exit answers with the TILE direction to run — the
    // caller's stride relocates a whole tile per minute (no fine walking)
    return [chosen.dx, chosen.dy];
};

/** One flee step — a 'move' task tagged `flee` (the behavior plugin's move
 * effect applies every move task identically; the tag reads in payloads). */
const fleeSpec = (dx: number, dy: number, travel: number): TaskSpec => ({
    kind: 'move',
    label: 'flees',
    minutes: travel,
    payload: { dx, dy, flee: true },
});

/**
 * THE RUNNING STRIDE — a flee that relocates the body a FULL SCALE-0 tile
 * in one task (the profile's run row: one minute a tile, threefold the
 * energy — the behavior plugin's move effect sees `tx`/`ty` and applies
 * the coarse relocation). A fine-step flee is 25× slower than a boar's
 * two-minutes-a-tile gait; the stride is what makes escape physically
 * possible against the island's lumbering threats.
 */
const tileFleeSpec = (tx: number, ty: number, travel: number): TaskSpec => ({
    kind: 'move',
    label: 'flees',
    minutes: travel,
    payload: { tx, ty, flee: true },
});
