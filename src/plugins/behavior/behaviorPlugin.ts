// The behavior environment plugin — the agent decision loop, TASK-DRIVEN,
// for EVERY LIVING THING.
//
// The plugin REGISTERS behaviour modules into the task ledger
// (plugins/tasks/taskLedger.ts) and applies the task EFFECTS on completion.
// The rhythm: tasks cost WORLD MINUTES — moving ONE SCALE-0 TILE costs
// `travelMinutesPerTile` (ONE — the distribution's distance rule: one
// Scale-0 tile move per tick, scenario/island.ts) — so an actor that plans
// a move stays busy for one minute and the effect lands on the completing
// minute. Behaviours add/remove update task lists per the ledger rules:
// registering one changes future planning only; dropping one cancels its
// queued tasks and the actors go idle again.
//
// EVERY LIVING ENTITY IS PLANNED EVERY MINUTE (this tick plans busy actors
// too — the ledger pre-empts a busy queue only when a STRICTLY
// higher-priority behaviour queues). The registry castaways plan through
// their full Actor records; the COORDINATE-SPACE CREATURES (perched
// seabirds, roaming boars — anything grounded on DRY land) plan through
// their coordinate identity, so the survival rungs are the whole world's:
// a hungry bird looks for food, a tired bird roosts, a boar drinks, and a
// castaway runs the full castaway ladder. Flyers (z > ground) keep their
// plugin-owned flight (the birds plugin drives every airborne minute), and
// water creatures (sharks — impassable cells) keep their own swim scripts:
// the ledger plans only what walks the ground. See taskLedger.ts TaskEntity
// for the shared planning shape.
//
// Tasks are governed by behaviour plugins, and the
// ladder is re-read per tick: an actor travelling to water (thirst) drops
// everything the moment a wild animal closes in (the survival plugin's
// priority-60 flee), a sleeping actor wakes hungry (hunger 40 > sleep 30),
// a wandering actor pivots to eating. Not every task completes — an
// interrupted task is abandoned mid-progress, and the actor acts on
// whichever task ranks highest THIS tick.
//
// The registered ladder (priority DESC; the ledger plans the first module
// whose gate passes and whose plan yields specs — higher-priority modules
// mounted by other plugins, e.g. the sleep and survival plugins, rank
// above these):
//   thirst  50 — thirst ≥ 65: drink from the BAG (2 min); no water carried
//                                    → collect the cell's pool into the bag
//                                    (3 min); no pool underfoot → travel one
//                                    fine step toward the nearest pool (1 min)
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
// NOTHING RECOVERS STRAIGHT FROM THE GROUND — the "go and find it" rule.
// Water and food are world resources the actor must physically reach and
// put INTO ITS INVENTORY first (collect → bag; gather → bag); the needs
// only recover when an inventory item is CONSUMED (drink/eat). The rain no
// longer floods every tile (the inventory plugin scatters pools), so the
// thirst ladder genuinely has to travel.
//
// Movement runs at SCALE 0 — the simulation ground: every move task walks
// the actor ONE SUBTILE CELL inside its tile's sub-grid
// (world.relocateFine). A step that stays inside the parent tile is free
// ground; a step off a tile edge WRAPS into the neighbor tile (the
// @godspace/core subTile continuity rule) and must find dry, unoccupied
// ground there. The energy charge lands on a TILE CROSSING — milling
// around inside a tile is free, walking into the next tile costs the move
// (the coarse walk's economics, preserved at the fine granularity). The
// fine-step machinery lives in plugins/movement/fineMovement.ts, shared
// with the survival and lumber behaviour plugins.
//
// Task EFFECTS (registered as a ledger completion listener, applied when a
// task reaches 0 remaining):
//   move    — re-validates the fine step (bounds, the wrap's tiles passable,
//             the destination fine spot unoccupied) then fine-relocates,
//             charges the move energy on a tile crossing — the movement KIND
//             picks the burn row: a plain walk charges the profile's walk
//             row, a flee charges the RUN row (threefold; the entity profiles
//             derive both from the species' attributes) — and logs. A blocked
//             move logs NOTHING — the actor re-plans next minute. Every
//             'move' task flows through here, including the survival
//             plugin's flee tasks and the lumber plugin's treks.
//   collect — takes the planned item from the cell (re-validated) INTO THE
//             BAG. The water now sits in the inventory; the drink consumes
//             it from there on a later task.
//   drink   — consumes water FROM THE BAG (re-validated) and relieves
//             thirst. No bag water → the drink silently failed.
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
    type PluginContext,
    type WorldPlugin,
} from '@godspace/core';
import { itemDef } from '../inventory/items';
import {
    chebyshev,
    fineStep,
    nearestCell,
    travelSpec,
} from '../movement/fineMovement';
import type { World } from '../../engine/world';
import type { Actor } from '../../engine/types';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { RelationshipPlugin } from '../relationship/relationshipPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { TaskSpec, TaskEntity, TaskSubject } from '../tasks/taskLedger';
import type { EntityProfiles } from '../entity/entityPlugin';

