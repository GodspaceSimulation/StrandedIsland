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
// seabirds, roaming boars, sharks in the sea — anything grounded at z 0)
// plan through their coordinate identity, so the survival rungs are the
// whole world's: a hungry bird looks for food, a tired bird roosts in the
// trees, a boar drinks, and a castaway runs the full castaway ladder. The
// REALM decides which rungs serve a body: the travel rungs (and the idle
// wander) need dry ground underfoot — the water realm's non-travel rungs
// still apply (a floater gathers the fish underfoot, a spent swimmer
// rests) — while flyers (z > ground) keep their plugin-owned flight (the
// birds plugin drives every airborne minute). See taskLedger.ts TaskEntity
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
//                                    cell's food (10 min), fish the water at
//                                    the body's feet when standing on a dry
//                                    fishing shore (3 min — R5: cardinal-
//                                    adjacent water stocking fish, the body
//                                    never enters it), or travel toward the
//                                    nearest food stock or fishing shore
//                                    (1 min)
//   roost   33 — a FLY-ABILITY creature (a seabird) with energy ≤ 22 not
//                                    standing on a treed tile travels one
//                                    strict fine step toward the nearest
//                                    treed tile — the bird's SAFE SLEEP:
//                                    roosting off the ground, in the trees.
//                                    Trees beyond the ROOST_RANGE trek are
//                                    out of reach for an exhausted gull: it
//                                    sleeps where it stands. On a treed
//                                    tile the gate declines and the sleep
//                                    plugin's timed slumber (30) takes
//                                    over — the bird sleeps IN the trees.
//                                    No profiles → no ability system →
//                                    no roost (the pre-entity behavior).
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
//   fish    — R5 — takes the planned fish from the adjacent water cell into
//             the bag (the inventory's fish primitive re-validates the dry
//             ground, the cardinal shore reach, the stock and the capacity).
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
    position3,
    type PluginContext,
    type WorldPlugin,
} from '@godspace/core';
import { itemDef } from '../inventory/items';
import { inventoryTotal } from '../inventory/inventory';
import {
    chebyshev,
    fineStep,
    nearestCell,
    strictFineStep,
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
const ROOST_TRIGGER = 22;
const REST_TRIGGER = 22;
const HUNGER_SYMPATHY = 50;
const DRINK_RELIEF = 35;
const REST_RECOVERY = 12;
/**
 * THE DESPERATION LINE — a need at or past this value is a body at the edge
 * of the starvation doom (the needs plugin's critical line): past it the
 * full-hand decline of the thirst/hunger rungs must release its cargo.
 */
const DESPERATION_LINE = 90;

/**
 * THE ABANDON ORDER — the deterministic descent the hungry/thirsty
 * full-hand release walks when it drops a bag unit: the LEAST essential
 * goods first. Inert ground goods and the knapping flint (the axe is
 * already crafted by the time a hand clogs) head the list, then the
 * construction parts (thatch/cloth/rope/plank — surplus once the site's
 * lines are staged), then the raw materials, and only last the tools
 * (the axe's halved chop and the hammer's work are lost when they go).
 * Food-and-water ids are ABSENT — a body never drops its own relief (a
 * foodless hand reaches this descent with nothing edible to lose).
 */
const ABANDON_ORDER = [
    'shell',
    'flint',
    'sand',
    'dirt',
    'grass',
    'thatch',
    'cloth',
    'rope',
    'plank',
    'frond',
    'vine',
    'wood',
    'stone',
    'iron',
    'axe',
    'hammer',
];

/**
 * THE ROOST RANGE (Chebyshev tiles) — how far a tired bird will trek for a
 * roost. Beyond it the woods are out of reach for an exhausted gull: it
 * sleeps where it stands (the sleep rung takes the minute) instead of
 * crawling the coastline forever — the strict roost step declines on any
 * blocked coast, so an unbounded trek would mill a spent bird along the
 * shore for dozens of minutes. Six tiles is a couple of minutes' hop: the
 * woods are usually within reach of the island's interior.
 */
const ROOST_RANGE = 6;

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

    /**
     * THE FULL-HAND SURVIVAL RELEASE — abandons ONE unit of the body's cargo
     * (least essential first, ABANDON_ORDER) so a food/water unit can enter
     * the hand. The thirst/hunger rungs decline a full hand by design (the
     * construction DELIVER/CRAFT rungs below are meant to free the bag), but
     * that premise is unsound when the hand holds SURPLUS the crew no longer
     * owes — over-fetched planks and thatch a finished site line never takes
     * again, a starter flint the axe craft spent its use on. No rung can
     * stage or convert surplus that the site no longer lacks, so the bag
     * stays clogged, the needs rungs decline forever, and the body starves
     * with food underfoot (the long-march seed-7 stall: Ael @7,3 — a forest
     * cell stocking mushroom×2 AND water×2 — died at minute 3197 on a
     * full-handed bag of {flint, axe, thatch, plank×2, vine, frond×2} while
     * the boat lacked only its last rope). At the DESPERATION LINE a
     * starvation outranks cargo: the unit is dropped (consume — the bag
     * write — removes exactly one) and the rung falls through to its
     * collect/gather below. Applied AT PLAN TIME like the social rung's
     * exchange (the plan is the minute that owns the decision; the queued
     * gather/collect costs the minutes). A hand holding only essentials (or
     * nothing the order lists) declines: there is nothing expendable, and
     * the normal ladder re-plans next minute.
     */
    const abandonOneUnit = (actor: TaskEntity): string | null => {
        const bag = inventory.of(actor.id);
        const item = arrayEach(ABANDON_ORDER, ({ value: candidate }) =>
            (bag[candidate] ?? 0) > 0 ? candidate : undefined,
        );
        if (item === undefined) {
            return null;
        }
        return inventory.consume(actor, item) ? item : null;
    };

    /** The world while set up — every plan/effect guard reads through this. */
    const worldOf = (): World | null => context?.world ?? null;

    /**
     * THE WATER REALM — whether a body's ground-travel vocabulary applies. A
     * body standing on an impassable cell (the sea a shark swims, the water a
     * gull floats on) cannot fine-step ACROSS tiles (the wrap needs dry
     * land), so the travel rungs decline for it — a task ladder that walks
     * tiles is not the water realm's vocabulary. Without the guard a thirsty
     * floater would mill inside its water tile forever (a busy body every
     * minute, the birds plugin's busy gate never re-opening — pinned afloat
     * to die of thirst). The non-travel rungs still serve the water realm: a
     * floater gathers the fish underfoot (every water cell stocks them) and
     * eats from the beak-bag, a spent swimmer rests — and the sleep rung lets
     * a tired bird doze afloat while its drift carries it toward the shore.
     */
    const onDryGround = (actor: TaskEntity): boolean => {
        const cell = worldOf()?.cellAt(actor.position.x, actor.position.y);
        return cell !== undefined && cell.passable;
    };

    /**
     * R5 — THE FISHING SHORE read: the water cell CARDINAL-adjacent to the
     * actor's DRY tile that currently stocks fish, or undefined. The shore
     * rule in one look — dry ground underfoot, water at the body's feet
     * (cardinal only: no diagonals, no distance, no fishing from afloat),
     * fish in its live stock. Deterministic: the fixed cardinal ladder. The
     * inventory's fish primitive re-validates everything at completion.
     */
    const adjacentFishWater = (
        active: World,
        actor: TaskEntity,
    ): { x: number; y: number } | undefined => {
        const here = active.cellAt(actor.position.x, actor.position.y);
        if (!here || !here.passable) {
            return undefined;
        }
        const reach = [
            { dx: 1, dy: 0 },
            { dx: -1, dy: 0 },
            { dx: 0, dy: 1 },
            { dx: 0, dy: -1 },
        ];
        const spot = reach.find(({ dx, dy }) => {
            const neighbor = active.cellAt(actor.position.x + dx, actor.position.y + dy);
            return neighbor !== undefined && !neighbor.passable &&
                (inventory.cellStock(neighbor.x, neighbor.y).fish ?? 0) > 0;
        });
        if (!spot) {
            return undefined;
        }
        return { x: actor.position.x + spot.dx, y: actor.position.y + spot.dy };
    };

    /**
     * The social opportunity an actor has RIGHT NOW — a PURE read (no side
     * effects): the actor's hungry neighbour within Chebyshev 2 and the
     * interaction shape (a material trade, or a gift). The behaviour's gate
     * reads this, so the gate itself never mutates inventory or relationships;
     * the PLAN applies the opportunity exactly once. The NEIGHBOUR scan reads
     * the ACTOR REGISTRY (the castaways), so an encounter needs a hungry
     * castaway within range — a creature planned through the ladder that
     * carries food (a foraging gull's berry, a hunting shark's fish) meets
     * that neighbour the same way a castaway does.
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
                    const bag = inventory.of(actor.id);
                    // 1) Water in the bag — the drink is the task (the
                    //    relief lands on completion, from the inventory);
                    //    drinking CONSUMES, so it works even on a full hand.
                    if ((bag.water ?? 0) > 0) {
                        return { kind: 'drink', label: 'drinks', minutes: drinkMinutes };
                    }
                    // 2) A FULL hand with no water — every relief below (the
                    //    collect, the gather, the trek to water) REFUSES a
                    //    unit that has no room in the bag, so the task
                    //    re-plants every minute and the body stalls re
                    //    -planning (the long-march water stall: two actors
                    //    stood at (3,5) with a full material bag, thirst
                    //    50 pre-empted the 24-priority DELIVER that would
                    //    free the bag). Decline: the construction's DELIVER
                    //    rung is lower in the ladder, so a `undefined`
                    //    here falls through to it, hoarding the material
                    //    to a site and freeing a slot so water / food can
                    //    enter the hand next minute. EXCEPT the DELIVER /
                    //    CRAFT rungs only free a hand that holds UNITS THE
                    //    SITE STILL OWES — a hand full of SURPLUS (a
                    //    material a finished site line no longer takes) no
                    //    rung can stage or convert, so it stays clogged
                    //    and the body starves with a pool underfoot (the
                    //    seed-7 6000-minute stall: Ael @7,3, water×2 and
                    //    mushroom×2 underfoot, dead of thirst at minute
                    //    3197 on a full-handed surplus crew). Past the
                    //    DESPERATION LINE the survival outranks the cargo:
                    //    abandon ONE expendable unit (abandonOneUnit) and
                    //    FALL THROUGH to the collect / trek below — the
                    //    pool underfoot is reachable again.
                    if (inventoryTotal(bag) >= inventory.capacityOf(actor.id)) {
                        const desperate = needs.of(actor.id).thirst >= DESPERATION_LINE;
                        if (
                            !desperate ||
                            abandonOneUnit(actor) === null ||
                            inventoryTotal(bag) >= inventory.capacityOf(actor.id)
                        ) {
                            return undefined;
                        }
                        // The hand holds room now — the collect / trek below
                        // take it
                    }
                    // 3) A pool underfoot — the COLLECTION is the task: the
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
                    // 4) Go and find a pool — travel one fine step toward
                    //    the nearest stocked cell. R4 — the pool targets are
                    //    the PASSABLE water carriers (rain pools + the dry
                    //    shore ring beside the basins): the impassable lake
                    //    cells stock water nobody can stand in to collect,
                    //    and the shore ring beside them stocks it too, so
                    //    the trek never aims at water behind a wall. WATER
                    //    REALM: a body on an impassable cell has no ground
                    //    travel (its wrap needs dry land) — decline and let
                    //    the realm's own script (the birds plugin's drift,
                    //    the sharks plugin's swim) carry it.
                    const pool = nearestCell(
                        actor,
                        inventory.cellsWithItem('water').filter((cell) => cell.passable),
                    );
                    if (!pool || !onDryGround(actor)) {
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
                    const bag = inventory.of(actor.id);
                    const food = firstFood(bag);
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
                    // A FULL hand with no food — every hunger relief below
                    // (the gather, the trek) REFUSES a unit that has no room
                    // in the bag (the gather is a no-op on a full hand), so
                    // the task re-plants every minute and the body stalls
                    // re-planning. Decline: the construction's DELIVER rung is
                    // lower in the ladder, so a `undefined` here falls through
                    // to it, hauling the hoarded material to a site and freeing
                    // a slot so a berry / fruit can enter the hand next minute.
                    // (Drinking/eating CONSUME, so step 1 already handled a
                    // food that IS in the bag; only a full material hand reaches
                    // here.) EXCEPT a hand full of SURPLUS no site line owes
                    // (the thirst rung's note — Ael @7,3, minute 3197) no
                    // construction rung can free: past the DESPERATION LINE
                    // abandon ONE expendable unit and FALL THROUGH to the
                    // underfoot forage / trek below — the bush the body
                    // stands on feeds it again.
                    if (inventoryTotal(bag) >= inventory.capacityOf(actor.id)) {
                        const desperate = needs.of(subject.actor.id).hunger >= DESPERATION_LINE;
                        if (
                            !desperate ||
                            abandonOneUnit(actor) === null ||
                            inventoryTotal(bag) >= inventory.capacityOf(actor.id)
                        ) {
                            return undefined;
                        }
                        // The hand holds room now — the gather / trek below
                        // take it
                    }
                    // The current cell's stock: any FOOD-kind item is gatherable,
                    // AND a berry bush is — a bush stands as a MATERIAL but it
                    // BEARS berries (the gather effect plucks a berry off it,
                    // inventoryPlugin's bush path), so a hungry body underfoot a
                    // bush may forage it even with no loose food beside it.
                    // Without this the hunger rung's underfoot check (FOOD-kind
                    // only) misses the bush and the body mills / travels away
                    // from the very plant that feeds it (the local stall the
                    // long march exposed).
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    const gatherable = Object.keys(stock).find(
                        (item) => (stock[item] ?? 0) > 0 && (itemDef(item).kind === 'food' || item === 'bush'),
                    );
                    if (gatherable !== undefined) {
                        return { kind: 'gather', label: 'gathers', minutes: gatherMinutes };
                    }
                    // R5 — THE FISHING SHORE: dry ground underfoot and fish
                    // in the water AT THE BODY'S FEET (a cardinal-adjacent
                    // water cell stocking fish) → fish. The take lands in
                    // the bag through the inventory's fish primitive (dry
                    // ground, cardinal reach, live stock and capacity all
                    // re-validated at completion). Ranks BELOW the underfoot
                    // forage (a berry forages faster than a fish lands) and
                    // ABOVE the trek (the water here already feeds — no use
                    // walking away from the shoal at hand). The body never
                    // enters the water: the shore is the fishery.
                    const shoal = adjacentFishWater(world, actor);
                    if (shoal) {
                        return {
                            kind: 'fish',
                            label: 'fishes',
                            minutes: collectMinutes,
                            payload: { x: shoal.x, y: shoal.y },
                        };
                    }
                    // Walk toward the nearest REACHABLE food-bearing cell. The
                    // targets are the loose food items PLUS the berry bushes
                    // (a bush is a food source at a distance too), filtered to
                    // PASSABLE cells: a land body can never stand in the open
                    // sea, so the water's foods (fish, seaweed) are not travel
                    // targets ON the water itself — a hungry beachgoer must
                    // trek to a land food (a meadow bush, a forest berry) or
                    // to a FISHING SHORE (below), never mill at the waterline
                    // aiming at the fish it cannot stand on.
                    // The filter is LOCAL to the hunger rung: the thirst rung
                    // legitimately targets the water cells (drinking pools sit in
                    // the wetlands/sea), so the shared nearestCell stays
                    // passability-blind and only hunger prunes the unreachable.
                    const targets = [...FOOD_PRIORITY, 'bush']
                        .flatMap((item) => inventory.cellsWithItem(item))
                        .filter((cell) => cell.passable);
                    // R5 — the FISHING SHORES join the food targets at a
                    // distance: every DRY tile whose cardinal water stocks
                    // fish is a food source the body can work (the trek ends
                    // on the shore, then the fishing rung above takes the
                    // minute). Deterministic: cellsWithItem's insertion order
                    // (the row-major survey) × the fixed cardinal ladder.
                    inventory.cellsWithItem('fish').forEach((water) => {
                        [
                            { x: water.x + 1, y: water.y },
                            { x: water.x - 1, y: water.y },
                            { x: water.x, y: water.y + 1 },
                            { x: water.x, y: water.y - 1 },
                        ].forEach((spot) => {
                            const dry = world.cellAt(spot.x, spot.y);
                            if (dry && dry.passable) {
                                targets.push(dry);
                            }
                        });
                    });
                    const target = nearestCell(actor, targets);
                    if (!target || !onDryGround(actor)) {
                        return undefined;
                    }
                    return travelSpec(world, actor, 'travels to food', target, travel);
                },
            });

            // Roost 33 — THE BIRD'S SAFE SLEEP. A fly-ability creature at
            // the tired line (the same ≤ 22 the sleep rung reads) that is
            // NOT standing on a treed tile travels toward the nearest trees
            // first: roosting off the ground, in the woods, is the safe
            // place to sleep the gull's instincts ask for. On a treed tile
            // the gate declines — the sleep plugin's priority-30 timed
            // slumber takes the minute and the bird sleeps IN the trees
            // (the sleep task kind carries the sleep plugin's per-minute
            // restore whatever behaviour queued it). Priority above sleep
            // so the roost routes the tired bird BEFORE the slumber fires;
            // strictly below hunger (40) so a hungry tired bird eats first.
            // No profiles → no ability system → no roost (the pre-entity
            // behavior, the wander filler's exemption rule mirrored).
            tasks.behaviour({
                id: 'roost',
                label: 'Roost',
                priority: 33,
                appliesTo: (subject) => {
                    const actor = subject.actor;
                    if (!profiles || actor.kind !== 'creature') {
                        return false;
                    }
                    if (actor.type === undefined || !profiles.hasAbility(actor.type, 'fly')) {
                        return false;
                    }
                    if (needs.of(actor.id).energy > ROOST_TRIGGER) {
                        return false;
                    }
                    // Standing among trees already — the roost is HERE;
                    // decline and let the sleep rung take the minute
                    const cell = worldOf()?.cellAt(actor.position.x, actor.position.y);
                    return (cell?.resources.tree ?? 0) === 0;
                },
                plan: (subject) => {
                    const active = worldOf();
                    const actor = subject.actor;
                    if (!active) {
                        return undefined;
                    }
                    // WATER REALM: a floating tired bird has no ground
                    // travel — it dozes afloat (the sleep rung takes over)
                    // while its perch drift carries it toward the shore
                    if (!onDryGround(actor)) {
                        return undefined;
                    }
                    const grove = nearestCell(actor, inventory.cellsWithItem('tree'));
                    if (!grove) {
                        // No trees on the island at all — sleep where it stands
                        return undefined;
                    }
                    // THE ROOST RANGE — trees beyond a tired gull's trek are
                    // out of reach: sleep where it stands (the sleep rung
                    // takes the minute) rather than crawl the coast forever
                    if (chebyshev(actor.position, position3(grove.x, grove.y)) > ROOST_RANGE) {
                        return undefined;
                    }
                    // One STRICT fine step toward the grove — the mill
                    // fallback of the greedy walker would pin a blocked or
                    // water-locked body busy forever (its realm's movement
                    // plugin never re-opens). A blocked roost walker
                    // declines instead: idle this minute, its own hops may
                    // unstick it, and the next minute re-plans.
                    const step = strictFineStep(active, actor, grove.x, grove.y);
                    if (!step) {
                        return undefined;
                    }
                    return {
                        kind: 'move',
                        label: 'seeks a roost',
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
                    // WATER REALM — the idle filler walks the GROUND: a body
                    // standing on an impassable cell (a shark in the sea, a
                    // gull afloat) keeps its realm's own idle minute (the
                    // swim script's sweep, the perch's drift). Queuing fine
                    // moves for it would pin it busy every minute — the
                    // birds plugin's takeoff gate would never re-open.
                    if (!onDryGround(subject.actor)) {
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
                        // A MATERIAL fetch — a gather task that names its
                        // item takes THAT item off the cell (the
                        // construction rungs' fetch tasks ride the core's
                        // gather factory, which queues kind 'gather' with a
                        // payload item; see plugins/construction). The take
                        // revalidates stock, capacity and the mine gate;
                        // a depleted cell is a no-op.
                        const itemId = task.payload?.item;
                        if (typeof itemId === 'string' && itemDef(itemId).kind !== 'food') {
                            inventory.takeFromCell(actor, itemId);
                            return;
                        }
                        // The stockless FOOD gather (the hunger rung's tasks
                        // carry no payload): the inventory re-validates the
                        // stock and emits its own gather event; a depleted
                        // cell is a no-op
                        inventory.gather(actor);
                        return;
                    }
                    case 'fish': {
                        // R5 — the planned water cell (the fishing shore):
                        // the inventory primitive re-validates everything at
                        // completion — dry ground underfoot, the cardinal
                        // reach, the live shoal, the bag's room. A failed
                        // cast is a no-op; the actor re-plans next minute.
                        const x = task.payload?.x;
                        const y = task.payload?.y;
                        if (typeof x === 'number' && typeof y === 'number') {
                            inventory.fish(actor, x, y);
                        }
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
            tasks.dropBehaviour('roost');
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
            // plane — flyers keep their plugin-owned flight). The WATER
            // realm plans too (a shark in the sea, a gull afloat): the
            // travel rungs decline for impassable underfoot (onDryGround —
            // a task ladder that walks tiles is not their vocabulary) while
            // the non-travel rungs serve them (a floater gathers the fish
            // underfoot, a spent swimmer rests, a tired gull dozes afloat),
            // and the wander filler leaves their idle minute to the realm's
            // own script. Each creature plans through its coordinate
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
                if (!active.cellAt(entry.position.x, entry.position.y)) {
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
