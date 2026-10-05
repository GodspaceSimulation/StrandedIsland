// The behavior environment plugin — the agent decision loop, TASK-DRIVEN.
//
// The plugin no longer decides one instant action per world-minute (the old
// per-minute priority ladder). It now REGISTERS behaviour modules into the
// task ledger (plugins/tasks/taskLedger.ts) and applies the task EFFECTS on
// completion. The rhythm: tasks cost WORLD MINUTES — moving ONE SCALE-0
// TILE costs `travelMinutesPerTile` (ONE — the distribution's distance rule:
// one Scale-0 tile move per tick, scenario/island.ts) — so an actor that
// plans a move stays busy for one minute and the effect lands on the
// completing minute. Behaviours add/remove update task lists per the
// ledger rules: registering one changes future planning only; dropping one
// cancels its queued tasks and the actors go idle again.
//
// The registered ladder (priority DESC; the ledger plans the first module
// whose gate passes and whose plan yields specs):
//   thirst  50 — thirst ≥ 65       → drink from the cell's pool (2 min), or
//                                    travel one fine step toward the
//                                    nearest pool (1 min)
//   hunger  40 — hunger ≥ 60       → eat from the bag (2 min), gather the
//                                    cell's food (10 min), or travel toward
//                                    the nearest food stock (1 min)
//   rest    25 — energy ≤ 22       → rest 10 min, recovery applied on
//                                    completion. FALLBACK — the sleep plugin
//                                    (plugins/sleep/sleepPlugin.ts) registers
//                                    a higher-priority 'sleep' module that
//                                    shadows this one; removing sleep falls
//                                    back to instant-rest behaviour
//   social  20 — cooldown elapsed  → trade/gift a hungry neighbour; the
//                                    exchange applies AT PLAN TIME (the task
//                                    itself is the 1-min cost of the
//                                    encounter)
//   wander   0 — always           → one random fine step (1 min), nothing
//                                    planned when no fine step is free
//
// Movement runs at SCALE 0 — the simulation ground: every move task walks
// the actor ONE SUBTILE CELL inside its tile's sub-grid
// (world.relocateFine). A step that stays inside the parent tile is free
// ground; a step off a tile edge WRAPS into the neighbor tile (the
// @godspace/core subTile continuity rule) and must find dry, unoccupied
// ground there. The energy charge lands on a TILE CROSSING — milling
// around inside a tile is free, walking into the next tile costs the move
// (the coarse walk's economics, preserved at the fine granularity).
//
// Task EFFECTS (registered as a ledger completion listener, applied when a
// task reaches 0 remaining):
//   move    — re-validates the fine step (bounds, the wrap's tiles passable,
//             the destination fine spot unoccupied) then fine-relocates,
//             charges the move energy on a tile crossing and logs. A blocked
//             move logs NOTHING — the actor re-plans next minute.
//   drink   — takes water from the cell (re-validated), consumes it, relieves
//             thirst.
//   eat     — consumes the planned item from the bag (re-validated), restores
//             nutrition/hydration from the item catalog.
//   gather  — gathers from the cell (the inventory re-validates the stock).
//   rest    — restores energy (the instant-rest recovery, once per completed
//             rest). The sleep plugin restores its own tasks per-minute and
//             does NOT go through here.
//   social  — nothing: the exchange/gift already happened at plan time.
//
// Depends on the inventory, needs, relationship and tasks plugin APIs
// (passed as options — see scenario/island.ts for the assembly).

import { arrayEach } from '@presource/core';
import {
    GROUND_LEVEL,
    NEIGHBOR_OFFSETS,
    planeDistance,
    position3,
    subTileStep,
    type PluginContext,
    type WorldPlugin,
    type Position3D,
} from '@godspace/core';
import { itemDef } from '../inventory/items';
import type { World } from '../../engine/world';
import type { Actor, TerrainCell } from '../../engine/types';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { RelationshipPlugin } from '../relationship/relationshipPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { TaskSpec } from '../tasks/taskLedger';