export type BehaviorPluginOptions = {
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    relationship: RelationshipPlugin;
    tasks: TasksPlugin;
    /**
     * The entity profiles (plugins/entity/entityPlugin.ts) — the movement
     * energy a tile crossing burns comes from the entity's species profile
     * (attributes-derived), selected by the movement kind: a plain walk
     * burns the walk row, a flee burns the RUN row (threefold). Absent: the
     * needs plugin's legacy flat point applies (profiles-less runs).
     */
    profiles?: EntityProfiles;
    /** World minutes to move ONE SCALE-0 tile (one subtile cell). Default 1 —
     * the distribution's distance rule: one tile move per tick
     * (scenario/island.ts pins it). */
    travelMinutesPerTile?: number;
    /** World-minutes between social attempts per actor. Default 60. */
    socialCooldownMinutes?: number;
    /** Minutes busy for the quick actions. Defaults: eat/drink 2,
     * collect 3, gather 10, social 10, rest 10. */
    eatMinutes?: number;
    drinkMinutes?: number;
    collectMinutes?: number;
    gatherMinutes?: number;
    socialMinutes?: number;
    restMinutes?: number;
};

/** Food item priority when eating/gathering (berries first — abundant).
 * The island's full edible vocabulary: meadow/forest berries, forest
 * mushrooms, the sea's fish and seaweed, the beaches' coconuts. */
const FOOD_PRIORITY = ['berry', 'mushroom', 'fish', 'coconut', 'seaweed'];

/** Trade goods a neighbour might hold — checked in this order. */
const MATERIALS = ['shell', 'stone', 'wood', 'vine', 'flint'];

/** Priority ladder constants */
const THIRST_TRIGGER = 65;
const HUNGER_TRIGGER = 60;
const REST_TRIGGER = 22;
const HUNGER_SYMPATHY = 50;
const DRINK_RELIEF = 35;
const REST_RECOVERY = 12;

