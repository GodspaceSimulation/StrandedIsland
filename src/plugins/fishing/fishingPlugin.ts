// The FISHING environment plugin (T4) — the constructed FISHING NET and the
// FISHING-TOOL crafting, mounted beside the behavior ladder.
//
// WHAT THIS PLUGIN OWNS — per-tile net state (the island's fish weirs), the
// autonomous net-build/collect conduct, and the spear/rod crafting rung that
// keeps the shore fishery reachable for hungry hands. It edits NOTHING
// outside this folder: no TerrainCell field, no inventory registry. The
// catch stock lives in DEDICATED NET/SITE STATE (keyed "x,y" here) — never
// as ambient fish-ground glyphs (R2: no wild-fish indicators anywhere) and
// never as a drawn-down source (the water is UNLIMITED — see
// plugins/inventory inventoryPlugin.fish).
//
// THE FISHING CONTRACT (T4, scenario request):
//   UNLIMITED SOURCE — the river/sea water hands fish out forever: the
//   active shore cast (a spear or a rod in the bag, the inventory's fish
//   primitive) never depletes anything, and a body AFLOAT feeds itself
//   naturally (plugins/behavior's water-realm path — the sharks' and the
//   afloat birds' feeding, no tool required for them). What is finite is
//   the STORAGE: a net banks its catch up to NET_CATCH_CAP fish and holds
//   them until hauled.
//   THE NET — a real constructible structure: it stands on DRY land that
//   touches FISHING WATER (the same biome predicates the shore cast runs —
//   the sea or a fresh basin, passable river fords included), refuses
//   walled/built footprints and standing farm plots, and is paid for in
//   honest materials (NET_MATERIALS: wood 2 + vine 2, consumed from the
//   finishing builder's bag on the atomic claim) through REAL shared work
//   (NET_BUILD_WORK tile-work minutes in the tasks plugin's ledger — the
//   gatherWork convention every other fetch/forage rides).
//   TIMED ACCRUAL — growth is LAZY and timestamp-based (the farming
//   plugin's matureAt idiom, plugins/farming): a net banks one fish every
//   NET_CATCH_MINUTES world minutes up to the cap, derived from
//   `world.ticker.elapsed()` at every read — the plugin has NO tick, a
//   zoomed/fast-stepped world fills nets exactly right with zero catch-up
//   work. Collection advances the net's clock by exactly the fish taken
//   (the fraction toward the next catch is preserved), so a partially
//   hauled net never loses banked time.
//   THE TOOLS — the spear (wood 1 + flint 1) and the rod (wood 1 + vine 1)
//   are crafted as REAL bag transforms through this plugin's crafting
//   registry (the same @godspace/material crafting registry the
//   construction plugin builds on, a private instance here so no
//   cross-plugin ordering hazard): the hungry-hand bridge rung opens the
//   craft ONLY for a bag that already holds the full input set (fetching is
//   the ordinary materials economy's job), and the craft applies atomically
//   at completion — a spent stock loses nothing. Wear rides the
//   plugins/inventory toolDurability ledger on every SUCCESSFUL catch
//   (charged by the inventory's fish primitive itself).
//
// ── THE LADDER (taskLedger behaviour modules; the behavior plugin's sweep
//    plans every living thing, so fishing rides it and must mount beside it) ──
//
//   fishing-bridge 41 — THE HUNGRY-HAND BRIDGE (the farming plugin's
//              farm-harvest rung pattern, priority 41 — one above hunger):
//              a hungry sentient with NO food in the bag (a) hauls the catch
//              of a RIPE net underfoot or one step away, or (b) crafts its
//              spear/rod when the bag already holds the inputs. Thirst (50)
//              and the flee (60) still outrank it. Creatures never fish this
//              way — they feed naturally afloat (the behavior plugin's
//              water-realm path).
//   fishing    11 — THE STANDING STEWARDSHIP RUNG: a ripe net underfoot is
//              hauled (any hunger level), an eligible shore with the
//              materials in hand is rigged into a new net (island-capped),
//              and a ripe net at a distance draws the keeper to it. Sits
//              above lumber (10) and wander (0), below the build rungs
//              (21–24) — nets are what the idle minute is FOR.
//
// The net tasks ride the behavior plugin's ledger and the shared tile-work
// beats (openGatherJob/beatGatherJob — plugins/tasks/gatherWork.ts), so the
// Tile Inspector's Work bars read net-build/net-collect progress with zero
// extra wiring. Reads for the inspector/tests: nets(), netAt(x, y),
// eligibleAt(x, y), collect(x, y, agent), reset(), pacing().
//
// Dispose drops both behaviour modules (the ledger cancels their queued
// tasks), unsubscribes the completion listener and clears the nets — a
// swapped-out environment never leaks into its replacement. The standing
// tile JOBS belong to the tasks environment (its dispose clears them).
// REGENERATION RESET — wherever a caller re-surveys the canvas, ALSO call
// reset(): nets are keyed to old-map tile addresses and must not survive a
// regenerated island.

