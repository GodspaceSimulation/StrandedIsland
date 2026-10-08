// The lumber environment plugin — felling trees into wood as PERSISTENT
// SHARED TILE WORK, planned through the task ledger.
//
// WOOD IS NOT A NATURAL RESOURCE: the standing deposit is the TREE (the
// tile's `tree` resource — the greenery the canvas paints). Wood exists
// only as the PRODUCT of cutting a tree down. This plugin registers one
// 'lumber' behaviour module into the task ledger
// (plugins/tasks/taskLedger.ts) at priority 10 — below the survival needs
// (thirst 50 / hunger 40 / sleep 30 / rest 25 / social 20) and above the
// idle wander (0) — so a comfortable castaway with an empty wood rack goes
// and works the woods instead of milling around:
//   bag holds no wood AND the actor may chop (the species' 'chop' ability,
//     plugins/entity — the skill gate) → work the tile's standing chop job
//     (the beat task, 1 world minute); no job and no tree underfoot →
//     travel one fine step toward the nearest treed tile (1 minute).
//
// THE SHARED JOB (R6) — the felling is NOT one actor's private countdown.
// One job per tile stands in the tasks plugin's TILE WORK LEDGER
// (@godspace/core src/work, mounted in plugins/tasks/tasksPlugin.ts),
// keyed `tileWorkKey(x, y, 'chop')`:
//   • the job demands `chopMinutes` WORK-minutes total (default 15 — the
//     chop is genuinely more than a minute of labor);
//   • every contributor adds 1 work-minute per 1-minute beat task, so N
//     skilled actors on one tile finish it N times faster (the ledger counts
//     labor, the ticker counts world time — R5);
//   • the job PERSISTS: a chopper that dies, gets pre-empted or walks away
//     leaves its minutes in the record — the next actor picks the standing
//     work up, never restarts it (the ledger holds no per-actor state);
//   • any skilled entity may FINISH it: completion is claimed ATOMICALLY
//     (ledger.complete removes the job for exactly one claimant), so a
//     shared tree never drops duplicate wood; a claimant whose harvest fails
//     (a full bag) puts the job back with its progress intact.
//
// THE CHOP EFFECT (registered here as a ledger completion listener — the
// behaviour governs its own tasks) feeds the job and pays out on the claim:
// with the forest ecology mounted one unit of the source tree's wood pool
// leaves the record (the tree STANDS while wood remains; a pool of 0 fells
// it — the standing-tree mirrors sync inside the chop); without it, one
// whole tree deposit unit leaves the stock AND the tile. Either way one
// wood item lands in the bag. A tree felled by someone else during the wait
// means the harvest re-validates and silently fails — the job returns and
// the actor re-plans next minute.
//
// R4 — THE AXE'S EFFECT: a castaway carrying the crafted axe (construction's
// tool-craft rung) opens the job at HALF the work-minutes (the tool is not
// cosmetic; it earns its inputs). The halving happens at OPEN only — joining
// a job an axe-less actor already started keeps its standing total.
//
// 'move' tasks (the treks toward the woods) flow through the behavior
// plugin's move effect — the plugin needs the behavior plugin mounted to
// actually walk (the scenario guards the mount, scenario/island.ts).

