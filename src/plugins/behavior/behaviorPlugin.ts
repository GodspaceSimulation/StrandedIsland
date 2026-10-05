// The behavior environment plugin — the agent decision loop.
//
// Every tick each actor (in spawn order) evaluates its situation and picks
// ONE action. Priority ladder, highest first:
//   1. Thirst ≥ 65       → drink from the cell's rainwater pool, or walk
//                          toward the nearest pool
//   2. Hunger ≥ 60       → eat food from the bag, else gather from the cell,
//                          else walk toward the nearest food stock
//   3. Energy ≤ 22       → rest (recover energy)
//   4. Social            → a fed actor helps a hungry neighbour: first tries
//                          an exchange (1 food ↔ 1 material), falls back to a
//                          gift; either strengthens their relationship
//   5. Wander            → random passable step
//
// Castaways cannot fly or dig: every move goes through world.relocate with a
// `grounded()` position (Z clamped to the ground plane — see @godspace/core),
// and neighbour sensing uses planeDistance (the X/Y grid metric, ignoring Z).
//
// Depends on the inventory, needs and relationship plugin APIs (passed as
// options — see scenario/island.ts for the assembly).

import { arrayEach } from '@presource/core';
import { planeDistance, grounded, position3, type Position3D } from '@godspace/core';
import { itemDef } from '../inventory/items';
import { inventoryEntries } from '../inventory/inventory';
import { NEIGHBOR_OFFSETS } from '../../engine/world';
import type { Actor, TerrainCell } from '../../engine/types';
import type { PluginContext, WorldPlugin } from '../../engine/plugin';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { RelationshipPlugin } from '../relationship/relationshipPlugin';