export type BehaviorPluginOptions = {
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    relationship: RelationshipPlugin;
    tasks: TasksPlugin;
    /** World minutes to move ONE SCALE-0 tile (one subtile cell). Default 1 —
     * the distribution's distance rule: one tile move per tick
     * (scenario/island.ts pins it). */
    travelMinutesPerTile?: number;
    /** World-minutes between social attempts per actor. Default 60. */
    socialCooldownMinutes?: number;
    /** Minutes busy for the quick actions. Defaults: eat/drink 2, gather 10,
     * social 10, rest 10. */
    eatMinutes?: number;
    drinkMinutes?: number;
    gatherMinutes?: number;
    socialMinutes?: number;
    restMinutes?: number;
};

/** Food item priority when eating/gathering (berries first — abundant). */
const FOOD_PRIORITY = ['berry', 'fish', 'coconut'];

/** Trade goods a neighbour might hold — checked in this order. */
const MATERIALS = ['shell', 'stone', 'wood', 'vine', 'flint'];

/** Priority ladder constants */
const THIRST_TRIGGER = 65;
const HUNGER_TRIGGER = 60;
const REST_TRIGGER = 22;
const HUNGER_SYMPATHY = 50;
const DRINK_RELIEF = 35;
const REST_RECOVERY = 12;

/** Chebyshev distance — the grid step metric for "nearby" (plane only). */
const chebyshev = (a: Position3D, b: Position3D): number => planeDistance(a, b);