import { tileWorkKey, type WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { EntityProfiles } from '../entity/entityPlugin';
import { nearestCell, travelSpec } from '../movement/fineMovement';

/** The shared chop job's kind — lumber and construction (fell) cooperate
 * on ONE record per tile (the same tree, the same labor account). */
export const CHOP_WORK_KIND = 'chop';

export type LumberPluginOptions = {
    inventory: InventoryPlugin;
    tasks: TasksPlugin;
    /**
     * The entity profiles — the species 'chop' ability gate. Absent: every
     * non-creature hand may chop (the pre-entity behavior, mirroring the
     * construction plugin's profiles-optional pattern).
     */
    profiles?: EntityProfiles;
    /** WORK-minutes one tree's chop job demands. Default 15. */
    chopMinutes?: number;
    /** World minutes to move ONE SCALE-0 tile. Default 1 (the
     * distribution's distance rule, scenario/island.ts). */
    travelMinutesPerTile?: number;
};

export type LumberPlugin = WorldPlugin<World> & {};

export const lumberPlugin = (options: LumberPluginOptions): LumberPlugin => {
    const { inventory, tasks } = options;
    // The entity profiles — the 'chop' skill gate. Null: every non-creature
    // hand may chop (the pre-entity behavior).
    const profiles = options.profiles ?? null;
    const chopMinutes = options.chopMinutes ?? 15;
    const travel = options.travelMinutesPerTile ?? 1;

    // The world reference arrives with setup — the chop effect needs the
    // actor registry to re-resolve the task's actor at completion
    let world: World | null = null;

    /**
     * THE SKILL GATE — only the species carrying the 'chop' ability work the
     * woods (the entity plugin's work-kind unlock, the same pattern as the
     * construction 'craft' and inventory 'mine' gates). Without profiles
     * every non-creature hand may chop.
     */
    const mayChop = (type: string | undefined): boolean =>
        !profiles || (type !== undefined && profiles.hasAbility(type, 'chop'));

    /**
     * The job's total work-minutes at OPEN — R4: the axe halves the demand
     * (ceil keeps it a positive integer; a 1-minute job never halves below
     * 1). Joining a standing job never re-prices it (the ledger's open is
     * idempotent).
     */
    const openUnits = (actorId: string): number => {
        const carriesAxe = (inventory.of(actorId).axe ?? 0) > 0;
        return carriesAxe ? Math.max(1, Math.ceil(chopMinutes / 2)) : chopMinutes;
    };

    return {
        id: 'lumber',
        label: 'Lumber',

        setup: (context) => {
            const active = context.world;
            world = active;

            // The behaviour module — the wood rack rule: an actor with an
            // empty wood rack wants a tree felled. Felling stays a SENTIENT
            // CRAFT: the ladder plans creatures too (the behavior plugin's
            // every-living-thing sweep), but a gull or a boar does not work
            // the woods — only skilled, tool-bearing people chop.
            tasks.behaviour({
                id: 'lumber',
                label: 'Lumber',
                priority: 10,
                appliesTo: (subject) =>
                    subject.actor.kind !== 'creature' &&
                    mayChop(subject.actor.type) &&
                    (inventory.of(subject.actor.id).wood ?? 0) === 0,
                plan: (subject) => {
                    const actor = subject.actor;
                    const key = tileWorkKey(actor.position.x, actor.position.y, CHOP_WORK_KIND);
                    // A standing job on this tile — join it (the shared
                    // labor: whoever may chop adds their minute, and ANY
                    // skilled contributor can be the one to finish it)
                    if (tasks.tileWork.get(key)) {
                        return { kind: 'chop', label: 'chops a tree', minutes: 1 };
                    }
                    // No job yet — a tree standing underfoot OPENS one (the
                    // axe halves the demand at open, R4)
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    if ((stock.tree ?? 0) > 0) {
                        tasks.tileWork.open({
                            key,
                            kind: CHOP_WORK_KIND,
                            units: openUnits(actor.id),
                            skill: 'chop',
                        });
                        return { kind: 'chop', label: 'chops a tree', minutes: 1 };
                    }
                    // Walk toward the nearest treed tile
                    const grove = nearestCell(actor, inventory.cellsWithItem('tree'));
                    if (!grove) {
                        return undefined;
                    }
                    return travelSpec(active, actor, 'travels to trees', grove, travel);
                },
            });

            // The chop effect — one work-minute per completed beat, and the
            // payout on the atomic claim. The harvest re-validates (with the
            // ecology mounted: the pool cut re-validated against the
            // standing tree; without: the whole deposit unit). No log line —
            // felling is a solo beat, not a story between entities (the log
            // is a story teller).
            tasks.ledger.onComplete((task) => {
                if (task.kind !== 'chop' || !world) {
                    return;
                }
                const actor = world.actors.get(task.actorId);
                if (!actor) {
                    return;
                }
                const key = tileWorkKey(actor.position.x, actor.position.y, CHOP_WORK_KIND);
                const unit = tasks.tileWork.add(key, 1);
                // The job was already claimed this minute (a co-worker won
                // the race) — this beat lands nowhere; the actor re-plans
                if (!unit || unit.progress < unit.units) {
                    return;
                }
                // THE ATOMIC CLAIM — exactly one contributor ever receives
                // the finished job (no duplicate wood from a shared tree)
                const claimed = tasks.tileWork.complete(key);
                if (!claimed) {
                    return;
                }
                const harvested = inventory.harvest(actor, 'tree', 'wood');
                if (!harvested) {
                    // The payout failed (a full bag, a co-worker's last
                    // pool unit) — the standing work returns for the next
                    // contributor, its minutes never lost
                    tasks.tileWork.put(claimed);
                }
            });
        },

        dispose: () => {
            // Drop the module and cancel its queued tasks (the ledger's
            // update-on-remove rule) — woodless actors fall back to the
            // wider behaviour ladder immediately. The tile WORK stays: the
            // jobs belong to the tasks environment (its dispose clears
            // them), not to this behaviour slice.
            tasks.dropBehaviour('lumber');
            world = null;
        },
    };
};