import {
    createCraftingRegistry,
    type CraftingRegistry,
    type Recipe,
} from '@godspace/material';
import { position3, type WorldPlugin } from '@godspace/core';
import { itemDef, itemWeight, inventoryWeight, materials } from '../inventory/items';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { InventoryAgent } from '../inventory/inventoryPlugin';
import { inventoryAdd, inventoryRemove } from '../inventory/inventory';
import { ITEM_WEIGHTS } from '../inventory/items';
import { beatGatherJob, openGatherJob } from '../tasks/gatherWork';
import { chebyshev, strictFineStep, travelSpec } from '../movement/fineMovement';
import { isFreshBasin, isSeaWater } from '../../engine/types';
import type { World } from '../../engine/world';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { EntityProfiles } from '../entity/entityPlugin';
import type { TaskEntity, TaskSpec, TaskSubject } from '../tasks/taskLedger';

// ── Public vocabulary (integration + tests + UI import these, never strings) ─

/** The behaviour module ids this plugin registers into the task ledger. */
export const FISHING_BEHAVIOUR_ID = 'fishing';
export const FISHING_BRIDGE_ID = 'fishing-bridge';

/** The task kinds this plugin queues and applies itself (the behavior
 * plugin's effect switch ignores unknown kinds — see its default branch). */
export const FISH_TOOL_TASK = 'fishTool';
export const FISH_NET_BUILD_TASK = 'netBuild';
export const FISH_NET_COLLECT_TASK = 'netCollect';

/** The tile-work job kinds (gatherWorkKey's `item` slot → "tile:x,y:net-*").
 * Distinct from any resource item so net labor and wild forage on one tile
 * are independent, UI-visible jobs. */
export const NET_BUILD_WORK = 'net-build';
export const NET_COLLECT_WORK = 'net-collect';

/** The ladder slots: 11 sits above lumber (10) and wander (0), below every
 * need/sleep/build rung; 41 sits one above hunger (40) — see the header. */
export const FISHING_PRIORITY = 11;
export const FISHING_BRIDGE_PRIORITY = 41;

/** THE FISHING-TOOL RECIPES — conservative, one level deep, off the island's
 * existing materials (no new tech tree): a flint-tipped spear and a stick
 * with a vine line. Both are 'tool' recipes on this plugin's crafting
 * registry; the durability ledger (plugins/inventory/toolDurability) wears
 * the outputs on every successful catch. */
export const FISH_TOOL_RECIPES: readonly Recipe[] = [
    {
        id: 'spear',
        label: 'Spear',
        kind: 'tool',
        inputs: [{ item: 'wood', count: 1 }, { item: 'flint', count: 1 }],
        outputs: [{ item: 'spear', count: 1 }],
        minutes: 5,
    },
    {
        id: 'rod',
        label: 'Fishing Rod',
        kind: 'tool',
        inputs: [{ item: 'wood', count: 1 }, { item: 'vine', count: 1 }],
        outputs: [{ item: 'rod', count: 1 }],
        minutes: 5,
    },
];

