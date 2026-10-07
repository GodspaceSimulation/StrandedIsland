// The lumber environment plugin — felling trees into wood, as a ledger
// behaviour.
//
// WOOD IS NOT A NATURAL RESOURCE: the standing deposit is the TREE (the
// tile's `tree` resource — the greenery the canvas paints). Wood exists
// only as the PRODUCT of cutting a tree down. This plugin registers one
// 'lumber' behaviour module into the task ledger
// (plugins/tasks/taskLedger.ts) at priority 10 — below the survival needs
// (thirst 50 / hunger 40 / sleep 30 / rest 25 / social 20) and above the
// idle wander (0) — so a comfortable castaway with an empty wood rack goes
// and works the woods instead of milling around:
//   bag holds no wood → a tree standing on the actor's tile is FELLED (the
//     chop task, `chopMinutes` world minutes — the harvest converts one
//     tree deposit into one wood item in the bag); no tree underfoot →
//     travel one fine step toward the nearest treed tile (1 minute).
//
// The chop EFFECT (registered here as a ledger completion listener — the
// behaviour governs its own tasks) converts the tree into wood at
// completion: with the forest ecology mounted (the scenario's default) one
// unit of the source tree's wood pool leaves the record (the tree STANDS
// while wood remains; a pool of 0 fells it — the standing-tree mirrors
// sync inside the chop); without it, one whole tree deposit unit leaves
// the stock AND the tile. Either way one wood item lands in the bag. A
// tree felled by someone else during the wait means the harvest
// re-validates and silently fails — the actor re-plans next minute.
//
// 'move' tasks (the treks toward the woods) flow through the behavior
// plugin's move effect — the plugin needs the behavior plugin mounted to
// actually walk (the scenario guards the mount, scenario/island.ts).

import type { WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import { nearestCell, travelSpec } from '../movement/fineMovement';

export type LumberPluginOptions = {
    inventory: InventoryPlugin;
    tasks: TasksPlugin;
    /** World minutes to fell one tree. Default 15. */
    chopMinutes?: number;
    /** World minutes to move ONE SCALE-0 tile. Default 1 (the
     * distribution's distance rule, scenario/island.ts). */
    travelMinutesPerTile?: number;
};

export type LumberPlugin = WorldPlugin<World> & {};

export const lumberPlugin = (options: LumberPluginOptions): LumberPlugin => {
    const { inventory, tasks } = options;
    const chopMinutes = options.chopMinutes ?? 15;
    const travel = options.travelMinutesPerTile ?? 1;

    // The world reference arrives with setup — the chop effect needs the
    // actor registry to re-resolve the task's actor at completion
    let world: World | null = null;

    return {
        id: 'lumber',
        label: 'Lumber',

        setup: (context) => {
            const active = context.world;
            world = active;

            // The behaviour module — the wood rack rule: an actor with an
            // empty wood rack wants a tree felled. Felling stays a SENTIENT
            // craft: the ladder plans creatures too (the behavior plugin's
            // every-living-thing sweep), but a gull or a boar does not work
            // the woods — only tool-bearing people chop.
            tasks.behaviour({
                id: 'lumber',
                label: 'Lumber',
                priority: 10,
                appliesTo: (subject) =>
                    subject.actor.kind !== 'creature' &&
                    (inventory.of(subject.actor.id).wood ?? 0) === 0,
                plan: (subject) => {
                    const actor = subject.actor;
                // A tree standing underfoot — the felling is the task
                // (the wood lands in the bag on completion, one tree
                // per chop)
                const stock = inventory.cellStock(actor.position.x, actor.position.y);
                if ((stock.tree ?? 0) > 0) {
                    // R4 — THE AXE'S EFFECT: a castaway carrying the crafted
                    // axe (construction's tool-craft rung) works the woods
                    // FASTER — the chop's world-minute cost halves (the tool
                    // is not cosmetic; it earns its inputs). Without the
                    // axe the base chopMinutes applies.
                    const carriesAxe = (inventory.of(actor.id).axe ?? 0) > 0;
                    const minutes = carriesAxe ? Math.max(1, Math.ceil(chopMinutes / 2)) : chopMinutes;
                    return { kind: 'chop', label: 'chops a tree', minutes };
                }
                    // Walk toward the nearest treed tile
                    const grove = nearestCell(actor, inventory.cellsWithItem('tree'));
                    if (!grove) {
                        return undefined;
                    }
                    return travelSpec(active, actor, 'travels to trees', grove, travel);
                },
            });

            // The chop effect — tree → wood, applied on completion. The
            // harvest re-validates (with the ecology mounted: the pool cut
            // re-validated against the standing tree; without: the whole
            // deposit unit). No log line — felling is a solo beat, not a
            // story between entities (the log is a story teller).
            tasks.ledger.onComplete((task) => {
                if (task.kind !== 'chop' || !world) {
                    return;
                }
                const actor = world.actors.get(task.actorId);
                if (!actor) {
                    return;
                }
                inventory.harvest(actor, 'tree', 'wood');
            });
        },

        dispose: () => {
            // Drop the module and cancel its queued tasks (the ledger's
            // update-on-remove rule) — woodless actors fall back to the
            // wider behaviour ladder immediately
            tasks.dropBehaviour('lumber');
            world = null;
        },
    };
};