export const behaviorPlugin = (options: BehaviorPluginOptions): WorldPlugin<World> => {
    const { inventory, needs, relationship, tasks } = options;
    // The entity profiles — movement energy economics (run vs walk). Null:
    // the needs plugin's legacy flat point.
    const profiles = options.profiles ?? null;
    const travel = options.travelMinutesPerTile ?? 1;
    const eatMinutes = options.eatMinutes ?? 2;
    const drinkMinutes = options.drinkMinutes ?? 2;
    const collectMinutes = options.collectMinutes ?? 3;
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

    /** The world while set up — every plan/effect guard reads through this. */
    const worldOf = (): World | null => context?.world ?? null;

    /**
     * The social opportunity an actor has RIGHT NOW — a PURE read (no side
     * effects): the fed actor's hungry neighbour within Chebyshev 2 and the
     * interaction shape (a material trade, or a gift). The behaviour's gate
     * reads this, so the gate itself never mutates inventory or relationships;
     * the PLAN applies the opportunity exactly once. Social life stays a
     * castaway affair: the neighbour scan reads the ACTOR REGISTRY, so a
     * creature planned through the ladder finds no neighbours and declines.
     */
    const socialOpportunity = (
        actor: TaskEntity,
    ): { target: Actor; itemId: string; material: string | null } | undefined => {
        const active = worldOf();
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
        actor: TaskEntity,
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
        const active = worldOf();
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
            /**
             * Resolves the LIVING BODY behind a task id at completion time —
             * a registry castaway OR a coordinate-space creature (the task
             * queues key by entity id either way). A despawned/despawned
             * mid-task body resolves to undefined: the effect is dropped.
             */
            const actorOf = (taskActorId: string): TaskEntity | undefined => {
                const registered = world.actors.get(taskActorId);
                if (registered) {
                    return registered;
                }
                const entry = world.coordinates.entryOf(taskActorId);
                if (!entry) {
                    return undefined;
                }
                // The creature's planning identity — the same fields the
                // ledger plans through (taskLedger.ts TaskEntity)
                return {
                    id: entry.id,
                    name: entry.name ?? entry.id,
                    position: entry.position,
                    kind: entry.kind,
                    type: entry.type,
                    marker: entry.marker,
                };
            };

            // ── the priority ladder as task behaviours ─────────────────────

            // Thirst 50 — the collect-then-drink ladder: the relief only
            // comes from water CONSUMED OUT OF THE BAG, and water only
            // enters the bag by standing at a pool and collecting it
            tasks.behaviour({
                id: 'thirst',
                label: 'Thirst',
                priority: 50,
                appliesTo: (subject) => needs.of(subject.actor.id).thirst >= THIRST_TRIGGER,
                plan: (subject) => {
                    const actor = subject.actor;
                    // 1) Water in the bag — the drink is the task (the
                    //    relief lands on completion, from the inventory)
                    if ((inventory.of(actor.id).water ?? 0) > 0) {
                        return { kind: 'drink', label: 'drinks', minutes: drinkMinutes };
                    }
                    // 2) A pool underfoot — the COLLECTION is the task: the
                    //    water goes into the bag first (nothing recovers
                    //    straight from the ground)
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    if ((stock.water ?? 0) > 0) {
                        return {
                            kind: 'collect',
                            label: 'collects water',
                            minutes: collectMinutes,
                            payload: { itemId: 'water' },
                        };
                    }
                    // 3) Go and find a pool — travel one fine step toward
                    //    the nearest stocked cell
                    const pool = nearestCell(actor, inventory.cellsWithItem('water'));
                    if (!pool) {
                        return undefined;
                    }
                    return travelSpec(world, actor, 'travels to water', pool, travel);
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
                    const target = nearestCell(actor, targets);
                    if (!target) {
                        return undefined;
                    }
                    return travelSpec(world, actor, 'travels to food', target, travel);
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
                    // FLYERS keep their own flight script: the ledger's idle
                    // filler would pin a gull to the ground forever (a task
                    // queued every minute means the birds plugin's busy gate
                    // never re-opens, so no takeoff roll ever fires again).
                    // A perched bird with no pressing need stays unplanned —
                    // its perch belongs to the birds plugin (takeoff/hop
                    // rolls, the roost recovery). Species with the fly
                    // ability are exempt; grounded walkers (people, boars)
                    // fine-wander as always. No profiles → no ability
                    // system → every body wanders (the pre-entity behavior).
                    if (
                        profiles &&
                        subject.actor.kind === 'creature' &&
                        subject.actor.type !== undefined &&
                        profiles.hasAbility(subject.actor.type, 'fly')
                    ) {
                        return undefined;
                    }
                    // Idle bodies fine-wander: one random valid fine step per
                    // task (inside the tile, or wrapping into a neighbor tile)
                    const open: Array<[number, number]> = [];
                    arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
                        if (fineStep(world, subject.actor, offset.dx, offset.dy)) {
                            open.push([offset.dx, offset.dy]);
                        }
                    });
                    if (open.length === 0) {
                        // No fine step free — the body stays idle this round
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
                        const step = fineStep(world, actor, dx, dy);
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
                        // granularity (milling inside a tile is free). The
                        // movement KIND picks the profile's burn row: a plain
                        // walk charges the walk row, a flee charges the RUN
                        // row (running burns threefold — panic is expensive).
                        if (step.parent.dx !== 0 || step.parent.dy !== 0) {
                            needs.moved(actor.id, task.payload?.flee ? 'run' : 'walk');
                        }
                        // NO log line — the log is a story teller (a
                        // castaway's fine walk east or west is simulation
                        // plumbing, not story). The event bus stays for
                        // interactions and world-scale happenings.
                        return;
                    }
                    case 'collect': {
                        // The planned pool item — the pool may have run dry
                        // during the wait, or a neighbour may have drunk it:
                        // re-take, or the collection silently failed (the
                        // actor re-plans next minute)
                        const itemId = task.payload?.itemId;
                        inventory.takeFromCell(actor, typeof itemId === 'string' ? itemId : 'water');
                        return;
                    }
                    case 'drink': {
                        // The water must be IN THE BAG now (a mid-task
                        // trade or gift may have moved it): the relief comes
                        // from the consumed inventory item, never straight
                        // from the ground. No bag water → silent failure.
                        if (!inventory.consume(actor, 'water')) {
                            return;
                        }
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
                        // instead (sleepPlugin tick), never through here.
                        // No log line — resting is a solo beat, not a story.
                        needs.satisfy(actor.id, { energy: REST_RECOVERY });
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
            // Spawn-order snapshot; bodies despawned mid-tick are skipped.
            // EVERY LIVING THING is planned each minute — busy bodies
            // included: the ledger pre-empts a busy queue only when a
            // STRICTLY higher-priority behaviour queues (the per-tick
            // prioritization: survival outranks thirst, thirst outranks
            // hunger, …; equal priorities never churn a queue).
            //
            // The registry castaways first (their full Actor records), then
            // the coordinate-space creatures: GROUNDED (z ≤ the ground
            // plane — flyers keep their plugin-owned flight) and standing
            // on DRY ground (water creatures — the sharks — keep their own
            // swim scripts; a task ladder that walks tiles is not their
            // vocabulary). Each creature plans through its coordinate
            // identity (taskLedger.ts TaskEntity).
            const planned = new Set<string>(active.actors.keys());
            active.actors.forEach((actor) => {
                tasks.ledger.plan(actor);
            });
            active.coordinates.all().forEach((entry) => {
                if (planned.has(entry.id)) {
                    return;
                }
                if (entry.position.z > GROUND_LEVEL) {
                    return;
                }
                const cell = active.cellAt(entry.position.x, entry.position.y);
                if (!cell || !cell.passable) {
                    return;
                }
                planned.add(entry.id);
                tasks.ledger.plan({
                    id: entry.id,
                    name: entry.name ?? entry.id,
                    position: entry.position,
                    kind: entry.kind,
                    type: entry.type,
                    marker: entry.marker,
                });
            });
        },
    };
};