export type BehaviorPluginOptions = {
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    relationship: RelationshipPlugin;
    /** World-minutes between social attempts per actor. Default 60. */
    socialCooldownMinutes?: number;
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

export const behaviorPlugin = (options: BehaviorPluginOptions): WorldPlugin => {
    const { inventory, needs, relationship } = options;
    // Six 10-minute steps at the scale-0 pace — the cooldown is measured in
    // WORLD MINUTES so the social rhythm never moves with the view scale
    const socialCooldown = options.socialCooldownMinutes ?? 60;

    // Last social attempt per actor id, stamped in elapsed world minutes
    const lastSocial = new Map<string, number>();

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

    /** One greedy step toward (tx, ty); falls back to any free passable step. */
    const stepToward = (context: PluginContext, actor: Actor, tx: number, ty: number) => {
        const { world } = context;
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

        const free = (x: number, y: number): boolean => {
            const cell = world.cellAt(x, y);
            // Ground-level occupancy only — flyers above a cell never block it
            return !!cell && cell.passable && !world.actorAt(x, y);
        };

        let moved: [number, number] | null = null;
        arrayEach(preferred, ({ value: step }) => {
            if (!moved && free(actor.position.x + step[0], actor.position.y + step[1])) {
                moved = step;
            }
        });
        // Blocked — try any passable unoccupied neighbour as fallback
        if (!moved) {
            arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                if (!moved && free(actor.position.x + offset.dx, actor.position.y + offset.dy)) {
                    moved = [offset.dx, offset.dy];
                }
            });
        }
        if (!moved) {
            return false;
        }
        const [mdx, mdy] = moved as [number, number];
        // Castaways cannot fly or dig — the move lands on the ground plane
        world.relocate(actor.id, grounded(position3(actor.position.x + mdx, actor.position.y + mdy)));
        needs.moved(actor.id);
        world.events.emit({
            kind: 'move',
            actorId: actor.id,
            message: `${actor.name} moves ${directionWord(mdx, mdy)}.`,
        });
        return true;
    };

    /** Wander: one random free step. */
    const wander = (context: PluginContext, actor: Actor) => {
        const { world } = context;
        const free: Array<[number, number]> = [];
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            const x = actor.position.x + offset.dx;
            const y = actor.position.y + offset.dy;
            const cell = world.cellAt(x, y);
            if (cell && cell.passable && !world.actorAt(x, y)) {
                free.push([offset.dx, offset.dy]);
            }
        });
        if (free.length === 0) {
            return;
        }
        const [dx, dy] = free[Math.floor(context.random() * free.length)];
        // Grounded relocate — Z stays 0 for everyone who cannot fly
        world.relocate(actor.id, grounded(position3(actor.position.x + dx, actor.position.y + dy)));
        needs.moved(actor.id);
        world.events.emit({
            kind: 'move',
            actorId: actor.id,
            message: `${actor.name} wanders ${directionWord(dx, dy)}.`,
        });
    };

    /** Social priority: help a hungry neighbour within distance 2. */
    const trySocial = (context: PluginContext, actor: Actor): boolean => {
        const { world } = context;
        // The cooldown runs on world minutes, not tick counts — a zoomed
        // view changes the step size, never the social rhythm
        const now = world.ticker.elapsed();
        const last = lastSocial.get(actor.id) ?? -Infinity;
        if (now - last < socialCooldown) {
            return false;
        }

        const bag = inventory.of(actor.id);
        const food = firstFood(bag);
        if (!food || (bag[food] ?? 0) < 1) {
            return false;
        }

        // Hungry neighbours, nearest first
        const neighbours: Actor[] = [];
        world.actors.forEach((other) => {
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
            return false;
        }

        lastSocial.set(actor.id, now);
        const targetBag = inventory.of(target.id);
        // Try an exchange first: 1 food for the first material they hold
        const material = arrayEach(MATERIALS, ({ value: candidate }) =>
            (targetBag[candidate] ?? 0) > 0 ? candidate : undefined,
        );
        if (material && inventory.exchange(actor, target, { [food]: 1 }, { [material]: 1 })) {
            relationship.adjust(actor.id, target.id, 6, 'trading');
            return true;
        }
        // No materials to trade — gift when well stocked and not hostile
        const totalFood = FOOD_PRIORITY.reduce((sum, item) => sum + (bag[item] ?? 0), 0);
        if (
            totalFood >= 3 &&
            relationship.relation(actor.id, target.id) >= 0 &&
            inventory.give(actor, target, food, 1)
        ) {
            relationship.adjust(actor.id, target.id, 10, 'gifting');
            return true;
        }
        return false;
    };

    // ── the plugin ──────────────────────────────────────────────────────────

    return {
        id: 'behavior',
        label: 'Agent Behavior',

        dispose: () => {
            lastSocial.clear();
        },

        tick: (context: PluginContext) => {
            const { world } = context;

            // Spawn-order iteration; actors despawned mid-tick are skipped
            const actorIds = Array.from(world.actors.keys());
            arrayEach(actorIds, ({ value: actorId }) => {
                const actor = world.actors.get(actorId);
                if (!actor) {
                    return;
                }
                const state = needs.of(actorId);
                const bag = inventory.of(actor.id);

                // 1 — thirst: drink from the cell's rainwater pool
                if (state.thirst >= THIRST_TRIGGER) {
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    if ((stock.water ?? 0) > 0 && inventory.takeFromCell(actor, 'water')) {
                        inventory.consume(actor, 'water');
                        needs.satisfy(actor.id, { thirst: -DRINK_RELIEF });
                        return;
                    }
                    const pool = nearest(actor, inventory.cellsWithItem('water'));
                    if (pool) {
                        stepToward(context, actor, pool.x, pool.y);
                    }
                    return;
                }

                // 2 — hunger: eat, gather, or walk toward food
                if (state.hunger >= HUNGER_TRIGGER) {
                    const food = firstFood(bag);
                    if (food) {
                        const def = itemDef(food);
                        if (inventory.consume(actor, food)) {
                            needs.satisfy(actor.id, {
                                hunger: -(def.nutrition ?? 0),
                                thirst: -(def.hydration ?? 0),
                            });
                        }
                        return;
                    }
                    if (inventory.gather(actor) !== null) {
                        return;
                    }
                    // Walk toward the nearest food-bearing cell
                    const targets = FOOD_PRIORITY.flatMap((item) => inventory.cellsWithItem(item));
                    const target = nearest(actor, targets);
                    if (target) {
                        stepToward(context, actor, target.x, target.y);
                    }
                    return;
                }

                // 3 — rest when exhausted
                if (state.energy <= REST_TRIGGER) {
                    needs.satisfy(actor.id, { energy: REST_RECOVERY });
                    world.events.emit({
                        kind: 'rest',
                        actorId: actor.id,
                        message: `${actor.name} rests for a while.`,
                    });
                    return;
                }

                // 4 — social: trade or gift to a hungry neighbour
                if (trySocial(context, actor)) {
                    return;
                }

                // 5 — wander
                wander(context, actor);
            });
        },
    };
};