/** THE NET MATERIALS — what one completed build job consumes from the
 * finishing builder's bag: two logs for the frame, two vines for the mesh
 * (52 weight — a person carries it alongside tools; no rope dependency, so
 * the net needs no processed chain). */
export const NET_MATERIALS: ReadonlyArray<{ item: string; count: number }> = [
    { item: 'wood', count: 2 },
    { item: 'vine', count: 2 },
];

/** Whether a number is a usable pacing value (finite and strictly positive —
 * the farming plugin's validation rule: a broken override never collapses a
 * rhythm to a 1-minute pulse). */
const finitePositive = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0;

export type FishingPluginOptions = {
    tasks: TasksPlugin;
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    /**
     * The entity profiles — the work gates (the species' 'craft' ability
     * builds nets and tools, the 'forage' ability hauls them). Absent:
     * every sentient hand may fish-work (the pre-entity behavior, the
     * lumber/construction fallbacks).
     */
    profiles?: EntityProfiles;
    /** World minutes to move ONE SCALE-0 tile. Default 1 (the distribution's
     * distance rule, scenario/island.ts). */
    travelMinutesPerTile?: number;
    /** WORK-minutes one net-build job demands. Default 20. */
    netBuildWork?: number;
    /** WORK-minutes one net-collect (haul) job demands. Default 5. */
    netCollectWork?: number;
    /** World minutes ONE caught fish takes to bank into a standing net.
     * Default 240 (4 island hours — a night's fishing fills the weir). */
    netCatchMinutes?: number;
    /** Stored-catch ceiling per net — the source is inexhaustible, the
     * STORAGE is not. Default 3 fish. */
    netCatchCap?: number;
    /** Island-wide net cap (bounded density). Default 4. */
    maxNets?: number;
    /** The hunger pressure the 41 bridge rung answers. Default 60 — the
     * EXACT mirror of the behavior plugin's private HUNGER_TRIGGER
     * (plugins/behavior/behaviorPlugin.ts); keep the two in step. */
    hungerTrigger?: number;
};

/** One net's inspection card — the Tile Inspector / decor read (a copy;
 * mutating it never reaches the simulation). */
export type FishingNetView = {
    x: number;
    y: number;
    /** Fish banked in the net right now (0 = the weir is empty). */
    stored: number;
    /** The storage ceiling (NET_CATCH_CAP). */
    cap: number;
    /** Minutes until the NEXT fish banks (0 when the net stands full). */
    minutesToNext: number;
    /** Absolute world minute the net was rigged (stable for its life). */
    builtAt: number;
};

export type FishingPlugin = WorldPlugin<World> & {
    /** The net at (x, y) as of the current world minute, or undefined. */
    netAt(x: number, y: number): FishingNetView | undefined;
    /** Every standing net, insertion order (deterministic), as of now. */
    nets(): FishingNetView[];
    /** Whether a net MAY stand at (x, y) right now (pure read — dry shore
     * ground touching fishing water, unstructured, un-plotted, unnetted,
     * under the cap). */
    eligibleAt(x: number, y: number): boolean;
    /**
     * Hauls UP TO the net's stored catch into the agent's bag
     * (capacity-gated, pays exactly what fits) and advances the net's
     * accrual clock by exactly the fish taken. Returns the fish hauled
     * (0 when the net is empty or the bag is full). The netCollect beat's
     * payout closure calls this; the god/tests may call it directly.
     */
    collect(x: number, y: number, agent: InventoryAgent): number;
    /** THE REGENERATION RESET — wipe every net (old-map tile addresses). */
    reset(): void;
    /** The resolved pacing — god-side and test reads. */
    pacing(): {
        netBuildWork: number;
        netCollectWork: number;
        netCatchMinutes: number;
        netCatchCap: number;
        maxNets: number;
    };
};

/**
 * Creates the fishing plugin. The options carry the pacing overrides (the
 * scenario threads them through IslandOptions like the forest's); every
 * invalid value falls back to its documented default.
 */