export const behaviorPlugin = (options: BehaviorPluginOptions): WorldPlugin<World> => {
    const { inventory, needs, relationship, tasks } = options;
    const travel = options.travelMinutesPerTile ?? 1;
    const eatMinutes = options.eatMinutes ?? 2;
    const drinkMinutes = options.drinkMinutes ?? 2;
    const gatherMinutes = options.gatherMinutes ?? 10;
    const socialMinutes = options.socialMinutes ?? 10;
    const restMinutes = options.restMinutes ?? 10;
    // Sixty 1-minute steps at the Scale-0 pace — the cooldown is measured in
    // WORLD MINUTES so the social rhythm never moves with the view scale
    const socialCooldown = options.socialCooldownMinutes ?? 60;

    // Last social attempt per actor id, stamped in elapsed world minutes
    const lastSocial = new Map<string, number>();

    // The plugin context captured at setup — the behaviour plans and the task
    // effects read the world through it (TaskSubject only carries the actor)
    let context: PluginContext<World> | null = null;

    // ── helpers ─────────────────────────────────────────────────────────────

    /** First held food item id (FOOD_PRIORITY order), or null. */
    const firstFood = (bag: Record<string, number>): string | null => {
        const held = arrayEach(FOOD_PRIORITY, ({ value: item }) =>
            (bag[item] ?? 0) > 0 ? item : undefined,
        );
        return held ?? null;
    };

    /**
     * Nearest cell (from `candidates`) by Chebyshev distance.
     * Ties resolve to the earliest candidate — deterministic.
     */
    const nearest = (actor: Actor, candidates: TerrainCell[]): TerrainCell | null => {
        let best: TerrainCell | null = null;
        let bestDistance = Infinity;
        arrayEach(candidates, ({ value: cell }) => {
            // Cells are plane footprints — compare at ground level (z = 0)
            const distance = chebyshev(actor.position, position3(cell.x, cell.y));
            if (distance < bestDistance) {
                best = cell;
                bestDistance = distance;
            }
        });
        return best;
    };

    /** Direction word for a step delta — used in move log lines. */
    const directionWord = (dx: number, dy: number): string => {
        const vertical = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
        const horizontal = dx > 0 ? 'east' : dx < 0 ? 'west' : '';
        if (!vertical) {
            return horizontal || 'nowhere';
        }
        return horizontal ? `${vertical}${horizontal}` : vertical;
    };

    // ── Scale-0 movement — the fine walk through the sub-grids ───────────────
    // Every move task walks the actor ONE SUBTILE CELL (the tile's interior
    // grid). A step inside the parent tile is always free ground; a step off
    // an edge wraps into the NEIGHBOR tile (the subTile continuity rule) and
    // must land on dry, unoccupied ground. Occupancy is per SCALE-0 tile: no
    // two grounded actors stand on the same subtile cell.

    /**
     * Whether another GROUNDED entity stands at (sx, sy) inside the tile at
     * (tileX, tileY) — the Scale-0 occupancy rule: no two entities stand on
     * the same subtile cell. The scan reads the whole coordinate space (the
     * single position registry), so registry actors AND coordinates-only
     * creatures (birds on the ground, released fauna) block alike; flyers
     * (z > ground) never block — they are above the Scale-0 ground.
     */
    const fineSpotTaken = (
        active: World,
        selfId: string,
        tileX: number,
        tileY: number,
        sx: number,
        sy: number,
    ): boolean => {
        let taken = false;
        active.coordinates.all().forEach((other) => {
            if (
                other.id !== selfId &&
                other.position.x === tileX &&
                other.position.y === tileY &&
                other.position.z === GROUND_LEVEL
            ) {
                const otherSub = active.subOf(other.id);
                if (otherSub && otherSub.x === sx && otherSub.y === sy) {
                    taken = true;
                }
            }
        });
        return taken;
    };

    /**
     * Whether the actor could fine-step (dx, dy) right now — a PURE read
     * used by both the planner and the completion effect (re-validation).
     * Resolves the actor's fine spot, runs the subTileStep wrap, and
     * validates the landing: interior steps need only a free fine spot;
     * wraps additionally need the crossed tile(s) dry. Returns the crossed
     * parent delta (the tile-crossing signal for the energy charge), or
     * undefined when the step is impossible.
     */
    const fineStep = (
        actor: Actor,
        dx: number,
        dy: number,
    ): { parent: { dx: number; dy: number } } | undefined => {
        const active = context?.world;
        if (!active) {
            return undefined;
        }
        const canvas = active.canvas;
        if (canvas.width === 0 || canvas.height === 0) {
            return undefined;
        }
        const sub = active.subOf(actor.id);
        if (!sub) {
            return undefined;
        }
        // The continuity rule: the step wraps at the sub-grid edges and
        // reports the parent tile(s) it crossed
        const step = subTileStep(canvas.width, canvas.height, sub.x, sub.y, dx, dy);
        if (step.parent.dx !== 0 || step.parent.dy !== 0) {
            // The wrap crossed into neighbor tile(s) — they must be dry
            const crossed = active.cellAt(
                actor.position.x + step.parent.dx,
                actor.position.y + step.parent.dy,
            );
            if (!crossed || !crossed.passable) {
                return undefined;
            }
        }
        // The landing fine spot must be free of grounded actors (the tile
        // the step lands in: the current one, or the wrapped neighbor)
        const landingX = actor.position.x + step.parent.dx;
        const landingY = actor.position.y + step.parent.dy;
        if (fineSpotTaken(active, actor.id, landingX, landingY, step.x, step.y)) {
            return undefined;
        }
        return { parent: step.parent };
    };

    /**
     * One greedy fine step from the actor toward the target TILE (tx, ty):
     * preferred steps dx→0 then dy→0, diagonal fallback, then any valid fine
     * direction — chosen deterministically against the CURRENT occupancy.
     * Null when the actor cannot fine-step at all.
     */
    const greedyFineStep = (actor: Actor, tx: number, ty: number): [number, number] | null => {
        const dx = Math.sign(tx - actor.position.x);
        const dy = Math.sign(ty - actor.position.y);

        // Preferred step directions, most direct first
        const preferred: Array<[number, number]> = [];
        if (dx !== 0) {
            preferred.push([dx, 0]);
        }
        if (dy !== 0) {
            preferred.push([0, dy]);
        }
        if (dx !== 0 && dy !== 0) {
            preferred.push([dx, dy]);
        }

        let step: [number, number] | null = null;
        arrayEach(preferred, ({ value: candidate }) => {
            if (!step && fineStep(actor, candidate[0], candidate[1])) {
                step = candidate;
            }
        });
        // Blocked toward the target — try any valid fine direction as
        // fallback (the actor mills toward the tile edge facing the target)
        if (!step) {
            arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                if (!step && fineStep(actor, offset.dx, offset.dy)) {
                    step = [offset.dx, offset.dy];
                }
            });
        }
        return step;
    };

    /** Travel spec toward a target tile: one fine step, `travel` minutes. */
    const travelSpec = (actor: Actor, label: string, target: TerrainCell): TaskSpec | undefined => {
        const step = greedyFineStep(actor, target.x, target.y);
        if (!step) {
            return undefined;
        }
        return {
            kind: 'move',
            label,
            minutes: travel,
            payload: { dx: step[0], dy: step[1] },
        };
    };

    /**
     * The social opportunity an actor has RIGHT NOW — a PURE read (no side
     * effects): the fed actor's hungry neighbour within Chebyshev 2 and the
     * interaction shape (a material trade, or a gift). The behaviour's gate
     * reads this, so the gate itself never mutates inventory or relationships;
     * the PLAN applies the opportunity exactly once.
     */
    const socialOpportunity = (
        actor: Actor,
    ): { target: Actor; itemId: string; material: string | null } | undefined => {
        const active = context?.world;
        if (!active) {
            return undefined;
        }
        // The cooldown runs on world minutes, not tick counts — a zoomed
        // view changes the step size, never the social rhythm
        const now = active.ticker.elapsed();
        const last = lastSocial.get(actor.id) ?? -Infinity;
        if (now - last < socialCooldown) {
            return undefined;
        }

        const bag = inventory.of(actor.id);
        const food = firstFood(bag);
        if (!food || (bag[food] ?? 0) < 1) {
            return undefined;
        }

        // Hungry neighbours, nearest first
        const neighbours: Actor[] = [];
        active.actors.forEach((other) => {
            if (other.id !== actor.id && chebyshev(actor.position, other.position) <= 2) {
                neighbours.push(other);
            }
        });
        const hungry = neighbours
            .filter((other) => needs.of(other.id).hunger >= HUNGER_SYMPATHY)
            .sort(
                (left, right) =>
                    chebyshev(actor.position, left.position) - chebyshev(actor.position, right.position),
            );
        const target = hungry[0];
        if (!target) {
            return undefined;
        }

        // The first material the neighbour holds (exchange shape), or null
        // when only a gift could happen
        const targetBag = inventory.of(target.id);
        const material = arrayEach(MATERIALS, ({ value: candidate }) =>
            (targetBag[candidate] ?? 0) > 0 ? candidate : undefined,
        );
        return material ? { target, itemId: food, material } : { target, itemId: food, material: null };
    };

    /**
     * Applies a social opportunity AT PLAN TIME — the exchange/gift and the
     * relationship bump land NOW (inventory atomicity is verified now, not
     * `socialMinutes` later), the queued task only times the encounter.
     * Returns the spec, or undefined when the application failed (the actor
     * re-plans next minute and no cooldown is stamped).
     */
    const applySocial = (
        actor: Actor,
        opportunity: { target: Actor; itemId: string; material: string | null },
    ): TaskSpec | undefined => {
        const bag = inventory.of(actor.id);
        let itemId: string | null = null;
        let traded = false;
        if (opportunity.material) {
            // Exchange: 1 food for the first material the neighbour holds
            if (inventory.exchange(actor, opportunity.target, { [opportunity.itemId]: 1 }, { [opportunity.material]: 1 })) {
                itemId = opportunity.itemId;
                traded = true;
                relationship.adjust(actor.id, opportunity.target.id, 6, 'trading');
            }
        }
        if (!itemId) {
            // No materials to trade — gift when well stocked and not hostile
            const totalFood = FOOD_PRIORITY.reduce((sum, item) => sum + (bag[item] ?? 0), 0);
            if (
                totalFood >= 3 &&
                relationship.relation(actor.id, opportunity.target.id) >= 0 &&
                inventory.give(actor, opportunity.target, opportunity.itemId, 1)
            ) {
                itemId = opportunity.itemId;
                relationship.adjust(actor.id, opportunity.target.id, 10, 'gifting');
            }
        }
        // Only an actual interaction costs the task + stamps the cooldown —
        // a declined offer leaves the actor free to plan something else
        if (!itemId) {
            return undefined;
        }
        const active = context?.world;
        if (active) {
            lastSocial.set(actor.id, active.ticker.elapsed());
        }
        return {
            kind: 'social',
            label: traded ? 'trades' : 'gives',
            minutes: socialMinutes,
            payload: { targetId: opportunity.target.id, itemId },
        };
    };

    // ── the plugin ──────────────────────────────────────────────────────────

    return {
        id: 'behavior',
        label: 'Agent Behavior',

        setup: (pluginContext: PluginContext<World>) => {
            // Every behaviour plan and the completion listener read the world
            // through the captured context
            context = pluginContext;
            const world = pluginContext.world;
            const actorOf = (taskActorId: string): Actor | undefined =>
                world.actors.get(taskActorId);

            // ── the priority ladder as task behaviours ─────────────────────

            // Thirst 50 — drink from the cell's pool, or travel toward one
            tasks.behaviour({
                id: 'thirst',
                label: 'Thirst',
                priority: 50,
                appliesTo: (subject) => needs.of(subject.actor.id).thirst >= THIRST_TRIGGER,
                plan: (subject) => {
                    const actor = subject.actor;
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    if ((stock.water ?? 0) > 0) {
                        // The drink itself is the task — 2 quick minutes
                        return { kind: 'drink', label: 'drinks', minutes: drinkMinutes };
                    }
                    const pool = nearest(actor, inventory.cellsWithItem('water'));
                    if (!pool) {
                        return undefined;
                    }
                    return travelSpec(actor, 'travels to water', pool);
                },
            });

            // Hunger 40 — eat from the bag, gather the cell, or travel toward
            // the nearest food stock
            tasks.behaviour({
                id: 'hunger',
                label: 'Hunger',
                priority: 40,
                appliesTo: (subject) => needs.of(subject.actor.id).hunger >= HUNGER_TRIGGER,
                plan: (subject) => {
                    const actor = subject.actor;
                    const food = firstFood(inventory.of(actor.id));
                    if (food) {
                        return {
                            kind: 'eat',
                            label: 'eats',
                            minutes: eatMinutes,
                            // The item id is captured now — the effect only
                            // eats what was planned (see the eat effect)
                            payload: { itemId: food },
                        };
                    }
                    // The current cell's stock: any FOOD-kind item is gatherable
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    const gatherable = Object.keys(stock).find(
                        (item) => (stock[item] ?? 0) > 0 && itemDef(item).kind === 'food',
                    );
                    if (gatherable !== undefined) {
                        return { kind: 'gather', label: 'gathers', minutes: gatherMinutes };
                    }
                    // Walk toward the nearest food-bearing cell
                    const targets = FOOD_PRIORITY.flatMap((item) => inventory.cellsWithItem(item));
                    const target = nearest(actor, targets);
                    if (!target) {
                        return undefined;
                    }
                    const step = greedyFineStep(actor, target.x, target.y);
                    if (!step) {
                        return undefined;
                    }
                    return {
                        kind: 'move',
                        label: 'travels to food',
                        minutes: travel,
                        payload: { dx: step[0], dy: step[1] },
                    };
                },
            });

            // Rest 25 — the instant-rest fallback. Shadowed by the sleep
            // plugin's priority-30 'sleep' behaviour when it is mounted
            // (plugins/sleep/sleepPlugin.ts); removing sleep re-opens this
            // ladder rung
            tasks.behaviour({
                id: 'rest',
                label: 'Rest',
                priority: 25,
                appliesTo: (subject) => needs.of(subject.actor.id).energy <= REST_TRIGGER,
                plan: () => ({ kind: 'rest', label: 'rests', minutes: restMinutes }),
            });

            // Social 20 — the encounter applies at plan time; the task only
            // times it. The gate is the PURE opportunity read — applying
            // happens exactly once, in the plan
            tasks.behaviour({
                id: 'social',
                label: 'Social',
                priority: 20,
                appliesTo: (subject) => socialOpportunity(subject.actor) !== undefined,
                plan: (subject) => {
                    const opportunity = socialOpportunity(subject.actor);
                    if (!opportunity) {
                        return undefined;
                    }
                    return applySocial(subject.actor, opportunity);
                },
            });

            // Wander 0 — the idle filler
            tasks.behaviour({
                id: 'wander',
                label: 'Wander',
                priority: 0,
                plan: (subject) => {
                    // Idle actors fine-wander: one random valid fine step per
                    // task (inside the tile, or wrapping into a neighbor tile)
                    const open: Array<[number, number]> = [];
                    arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                        if (fineStep(subject.actor, offset.dx, offset.dy)) {
                            open.push([offset.dx, offset.dy]);
                        }
                    });
                    if (open.length === 0) {
                        // No fine step free — the actor stays idle this round
                        return undefined;
                    }
                    const [dx, dy] = open[Math.floor(pluginContext.random() * open.length)];
                    return {
                        kind: 'move',
                        label: 'wanders',
                        minutes: travel,
                        payload: { dx, dy, wander: true },
                    };
                },
            });

            // ── the task effects: what each completed kind DOES ────────────
            tasks.ledger.onComplete((task) => {
                // Despawned mid-task — nothing to apply
                const actor = actorOf(task.actorId);
                if (!actor) {
                    return;
                }
                switch (task.kind) {
                    case 'move': {
                        const dx = Number(task.payload?.dx ?? 0);
                        const dy = Number(task.payload?.dy ?? 0);
                        // Re-validate at completion: the world may have
                        // shifted under a mid-travel actor (occupancy moved,
                        // terrain regenerated). A blocked move logs nothing —
                        // the actor re-plans next minute
                        const step = fineStep(actor, dx, dy);
                        if (!step) {
                            return;
                        }
                        // The Scale-0 move: one fine step through the tile's
                        // sub-grid (a wrap flows across the tile boundary —
                        // world.relocateFine). Castaways never fly — the Z
                        // stays on the ground plane.
                        world.relocateFine(actor.id, dx, dy);
                        // The energy charge lands on a TILE CROSSING — the
                        // coarse walk's economics preserved at the fine
                        // granularity (milling inside a tile is free)
                        if (step.parent.dx !== 0 || step.parent.dy !== 0) {
                            needs.moved(actor.id);
                        }
                        const wandering = task.payload?.wander === true;
                        world.events.emit({
                            kind: 'move',
                            actorId: actor.id,
                            message: wandering
                                ? `${actor.name} wanders ${directionWord(dx, dy)}.`
                                : `${actor.name} walks ${directionWord(dx, dy)}.`,
                        });
                        return;
                    }
                    case 'drink': {
                        // The pool may have run dry during the 2 quick
                        // minutes — re-take, or the drink silently failed
                        if (!inventory.takeFromCell(actor, 'water')) {
                            return;
                        }
                        inventory.consume(actor, 'water');
                        needs.satisfy(actor.id, { thirst: -DRINK_RELIEF });
                        return;
                    }
                    case 'eat': {
                        // Only the planned item is eaten — and only while the
                        // bag still holds it (a mid-task trade may have moved it)
                        const itemId = task.payload?.itemId;
                        if (typeof itemId !== 'string') {
                            return;
                        }
                        if (!inventory.consume(actor, itemId)) {
                            return;
                        }
                        const def = itemDef(itemId);
                        needs.satisfy(actor.id, {
                            hunger: -(def.nutrition ?? 0),
                            thirst: -(def.hydration ?? 0),
                        });
                        return;
                    }
                    case 'gather': {
                        // The inventory re-validates the stock and emits its
                        // own gather event; a depleted cell is a no-op
                        inventory.gather(actor);
                        return;
                    }
                    case 'rest': {
                        // The instant-rest recovery, once per completed rest —
                        // the sleep plugin restores its own tasks per-minute
                        // instead (sleepPlugin tick), never through here
                        needs.satisfy(actor.id, { energy: REST_RECOVERY });
                        world.events.emit({
                            kind: 'rest',
                            actorId: actor.id,
                            message: `${actor.name} rests for a while.`,
                        });
                        return;
                    }
                    case 'social': {
                        // Applied at plan time (applySocial) — nothing here
                        return;
                    }
                    default:
                        // Unknown kinds (other plugins' tasks) apply themselves
                        return;
                }
            });
        },

        dispose: () => {
            // Drop only THIS plugin's behaviours — other plugins' modules
            // (e.g. the sleep plugin's) must survive in the ledger. Dropping
            // each also cancels its queued tasks (the ledger's update rule)
            tasks.dropBehaviour('thirst');
            tasks.dropBehaviour('hunger');
            tasks.dropBehaviour('rest');
            tasks.dropBehaviour('social');
            tasks.dropBehaviour('wander');
            lastSocial.clear();
            context = null;
        },

        tick: () => {
            const active = context?.world;
            if (!active) {
                return;
            }
            // Spawn-order snapshot; actors despawned mid-tick are skipped.
            // Idle actors only — a busy actor keeps working its queue head
            const actorIds = Array.from(active.actors.keys());
            arrayEach(actorIds, ({ value: actorId }) => {
                const actor = active.actors.get(actorId);
                if (!actor) {
                    return;
                }
                if (!tasks.busy(actorId)) {
                    tasks.ledger.plan(actor);
                }
            });
        },
    };
};