export const createFishingPlugin = (options: FishingPluginOptions): FishingPlugin => {
    const { tasks, inventory, needs } = options;
    // The entity profiles — the work gates. Null: every sentient hand works.
    const profiles = options.profiles ?? null;

    // ── resolved pacing (the farming plugin's validation discipline) ────────
    const netBuildWork = finitePositive(options.netBuildWork) ? Math.floor(options.netBuildWork) : 20;
    const netCollectWork = finitePositive(options.netCollectWork) ? Math.floor(options.netCollectWork) : 5;
    const netCatchMinutes = finitePositive(options.netCatchMinutes) ? Math.floor(options.netCatchMinutes) : 240;
    const netCatchCap = finitePositive(options.netCatchCap) ? Math.max(1, Math.floor(options.netCatchCap)) : 3;
    const maxNets = finitePositive(options.maxNets) ? Math.max(1, Math.floor(options.maxNets)) : 4;
    const travel = finitePositive(options.travelMinutesPerTile) ? Math.floor(options.travelMinutesPerTile) : 1;
    const hungerTrigger = finitePositive(options.hungerTrigger) ? options.hungerTrigger : 60;

    // The plugin's crafting registry — the spear/rod recipes, validated
    // against the island's shared item catalog (materials). A private
    // instance: no cross-plugin define/collision ordering hazard, and the
    // recipes stay available even beside a construction-less world.
    const crafting: CraftingRegistry = createCraftingRegistry({ stock: false, items: materials });
    FISH_TOOL_RECIPES.forEach((recipe) => {
        crafting.define({
            id: recipe.id,
            label: recipe.label,
            kind: recipe.kind,
            inputs: recipe.inputs.map((line) => ({ ...line })),
            outputs: recipe.outputs.map((line) => ({ ...line })),
            minutes: recipe.minutes,
        });
    });

    // The nets — the plugin's OWN per-tile state (no TerrainCell edit).
    // Insertion order is the deterministic tiebreak for nearest-net reads.
    type Net = { x: number; y: number; builtAt: number; lastCollectAt: number };
    const nets = new Map<string, Net>();
    const keyOf = (x: number, y: number): string => `${x},${y}`;

    // The world arrives with setup — accrual reads the ticker's ABSOLUTE
    // elapsed minutes, so net state stays coherent across plugin remounts
    // (the farming plugin's monotonic-clock reasoning).
    let world: World | null = null;
    // The completion-listener unsubscribe, torn down at dispose
    let unsubscribeComplete: (() => void) | null = null;

    /** The world clock in absolute world minutes (0 before setup). */
    const now = (): number => world?.ticker.elapsed() ?? 0;

    /** The lazy catch-up read — how many fish ONE net has banked. */
    const storedOf = (net: Net): number =>
        Math.min(netCatchCap, Math.floor((now() - net.lastCollectAt) / netCatchMinutes));

    /** The net's clock-derived view (minutesToNext clamps at a full net). */
    const viewOf = (net: Net): FishingNetView => {
        const stored = storedOf(net);
        const minutesToNext =
            stored >= netCatchCap
                ? 0
                : Math.max(0, netCatchMinutes - ((now() - net.lastCollectAt) % netCatchMinutes));
        return { x: net.x, y: net.y, stored, cap: netCatchCap, minutesToNext, builtAt: net.builtAt };
    };

    /** Whether dry ground stands under the body (the travel rungs' realm rule,
     * the behavior plugin's onDryGround twin). */
    const onDryGround = (actor: TaskEntity): boolean => {
        const cell = world?.cellAt(actor.position.x, actor.position.y);
        return cell !== undefined && cell.passable;
    };

    /** Whether the bag can hold ONE more fish (the 25-weight gate — the
     * inventory's own capacity arithmetic, public reads only). */
    const canHoldFish = (actorId: string): boolean => {
        const fishWeight = ITEM_WEIGHTS.fish ?? 1;
        return inventoryWeight(inventory.of(actorId)) + fishWeight <= inventory.capacityOf(actorId);
    };

    /** Whether the species may BUILD nets / CRAFT the tools (the 'craft'
     * work-kind unlock — the construction plugin's gate; no profiles, every
     * hand builds). Creatures never build. */
    const mayBuildNet = (actor: TaskEntity): boolean =>
        actor.kind !== 'creature' &&
        (profiles === null || (actor.type !== undefined && profiles.hasAbility(actor.type, 'craft')));

    /** Whether the species may HAUL a net's catch (the 'forage' work-kind
     * unlock — the shared gather job's skill). */
    const mayHaul = (actor: TaskEntity): boolean =>
        actor.kind !== 'creature' &&
        (profiles === null || (actor.type !== undefined && profiles.hasAbility(actor.type, 'forage')));

    /** Whether the bag holds one tool recipe's FULL input set. */
    const holdsInputs = (actorId: string, recipe: Recipe): boolean =>
        recipe.inputs.every((line) => (inventory.of(actorId)[line.item] ?? 0) >= line.count);

    /** Whether the bag holds ANY food item (the bridge's eat-first rule: a
     * haul or a craft is pointless while a meal already sits in the bag —
     * the ordinary hunger rung eats it). itemDef.kind is the public
     * category. */
    const holdsFood = (actorId: string): boolean => {
        const bag = inventory.of(actorId);
        return Object.keys(bag).some((item) => (bag[item] ?? 0) > 0 && itemDef(item).kind === 'food');
    };

    /**
     * THE ELIGIBILITY READ — dry shore ground only: passable (never the sea,
     * never an impassable basin, never the river ford itself), NOT a fresh
     * basin biome, touching FISHING WATER on a cardinal side (the sea or a
     * fresh basin — the same predicates the shore cast runs; the net works
     * the water it stands beside), no built structure at the tile's center
     * fine spot, no standing farm plot, no net already here, and the island
     * under its net cap.
     */
    const eligibleAt = (x: number, y: number): boolean => {
        const active = world;
        if (!active) {
            return false;
        }
        const cell = active.cellAt(x, y);
        if (!cell || !cell.passable) {
            return false;
        }
        if (isFreshBasin(cell.biome)) {
            return false;
        }
        const touchesWater = [
            { x: x + 1, y },
            { x: x - 1, y },
            { x, y: y + 1 },
            { x, y: y - 1 },
        ].some((spot) => {
            const water = active.cellAt(spot.x, spot.y);
            return water !== undefined && (isSeaWater(water.biome) || isFreshBasin(water.biome));
        });
        if (!touchesWater) {
            return false;
        }
        if (active.structures?.blocksFineSpot(x, y, 0, 0)) {
            return false;
        }
        if (nets.has(keyOf(x, y)) || nets.size >= maxNets) {
            return false;
        }
        return true;
    };

    /** One net-build beat task feeding the tile's standing net-build job. */
    const buildBeat = (x: number, y: number): TaskSpec => ({
        kind: FISH_NET_BUILD_TASK,
        label: 'rigs a fishing net',
        minutes: 1,
        // The beat carries its TILE (the gatherWork rule — the job the actor
        // committed to is the one they finish)
        payload: { x, y },
    });

    /** One net-collect beat task feeding the tile's standing haul job. */
    const collectBeat = (x: number, y: number): TaskSpec => ({
        kind: FISH_NET_COLLECT_TASK,
        label: 'hauls the net',
        minutes: 1,
        payload: { x, y },
    });

    /**
     * THE HAUL — the shared collect primitive (the netCollect beat's payout
     * closure AND the public `collect` read): pays UP TO the net's stored
     * catch into the agent's bag, capacity-gated (exactly what fits), and
     * advances the net's accrual clock by exactly the fish taken (the banked
     * fraction toward the next fish survives). Returns the fish hauled.
     */
    const haulNet = (x: number, y: number, agent: InventoryAgent): number => {
        const net = nets.get(keyOf(x, y));
        if (!net) {
            return 0;
        }
        const bag = inventory.of(agent.id);
        const fishWeight = itemWeight('fish');
        const room = Math.floor(
            (inventory.capacityOf(agent.id) - inventoryWeight(bag)) / fishWeight,
        );
        const stored = storedOf(net);
        const taken = Math.min(stored, Math.max(0, room));
        if (taken < 1) {
            return 0;
        }
        inventoryAdd(bag, 'fish', taken);
        net.lastCollectAt = net.lastCollectAt + taken * netCatchMinutes;
        return taken;
    };

    return {
        id: 'fishing',
        label: 'Fishing',

        setup: (context) => {
            world = context.world;
            const active = context.world;

            // ── rung 41 — THE HUNGRY-HAND BRIDGE (see the header) ──────────
            tasks.behaviour({
                id: FISHING_BRIDGE_ID,
                label: 'Fishing Bridge',
                priority: FISHING_BRIDGE_PRIORITY,
                appliesTo: (subject: TaskSubject) => {
                    const actor = subject.actor;
                    // Sentient conduct only — creatures feed naturally afloat
                    // (the behavior plugin's water-realm path); they never
                    // haul nets or craft tools.
                    if (actor.kind === 'creature' || !onDryGround(actor)) {
                        return false;
                    }
                    // Only the exact starvation situation: pressed by hunger,
                    // NOTHING edible in the bag (the ordinary hunger rung
                    // already serves a carried meal), and a fish would fit.
                    if (needs.of(actor.id).hunger < hungerTrigger || holdsFood(actor.id)) {
                        return false;
                    }
                    if (!canHoldFish(actor.id)) {
                        return false;
                    }
                    return true;
                },
                plan: (subject: TaskSubject) => {
                    const actor = subject.actor;
                    const x = actor.position.x;
                    const y = actor.position.y;
                    // 1) A RIPE net UNDERFOOT — the haul is the minute (the
                    //    shared tile job + beat, the gatherWork convention)
                    const here = nets.get(keyOf(x, y));
                    if (here && storedOf(here) > 0) {
                        openGatherJob(tasks.tileWork, {
                            x,
                            y,
                            item: NET_COLLECT_WORK,
                            units: netCollectWork,
                            skill: 'forage',
                        });
                        return collectBeat(x, y);
                    }
                    // 2) A ripe net ONE STEP away — step onto it (the
                    //    farm-harvest rung's adjacent-plot rule; a strict fine
                    //    step declines on a blocked spot instead of milling)
                    for (const spot of [
                        { x: x + 1, y },
                        { x: x - 1, y },
                        { x, y: y + 1 },
                        { x, y: y - 1 },
                    ]) {
                        const neighbor = nets.get(keyOf(spot.x, spot.y));
                        if (neighbor && storedOf(neighbor) > 0) {
                            const step = strictFineStep(active, actor, spot.x, spot.y);
                            if (step) {
                                return {
                                    kind: 'move',
                                    label: 'runs to the net',
                                    minutes: travel,
                                    payload: { dx: step[0], dy: step[1] },
                                };
                            }
                        }
                    }
                    // 3) NO fishing tool in the bag and the inputs for one ARE
                    //    in the bag — the craft is the minute (a private,
                    //    input-owned task; crafting is never tile work — the
                    //    R6 discipline). The tool lands and the NEXT minute
                    //    the shore cast / the trek takes over.
                    const bag = inventory.of(actor.id);
                    const holdsTool = (bag.spear ?? 0) > 0 || (bag.rod ?? 0) > 0;
                    if (!holdsTool) {
                        const recipe = FISH_TOOL_RECIPES.find((candidate) =>
                            holdsInputs(actor.id, candidate),
                        );
                        if (recipe) {
                            return {
                                kind: FISH_TOOL_TASK,
                                label: `crafts a ${recipe.id}`,
                                minutes: Math.max(1, recipe.minutes),
                                payload: { recipe: recipe.id },
                            };
                        }
                    }
                    return undefined;
                },
            });

            // ── rung 11 — the standing stewardship rung (see the header) ───
            tasks.behaviour({
                id: FISHING_BEHAVIOUR_ID,
                label: 'Fishing',
                priority: FISHING_PRIORITY,
                appliesTo: (subject: TaskSubject) =>
                    subject.actor.kind !== 'creature' && onDryGround(subject.actor),
                plan: (subject: TaskSubject) => {
                    const actor = subject.actor;
                    const x = actor.position.x;
                    const y = actor.position.y;
                    const here = nets.get(keyOf(x, y));
                    if (here) {
                        // A ripe net underfoot is hauled at ANY hunger level —
                        // the catch spoils against the cap while nobody hauls
                        if (storedOf(here) > 0 && canHoldFish(actor.id)) {
                            openGatherJob(tasks.tileWork, {
                                x,
                                y,
                                item: NET_COLLECT_WORK,
                                units: netCollectWork,
                                skill: 'forage',
                            });
                            return collectBeat(x, y);
                        }
                        // An empty net accrues on its own — nothing to do here
                        return undefined;
                    }
                    // No net here. Eligible ground underfoot and the FULL
                    // materials in the bag → rig one (the materials are
                    // consumed by the finishing claim — no fetching here, the
                    // ordinary materials economy feeds the bags)
                    if (
                        mayBuildNet(actor) &&
                        eligibleAt(x, y) &&
                        NET_MATERIALS.every((line) => (inventory.of(actor.id)[line.item] ?? 0) >= line.count)
                    ) {
                        openGatherJob(tasks.tileWork, {
                            x,
                            y,
                            item: NET_BUILD_WORK,
                            units: netBuildWork,
                            skill: 'craft',
                        });
                        return buildBeat(x, y);
                    }
                    // Else travel: toward the nearest RIPE net (the haul duty,
                    // only when the bag can take a fish). Deterministic:
                    // insertion order breaks Chebyshev ties.
                    let target: Net | null = null;
                    let bestDistance = Infinity;
                    if (canHoldFish(actor.id)) {
                        nets.forEach((net) => {
                            if (storedOf(net) <= 0) {
                                return;
                            }
                            const distance = chebyshev(actor.position, position3(net.x, net.y));
                            if (distance < bestDistance) {
                                target = net;
                                bestDistance = distance;
                            }
                        });
                    }
                    if (!target) {
                        return undefined;
                    }
                    const ripe = target as Net;
                    const cell = active.cellAt(ripe.x, ripe.y);
                    if (!cell) {
                        return undefined;
                    }
                    return travelSpec(active, actor, 'travels to the net', cell, travel);
                },
            });

            // ── the task effects — fishing governs its OWN kinds ──────────
            // (the behavior plugin's switch ignores unknown kinds; the sleep
            // plugin's per-kind listener is the pattern, plugins/sleep:302)
            unsubscribeComplete = tasks.ledger.onComplete((task) => {
                const active = world;
                if (!active) {
                    return;
                }
                // Fishing work is SENTIENT — the rungs never queue it for a
                // creature, so a despawned/despawned-mid-beat body's effect
                // drops (the registry holds every body that queues these)
                const actor = active.actors.get(task.actorId);
                if (!actor) {
                    return;
                }
                if (task.kind === FISH_TOOL_TASK) {
                    // THE ATOMIC TOOL CRAFT — the recipe validates the whole
                    // operation against the bag BEFORE anything changes: a
                    // moved/short stock loses nothing (the minutes were the
                    // cost). The post-craft weight must still fit the bag
                    // (the craft consumes the inputs from the same hand, so
                    // the net change is what must fit — the construction
                    // craft effect's exact rule).
                    const recipeId = task.payload?.recipe;
                    if (typeof recipeId !== 'string') {
                        return;
                    }
                    const bag = inventory.of(actor.id);
                    const outcome = crafting.craft(recipeId, bag);
                    if (!outcome.ok) {
                        return;
                    }
                    if (inventoryWeight(outcome.stock) > inventory.capacityOf(actor.id)) {
                        return;
                    }
                    Object.keys(bag).forEach((key) => {
                        delete bag[key];
                    });
                    Object.entries(outcome.stock).forEach(([item, count]) => {
                        bag[item] = count;
                    });
                    return;
                }
                if (task.kind === FISH_NET_BUILD_TASK || task.kind === FISH_NET_COLLECT_TASK) {
                    const x = Number(task.payload?.x ?? actor.position.x);
                    const y = Number(task.payload?.y ?? actor.position.y);
                    // THE ON-TILE GATE (the gather beat's twin,
                    // plugins/behavior) — the beat works the tile it was
                    // PLANNED on; a body carried off the committed tile
                    // mid-beat (a flee stride) lands NOWHERE: no minute
                    // banked, standing job intact.
                    if (actor.position.x !== x || actor.position.y !== y) {
                        return;
                    }
                    if (task.kind === FISH_NET_COLLECT_TASK) {
                        // THE SKILL REVALIDATION — a hand that lost 'forage'
                        // mid-beat banks nothing (narrow and conservative).
                        if (!mayHaul(actor)) {
                            return;
                        }
                        beatGatherJob(tasks.tileWork, { x, y, item: NET_COLLECT_WORK }, () =>
                            haulNet(x, y, actor) > 0,
                        );
                        return;
                    }
                    // THE BUILD CLAIM — revalidated at completion: the
                    // ground may have changed under the half-rigged net (a
                    // co-worker's net rose here, a structure wall closed the
                    // tile, the island filled its net cap), and the builder
                    // must still hold the FULL materials. Nothing lands on a
                    // failed claim; the job rolls back with its progress.
                    if (!mayBuildNet(actor)) {
                        return;
                    }
                    beatGatherJob(tasks.tileWork, { x, y, item: NET_BUILD_WORK }, () => {
                        if (!eligibleAt(x, y)) {
                            return false;
                        }
                        const bag = inventory.of(actor.id);
                        if (!NET_MATERIALS.every((line) => (bag[line.item] ?? 0) >= line.count)) {
                            return false;
                        }
                        // THE PAYMENT — the finishing builder's bag pays the
                        // full bill on the claim, each line at its DECLARED
                        // COUNT (NET_MATERIALS: wood 2 + vine 2 — the R3
                        // defect paid one unit per line and left half the
                        // bill in the bag). Atomic: the materials gate above
                        // validated every line's count in this same
                        // synchronous closure (nothing can interleave), so
                        // the writes land unconditionally — inventoryRemove
                        // drops a line's key exactly at zero.
                        NET_MATERIALS.forEach((line) => {
                            inventoryRemove(bag, line.item, line.count);
                        });
                        const minute = now();
                        nets.set(keyOf(x, y), { x, y, builtAt: minute, lastCollectAt: minute });
                        active.events.emit({
                            kind: 'fishing',
                            actorId: actor.id,
                            message: `${actor.name} rigs a fishing net at (${x}, ${y}).`,
                        });
                        return true;
                    });
                    return;
                }
            });
        },

        dispose: () => {
            // Drop BOTH behaviour modules (the ledger's update-on-remove rule
            // cancels their queued tasks — fishers go idle and re-plan through
            // the wider ladder) and tear the listener down. The nets are
            // THIS plugin's state — a swapped-out fishery does not haunt its
            // replacement; the standing tile jobs belong to the tasks
            // environment (its dispose clears them, the farming rule).
            tasks.dropBehaviour(FISHING_BRIDGE_ID);
            tasks.dropBehaviour(FISHING_BEHAVIOUR_ID);
            unsubscribeComplete?.();
            unsubscribeComplete = null;
            nets.clear();
            world = null;
        },

        netAt: (x, y) => {
            const net = nets.get(keyOf(x, y));
            return net ? viewOf(net) : undefined;
        },

        nets: () => Array.from(nets.values(), viewOf),

        eligibleAt: (x, y) => eligibleAt(x, y),

        collect: (x, y, agent) => haulNet(x, y, agent),

        reset: () => {
            nets.clear();
        },

        pacing: () => ({
            netBuildWork,
            netCollectWork,
            netCatchMinutes,
            netCatchCap,
            maxNets,
        }),
    };
};
