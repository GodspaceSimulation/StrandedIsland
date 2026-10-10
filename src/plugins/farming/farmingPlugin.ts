// The farming environment plugin — cultivated BERRY PLOTS as a food floor
// beyond the wild stocks (R5: foraging/harvesting alone is not enough;
// entities plant food that produces more).
//
// WHAT THIS PLUGIN OWNS — per-tile plot state (the island's farm), the
// autonomous planting/tending/harvesting conduct, and the harvest payout
// into the actor's bag. It edits NOTHING outside this folder: no TerrainCell
// field, no inventory registry, no entity profile. Plots live in a private
// Map keyed "x,y"; the crop is the EXISTING 'berry' item (nutrition 14 —
// the same food the wild bushes bear), so every eat/drink/display path
// already understands the product.
//
// ── THE PLOT LIFECYCLE (plant → immature → mature → harvest → renewed growth) ─
//
//   PLANTED  — a plot record is created (by an actor's completed plant job
//              or the god-side `plant(x, y)`); `matureAt` = now + matureMinutes.
//   IMMATURE — now < matureAt. Nothing is harvestable (NO free food before
//              maturity — the harvest payout re-validates ripeness at claim).
//              Tending a matureAt in the future pulls it earlier: a completed
//              tend job credits tendAdvanceMinutes of growth.
//   RIPE     — now >= matureAt. A harvest job pays berryPerHarvest berries
//              into the picker's bag (capacity-gated, pays exactly what fits).
//   RENEWED  — the harvest sets matureAt = now + regrowMinutes and counts a
//              cycle: the plot genuinely reproduces its yield, forever, on a
//              world-day-scale rhythm (defaults: 2 days to first fruit, 1 day
//              to re-fruit, 4 berries per harvest — ~56 hunger/day/plot vs a
//              human's 144/day decay, so a handful of tended plots per person
//              is a real food floor beside the wild forage).
//
// Growth is LAZY and timestamp-based (the forest plugin's pattern,
// plugins/forest poolAt): ripeness is DERIVED from `world.ticker.elapsed()`
// at every read (gates, plans, payouts) — the plugin has NO tick, and a
// zoomed/fast-stepped world matures plots exactly right with zero catch-up
// work. That is also why no `fastForward` is offered: stepping the world IS
// the fast-forward, and the timestamps stay coherent through it.
//
// ── THE WORK (R6 discipline, plugins/tasks/gatherWork.ts) ───────────────────
//
// Planting, tending and harvesting are PERSISTENT SHARED TILE JOBS in the
// tasks plugin's tile-work ledger, keyed `tileWorkKey(x, y, kind)` with the
// kinds 'farm-plant' / 'farm-tend' / 'farm-harvest' — deliberately NOT the
// bare item id ('berry'), so a farm harvest job never collides with the
// wild berry gather job on the same tile. Every actor's task is a 1-minute
// BEAT feeding the standing job; the payout happens ONLY on the atomic
// claim (ledger.complete), so N workers on one ripe plot produce exactly
// ONE batch of berries — never duplicated. A payout that fails (the bag
// has no room) puts the finished job back with its progress intact. The
// tile UI (features/tileDetails tileProgress) reads the ledger generically:
// farm jobs appear as progress bars with zero extra wiring.
//
// ── THE LADDER (taskLedger behaviour modules; the behavior plugin's sweep
//    plans every living thing, so farming rides it and must mount beside it) ──
//
//   farm-harvest 41 — THE HUNGRY-HAND BRIDGE. The behavior plugin's hunger
//              rung (40) does not know farm plots exist (the yields are NOT
//              in the inventory's cell stock), so without this rung a hungry
//              human walks OFF to a wild bush while the crop ripens — the
//              farm perpetually starves its owner. This rung sits ONE step
//              above hunger and fires ONLY in that exact situation: the
//              actor is at the hunger trigger (≥ 60), carries NO food, can
//              still hold a berry, and a RIPE plot is underfoot or one step
//              away. It queues the harvest beat (or one strict fine step
//              toward the adjacent ripe plot). The moment a berry lands in
//              the bag the gate closes and the ordinary hunger rung eats it
//              (−14). Thirst (50) and the flee (60) still outrank it; sleep
//              (30) does not — eating a ripe crop beats a night's slumber by
//              the same logic the hunger rung already outranks sleep.
//   farm        12 — the standing cultivation rung: ripe plot underfoot →
//              harvest beat; immature plot underfoot → tend beat; no plot
//              here and the island has room → plant underfoot; else travel
//              toward the nearest own plot, or (no plots yet) toward the
//              nearest ELIGIBLE fertile tile, preferring ground near
//              accessible fresh water (the survey's dry shore ring — see
//              eligibleAt/siting). Sits below every emergency need, sleep
//              and the build rungs (21–24), above lumber (10) and wander (0)
//              — farming is what the idle minute is FOR.
//
// Farming is SENTIENT cultivation: the gate demands kind 'sentient' AND the
// species' 'forage' skill when entity profiles are mounted (the same work
// gate as the shared gather jobs — no new 'farm' ability is coined, the
// entity file belongs to the survival worker). Creatures never farm.
//
// ── TERRAIN ELIGIBILITY (refuses rivers/water/boulders/structures) ──────────
//
// A plot may stand only on DRY (passable), FERTILE (biome 'meadow' or
// 'forest') land that is NOT a fresh-water basin — the refusal runs through
// `isFreshBasin` (engine/types.ts), the shared predicate the rivers worker
// widens to include the forthcoming 'river' biome (passable=true), so farm
// siting rejects river tiles the moment rivers exist WITHOUT this file ever
// naming the 'river' union token (no transient TS break). Tiles carrying
// the generator's boulder carve (cell.carving.rock) are refused, as are
// tiles walled by a completed structure (the world's `structures` hook at
// the tile's center fine spot) and tiles that already hold a plot. The
// island-wide plot count is capped (maxPlots) — bounded density.
//
// ── INTEGRATION CONTRACT (the scenario mount, owned by the integration
//    worker) ────────────────────────────────────────────────────────────────
//
//   const farming = createFarmPlugin({ tasks, inventory, needs, profiles });
//   // mount AFTER behavior (the rungs ride its planning sweep) and needs
//   // the same place the lumber/construction plugins mount (scenario/island.ts)
//   // REGENERATION RESET — wherever the scenario calls inventory.resurvey()
//   // after swapping the canvas, ALSO call farming.reset(): plots are keyed
//   // to old-map tile addresses and must not survive a regenerated island.
//   // Reads for the inspector/decor: plots(), plotAt(x, y), FARM_STAGE_GLYPHS.
//
// Dispose drops both behaviour modules (the ledger cancels their queued
// tasks), unsubscribes the completion listener and clears the plots — a
// swapped-out environment never leaks into its replacement. The standing
// tile JOBS belong to the tasks environment (its dispose clears them),
// exactly like the lumber plugin's chop jobs.

import { position3, type PluginContext, type WorldPlugin } from '@godspace/core';
import { isFreshBasin, type TerrainCell } from '../../engine/types';
import { ITEM_WEIGHTS, inventoryWeight, itemDef } from '../inventory/items';
import { inventoryAdd } from '../inventory/inventory';
import { beatGatherJob, openGatherJob } from '../tasks/gatherWork';
import { chebyshev, strictFineStep, travelSpec } from '../movement/fineMovement';
import type { World } from '../../engine/world';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { EntityProfiles } from '../entity/entityPlugin';
import type { TaskEntity, TaskSpec, TaskSubject } from '../tasks/taskLedger';

// ── Public vocabulary (integration + tests + UI import these, never strings) ─

/** The behaviour module ids this plugin registers into the task ledger. */
export const FARM_BEHAVIOUR_ID = 'farm';
export const FARM_HUNGER_BEHAVIOUR_ID = 'farm-harvest';

/** The task kinds this plugin queues and applies itself (the behavior
 * plugin's effect switch ignores unknown kinds — see its default branch). */
export const FARM_PLANT_TASK = 'farmPlant';
export const FARM_TEND_TASK = 'farmTend';
export const FARM_HARVEST_TASK = 'farmHarvest';

/** The tile-work job kinds (gatherWorkKey's `item` slot → "tile:x,y:farm-*").
 * Distinct from the bare 'berry' gather key so farm labor and wild forage
 * on one tile are two independent, UI-visible jobs. */
export const FARM_PLANT_WORK = 'farm-plant';
export const FARM_TEND_WORK = 'farm-tend';
export const FARM_HARVEST_WORK = 'farm-harvest';

/** The ladder slots: 12 sits above lumber (10) and wander (0), below every
 * need/sleep/build rung; 41 sits one above hunger (40) — see the header. */
export const FARM_PRIORITY = 12;
export const FARM_HUNGER_PRIORITY = 41;

/** Canvas glyphs for the plot stages — the integration's tile decor maps a
 * plot's stage through these (the berry item's own 🍒 stays the food glyph;
 * the cultivated plant reads as planted greenery / heavy fruit). */
export const FARM_STAGE_GLYPHS: Record<FarmStage, string> = {
    immature: '🌱',
    ripe: '🍇',
};

/** The crop — the existing berry item (the plot "bush" analogue: the stock
 * is the berries it bears, the same id the hunger rung's FOOD_PRIORITY eats). */
export const FARM_CROP_ITEM = 'berry';

/** A plot's growth stage, derived from the world clock at read time. */
export type FarmStage = 'immature' | 'ripe';

/** One plot's inspection card — the Tile Inspector / decor read (a copy;
 * mutating it never reaches the simulation). */
export type FarmPlotView = {
    x: number;
    y: number;
    /** The current growth stage at the read's world minute. */
    stage: FarmStage;
    /** Absolute world minute the plot was planted (stable for its life). */
    plantedAt: number;
    /** Absolute world minute the CURRENT growth cycle fruits. Tending pulls
     * it earlier; a harvest pushes it to now + regrowMinutes (renewed growth). */
    matureAt: number;
    /** Completed harvest cycles (the reproduction count). */
    cycles: number;
    /** Berries the next ripe harvest pays. */
    yieldPerHarvest: number;
};

/** Whether a number is a usable pacing value (finite and strictly positive —
 * the forest plugin's validation rule: a broken override never collapses a
 * rhythm to a 1-minute pulse). */
const finitePositive = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0;

export type FarmingPluginOptions = {
    tasks: TasksPlugin;
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    /** The entity profiles — the 'forage' work gate (the shared gather
     * skill; NO new 'farm' ability is coined). Absent: every sentient hand
     * may farm (the pre-entity behavior, the lumber/construction pattern). */
    profiles?: EntityProfiles;
    /** World minutes from planting to the first fruit. Default 2880 (2 days). */
    matureMinutes?: number;
    /** World minutes from a harvest to the renewed fruit. Default 1440 (1 day). */
    regrowMinutes?: number;
    /** WORK-minutes a plot's plant job demands. Default 20. */
    plantMinutes?: number;
    /** WORK-minutes one tending pass demands. Default 15. */
    tendMinutes?: number;
    /** WORK-minutes a harvest job demands. Default 10. */
    harvestMinutes?: number;
    /** Growth minutes one COMPLETED tend job credits. Default 180 (3 hours). */
    tendAdvanceMinutes?: number;
    /** Berries one ripe harvest pays. Default 4 (a farm bush out-yields the
     * wild bush's 3-berry carry). */
    berryPerHarvest?: number;
    /** Island-wide plot cap (bounded density). Default 12. */
    maxPlots?: number;
    /** How far (Chebyshev tiles) an actor will trek to site a first plot.
     * Default 5. */
    siteRange?: number;
    /** How far (Chebyshev tiles) a siting candidate may be from a passable
     * cell stocking fresh water to count as "near water". Default 3. */
    waterRange?: number;
    /** World minutes to move ONE SCALE-0 tile. Default 1 (the distribution's
     * distance rule, scenario/island.ts). */
    travelMinutesPerTile?: number;
    /** The hunger pressure the 41 bridge rung answers. Default 60 — the
     * EXACT mirror of the behavior plugin's private HUNGER_TRIGGER
     * (plugins/behavior/behaviorPlugin.ts:279); keep the two in step. */
    hungerTrigger?: number;
};

export type FarmingPlugin = WorldPlugin<World> & {
    /** The plot at (x, y) as of the current world minute, or undefined. */
    plotAt(x: number, y: number): FarmPlotView | undefined;
    /** Every standing plot, insertion order (deterministic), as of now. */
    plots(): FarmPlotView[];
    /** Whether a plot MAY stand at (x, y) right now (pure read — fertile,
     * dry, unbouldered, unstructured, unoccupied, under the cap). */
    eligibleAt(x: number, y: number): boolean;
    /** God-side plant — creates the plot immediately (no job). False when
     * ineligible or the island is at its plot cap. */
    plant(x: number, y: number): boolean;
    /** God-side removal — the plot leaves; standing farm jobs keep their
     * labor (the next plant job joins them, the ledger's join rule). */
    removePlot(x: number, y: number): boolean;
    /** THE REGENERATION RESET — wipe every plot. The scenario MUST call
     * this wherever it calls inventory.resurvey() after swapping the canvas
     * (plots are keyed to old-map tile addresses). */
    reset(): void;
    /** The resolved pacing — god-side and test reads. */
    pacing(): {
        matureMinutes: number;
        regrowMinutes: number;
        plantMinutes: number;
        tendMinutes: number;
        harvestMinutes: number;
        tendAdvanceMinutes: number;
        berryPerHarvest: number;
        maxPlots: number;
    };
};

/**
 * Creates the farming plugin. The options carry the pacing overrides (the
 * scenario threads them through IslandOptions like the forest's); every
 * invalid value falls back to its documented default.
 */
export const createFarmPlugin = (options: FarmingPluginOptions): FarmingPlugin => {
    const { tasks, inventory, needs } = options;
    // The entity profiles — the 'forage' skill gate. Null: every sentient hand farms.
    const profiles = options.profiles ?? null;

    // ── resolved pacing (the forest plugin's validation discipline) ────────
    const matureMinutes = finitePositive(options.matureMinutes) ? Math.floor(options.matureMinutes) : 2880;
    const regrowMinutes = finitePositive(options.regrowMinutes) ? Math.floor(options.regrowMinutes) : 1440;
    const plantMinutes = finitePositive(options.plantMinutes) ? Math.floor(options.plantMinutes) : 20;
    const tendMinutes = finitePositive(options.tendMinutes) ? Math.floor(options.tendMinutes) : 15;
    const harvestMinutes = finitePositive(options.harvestMinutes) ? Math.floor(options.harvestMinutes) : 10;
    const tendAdvanceMinutes = finitePositive(options.tendAdvanceMinutes)
        ? Math.floor(options.tendAdvanceMinutes)
        : 180;
    const berryPerHarvest = finitePositive(options.berryPerHarvest)
        ? Math.max(1, Math.floor(options.berryPerHarvest))
        : 4;
    const maxPlots = finitePositive(options.maxPlots) ? Math.max(1, Math.floor(options.maxPlots)) : 12;
    const siteRange = finitePositive(options.siteRange) ? Math.floor(options.siteRange) : 5;
    const waterRange = finitePositive(options.waterRange) ? Math.floor(options.waterRange) : 3;
    const travel = finitePositive(options.travelMinutesPerTile)
        ? Math.floor(options.travelMinutesPerTile)
        : 1;
    const hungerTrigger = finitePositive(options.hungerTrigger) ? options.hungerTrigger : 60;

    // The plots — the plugin's OWN per-tile state (no TerrainCell edit).
    // Insertion order is the deterministic tiebreak for nearest-plot reads.
    type Plot = { x: number; y: number; plantedAt: number; matureAt: number; cycles: number };
    const plots = new Map<string, Plot>();
    const keyOf = (x: number, y: number): string => `${x},${y}`;

    // The world arrives with setup — ripeness reads the ticker's ABSOLUTE
    // elapsed minutes, so plot state stays coherent across plugin remounts
    // (the forest plugin's monotonic-clock reasoning, plugins/forest dispose).
    let world: World | null = null;
    // The completion-listener unsubscribe, torn down at dispose
    let unsubscribeComplete: (() => void) | null = null;

    /** The world clock in absolute world minutes (0 before setup). */
    const now = (): number => world?.ticker.elapsed() ?? 0;

    /** Whether a plot's current cycle has fruited at the clock. */
    const isRipe = (plot: Plot): boolean => now() >= plot.matureAt;

    /**
     * THE FARM GATE — cultivation is sentient conduct (people plant; gulls
     * and boars do not) and, when profiles are mounted, demands the
     * species' 'forage' skill (the shared gather work gate — the entity
     * file is owned by the survival worker, so no 'farm' ability is coined).
     */
    const mayFarm = (actor: TaskEntity): boolean =>
        actor.kind === 'sentient' &&
        (profiles === null ||
            (actor.type !== undefined && profiles.hasAbility(actor.type, 'forage')));

    /** Whether dry ground stands under the body (the travel rungs' realm rule,
     * the behavior plugin's onDryGround twin). */
    const onDryGround = (actor: TaskEntity): boolean => {
        const cell = world?.cellAt(actor.position.x, actor.position.y);
        return cell !== undefined && cell.passable;
    };

    /**
     * THE BERRY-FIT GATE — can this bag still hold ONE berry? The weight
     * arithmetic mirrors the inventory plugin's own capacity gate
     * (capacityOf × inventoryWeight × ITEM_WEIGHTS — all public reads), so
     * the farm payout never overloads a carrier and the hungry-hand gate
     * never queues a take the bag would refuse.
     */
    const canHoldBerry = (actorId: string): boolean => {
        const bag = inventory.of(actorId);
        const berryWeight = ITEM_WEIGHTS[FARM_CROP_ITEM] ?? 1;
        return inventoryWeight(bag) + berryWeight <= inventory.capacityOf(actorId);
    };

    /** Whether the bag holds ANY food item (the eat-first rule: a crop
     * harvest is pointless while a berry already sits in the bag — the
     * ordinary hunger rung eats it). itemDef.kind is the public category. */
    const holdsFood = (actorId: string): boolean =>
        Object.keys(inventory.of(actorId)).some(
            (item) => (inventory.of(actorId)[item] ?? 0) > 0 && itemDef(item).kind === 'food',
        );

    /**
     * THE ELIGIBILITY READ — fertile dry land only: passable (refuses the
     * sea and the impassable basins), biome meadow/forest (refuses beach,
     * highland and any future non-fertile skin — and river biome cells the
     * moment the rivers worker coins one), NOT a fresh-water basin through
     * the SHARED isFreshBasin predicate (the rivers worker widens it to
     * include the passable 'river' — this file never names the token, so
     * rivers refuse without a transient TS break), no boulder carve, no
     * completed structure at the tile's center fine spot, no plot already
     * here, and the island under its plot cap.
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
        if (cell.biome !== 'meadow' && cell.biome !== 'forest') {
            return false;
        }
        // The generator's boulder band — a carved tile is rock-crowned ground
        if ((cell.carving?.rock.length ?? 0) > 0) {
            return false;
        }
        // A built structure walls its footprint — the center fine spot is the
        // tile-level proxy (the doorway gate cell may still pass; the plot
        // then simply shares the site's tile, which is honest farmland)
        if (active.structures?.blocksFineSpot(x, y, 0, 0)) {
            return false;
        }
        if (plots.has(keyOf(x, y)) || plots.size >= maxPlots) {
            return false;
        }
        return true;
    };

    /** The plot record at (x, y), when one stands there. */
    const plotAtTile = (x: number, y: number): Plot | undefined => plots.get(keyOf(x, y));

    /** The plot view at the clock — the lazy stage derivation (no tick). */
    const viewOf = (plot: Plot): FarmPlotView => ({
        x: plot.x,
        y: plot.y,
        stage: now() >= plot.matureAt ? 'ripe' : 'immature',
        plantedAt: plot.plantedAt,
        matureAt: plot.matureAt,
        cycles: plot.cycles,
        yieldPerHarvest: berryPerHarvest,
    });

    /**
     * THE SITING READ — the best eligible tile within siteRange of the
     * actor, preferring ground within waterRange of a PASSABLE cell that
     * stocks fresh water (the survey's dry shore ring — the thirst ladder's
     * own targets). Rank: water-near first, then Chebyshev distance, then
     * the canvas's row-major order — fully deterministic, no stream draw.
     */
    const bestSite = (actor: TaskEntity): TerrainCell | null => {
        const active = world;
        if (!active) {
            return null;
        }
        // The fresh-water shore map: passable cells stocking water (the
        // impassable basins stock it too but a farmer cannot stand in one —
        // the shore ring is what "accessible freshwater" means on this island)
        const waterCells: TerrainCell[] = [];
        active.canvas.cells.forEach((cell) => {
            if (cell.passable && (inventory.cellStock(cell.x, cell.y).water ?? 0) > 0) {
                waterCells.push(cell);
            }
        });
        const nearWater = (cell: TerrainCell): boolean =>
            waterCells.some(
                (water) => chebyshev(position3(cell.x, cell.y), position3(water.x, water.y)) <= waterRange,
            );
        let best: TerrainCell | null = null;
        let bestWater = false;
        let bestDistance = Infinity;
        active.canvas.cells.forEach((cell) => {
            const distance = chebyshev(actor.position, position3(cell.x, cell.y));
            if (distance > siteRange || !eligibleAt(cell.x, cell.y)) {
                return;
            }
            const water = nearWater(cell);
            // Water-near wins; closer wins within a class; row-major order
            // (the forEach order) breaks exact ties — deterministic
            if (
                !best ||
                (water && !bestWater) ||
                (water === bestWater && distance < bestDistance)
            ) {
                best = cell;
                bestWater = water;
                bestDistance = distance;
            }
        });
        return best;
    };

    /** The nearest own plot to the actor (Chebyshev; insertion order breaks
     * ties — deterministic). */
    const nearestPlot = (actor: TaskEntity): Plot | null => {
        let best: Plot | null = null;
        let bestDistance = Infinity;
        plots.forEach((plot) => {
            const distance = chebyshev(actor.position, position3(plot.x, plot.y));
            if (distance < bestDistance) {
                best = plot;
                bestDistance = distance;
            }
        });
        return best;
    };

    /** One harvest beat task feeding the tile's standing farm-harvest job. */
    const harvestBeat = (x: number, y: number): TaskSpec => ({
        kind: FARM_HARVEST_TASK,
        label: 'harvests the plot',
        minutes: 1,
        // The beat carries its TILE (the gatherWork rule — the job the actor
        // committed to is the one they finish, and the completion listener
        // re-validates the body still stands there)
        payload: { x, y },
    });

    return {
        id: 'farming',
        label: 'Farming',

        setup: (context: PluginContext<World>) => {
            world = context.world;
            const active = context.world;

            // ── rung 41 — THE HUNGRY-HAND BRIDGE (see the header) ──────────
            tasks.behaviour({
                id: FARM_HUNGER_BEHAVIOUR_ID,
                label: 'Farm Harvest',
                priority: FARM_HUNGER_PRIORITY,
                appliesTo: (subject: TaskSubject) => {
                    const actor = subject.actor;
                    if (!mayFarm(actor) || !onDryGround(actor)) {
                        return false;
                    }
                    // Only the exact starvation situation: pressed by hunger,
                    // NOTHING edible in the bag (a full belly or a carried
                    // berry = the ordinary hunger rung already serves it),
                    // and a berry would still fit (the capacity rule).
                    if (needs.of(actor.id).hunger < hungerTrigger || holdsFood(actor.id)) {
                        return false;
                    }
                    if (!canHoldBerry(actor.id)) {
                        return false;
                    }
                    // A RIPE plot underfoot or one step away — "near", never
                    // a trek (the hunger rung's own travel keeps the long
                    // walks; this rung only rescues the crop at hand)
                    const here = plotAtTile(actor.position.x, actor.position.y);
                    if (here && isRipe(here)) {
                        return true;
                    }
                    return active.canvas.cells.some(
                        (cell) =>
                            chebyshev(actor.position, position3(cell.x, cell.y)) === 1 &&
                            plots.has(keyOf(cell.x, cell.y)) &&
                            isRipe(plots.get(keyOf(cell.x, cell.y)) as Plot) &&
                            strictFineStep(active, actor, cell.x, cell.y) !== null,
                    );
                },
                plan: (subject: TaskSubject) => {
                    const actor = subject.actor;
                    const here = plotAtTile(actor.position.x, actor.position.y);
                    if (here && isRipe(here)) {
                        // The ripe plot is UNDERFOOT — open (or join) the
                        // tile's shared harvest job and work one beat minute
                        openGatherJob(tasks.tileWork, {
                            x: actor.position.x,
                            y: actor.position.y,
                            item: FARM_HARVEST_WORK,
                            units: harvestMinutes,
                            skill: 'forage',
                        });
                        return harvestBeat(actor.position.x, actor.position.y);
                    }
                    // Adjacent ripe plot — one STRICT fine step onto it (the
                    // mill fallback would pin a blocked body busy forever,
                    // the roost rung's rule, plugins/behavior:966)
                    let step: [number, number] | null = null;
                    let distance = Infinity;
                    active.canvas.cells.forEach((cell) => {
                        const cellDistance = chebyshev(actor.position, position3(cell.x, cell.y));
                        if (
                            cellDistance === 1 &&
                            cellDistance < distance &&
                            plots.has(keyOf(cell.x, cell.y)) &&
                            isRipe(plots.get(keyOf(cell.x, cell.y)) as Plot)
                        ) {
                            const candidate = strictFineStep(active, actor, cell.x, cell.y);
                            if (candidate) {
                                step = candidate;
                                distance = cellDistance;
                            }
                        }
                    });
                    if (!step) {
                        return undefined;
                    }
                    const [dx, dy] = step as [number, number];
                    return {
                        kind: 'move',
                        label: 'runs to the farm',
                        minutes: travel,
                        payload: { dx, dy },
                    };
                },
            });

            // ── rung 12 — the standing cultivation rung (see the header) ───
            tasks.behaviour({
                id: FARM_BEHAVIOUR_ID,
                label: 'Farming',
                priority: FARM_PRIORITY,
                appliesTo: (subject: TaskSubject) =>
                    mayFarm(subject.actor) && onDryGround(subject.actor),
                plan: (subject: TaskSubject) => {
                    const actor = subject.actor;
                    const x = actor.position.x;
                    const y = actor.position.y;
                    const here = plotAtTile(x, y);
                    if (here) {
                        if (isRipe(here)) {
                            // RIPE underfoot — the harvest (the 41 rung only
                            // covers the starving case; this is the routine
                            // pick at any hunger level below its trigger)
                            openGatherJob(tasks.tileWork, {
                                x,
                                y,
                                item: FARM_HARVEST_WORK,
                                units: harvestMinutes,
                                skill: 'forage',
                            });
                            return harvestBeat(x, y);
                        }
                        // IMMATURE underfoot — the tend pass (its claim
                        // credits growth; see the tend payout)
                        openGatherJob(tasks.tileWork, {
                            x,
                            y,
                            item: FARM_TEND_WORK,
                            units: tendMinutes,
                            skill: 'forage',
                        });
                        return { kind: FARM_TEND_TASK, label: 'tends the plot', minutes: 1, payload: { x, y } };
                    }
                    // No plot here. Room on the island and fertile ground
                    // underfoot → expand the farm where the body stands.
                    if (eligibleAt(x, y)) {
                        openGatherJob(tasks.tileWork, {
                            x,
                            y,
                            item: FARM_PLANT_WORK,
                            units: plantMinutes,
                            skill: 'forage',
                        });
                        return { kind: FARM_PLANT_TASK, label: 'plants a berry plot', minutes: 1, payload: { x, y } };
                    }
                    // Else travel: toward the nearest own plot (tend/harvest
                    // duty), or — while the island has no farm — toward the
                    // best eligible fertile tile near accessible fresh water.
                    const target = plots.size > 0 ? nearestPlot(actor) : bestSite(actor);
                    if (!target) {
                        return undefined;
                    }
                    const cell = active.cellAt(target.x, target.y);
                    if (!cell) {
                        return undefined;
                    }
                    return travelSpec(active, actor, 'travels to the farm', cell, travel);
                },
            });

            // ── the task effects — farming governs its OWN kinds ──────────
            // (the behavior plugin's switch ignores unknown kinds; the sleep
            // plugin's per-kind listener is the pattern, plugins/sleep:302)
            unsubscribeComplete = tasks.ledger.onComplete((task) => {
                if (
                    task.kind !== FARM_PLANT_TASK &&
                    task.kind !== FARM_TEND_TASK &&
                    task.kind !== FARM_HARVEST_TASK
                ) {
                    return;
                }
                const actor = active.actors.get(task.actorId);
                if (!actor) {
                    // Despawned mid-beat — the effect drops (the ledger
                    // already cancelled the queue; this is the race guard)
                    return;
                }
                const x = Number(task.payload?.x ?? actor.position.x);
                const y = Number(task.payload?.y ?? actor.position.y);
                // THE ON-TILE GATE (the gather beat's twin, plugins/behavior:1222) —
                // the payout closures read the PLOT, and a body carried off
                // the committed tile mid-beat (a flee stride) must not work
                // a different tile through this job's claim. Off-tile the
                // beat lands NOWHERE: no minute banked, standing job intact.
                if (actor.position.x !== x || actor.position.y !== y) {
                    return;
                }
                // THE SKILL REVALIDATION — a hand that lost the gate mid-beat
                // banks nothing (narrow and conservative, the forage rule).
                if (!mayFarm(actor)) {
                    return;
                }
                const workKind =
                    task.kind === FARM_PLANT_TASK
                        ? FARM_PLANT_WORK
                        : task.kind === FARM_TEND_TASK
                          ? FARM_TEND_WORK
                          : FARM_HARVEST_WORK;
                // THE SHARED BEAT — bank the minute, pay out ONLY on the
                // atomic claim; a failed payout rolls the finished job back
                // with its progress (plugins/tasks/gatherWork beatGatherJob).
                beatGatherJob(tasks.tileWork, { x, y, item: workKind }, () => {
                    const minute = now();
                    const plot = plotAtTile(x, y);
                    if (task.kind === FARM_PLANT_TASK) {
                        // THE PLANT PAYOUT — re-validated at claim: the
                        // ground may have changed under the half-dug bed
                        // (a co-worker planted the tile, a structure rose,
                        // the island filled its plot cap). Nothing lands on
                        // a failed claim; the job returns.
                        if (plot || !eligibleAt(x, y)) {
                            return false;
                        }
                        plots.set(keyOf(x, y), {
                            x,
                            y,
                            plantedAt: minute,
                            matureAt: minute + matureMinutes,
                            cycles: 0,
                        });
                        // A new farm is a world-scale happening — the log
                        // line the god-view reads (harvests stay solo beats,
                        // the log-is-a-story-teller rule)
                        active.events.emit({
                            kind: 'farm',
                            actorId: actor.id,
                            message: `${actor.name} plants a berry plot at (${x}, ${y}).`,
                        });
                        return true;
                    }
                    if (task.kind === FARM_TEND_TASK) {
                        // THE TEND PAYOUT — a completed pass credits growth:
                        // matureAt pulls earlier, floored at the next minute
                        // (a tend never harvests the same minute it ripens —
                        // the ripe plot wants the harvest rung instead).
                        if (!plot || minute >= plot.matureAt) {
                            return false; // gone, or already ripe — nothing to tend
                        }
                        plot.matureAt = Math.max(minute + 1, plot.matureAt - tendAdvanceMinutes);
                        return true;
                    }
                    // THE HARVEST PAYOUT — ripeness re-validated at claim
                    // (NO free food before maturity: a co-worker may have
                    // picked the batch during the wait, or the cycle may
                    // not have fruited at all). The take is capacity-gated
                    // and pays EXACTLY what fits (the inventory harvest's
                    // conservation rule); a bag with no room for even one
                    // berry rolls the finished job back — the labor stands.
                    if (!plot || minute < plot.matureAt) {
                        return false;
                    }
                    const bag = inventory.of(actor.id);
                    const berryWeight = ITEM_WEIGHTS[FARM_CROP_ITEM] ?? 1;
                    const room = Math.floor(
                        (inventory.capacityOf(actor.id) - inventoryWeight(bag)) / berryWeight,
                    );
                    const taken = Math.min(berryPerHarvest, room);
                    if (taken < 1) {
                        return false;
                    }
                    inventoryAdd(bag, FARM_CROP_ITEM, taken);
                    // RENEWED GROWTH — the plot reproduces: the cycle counts
                    // and the next fruit lands a regrow rest away
                    plot.matureAt = minute + regrowMinutes;
                    plot.cycles = plot.cycles + 1;
                    return true;
                });
            });
        },

        dispose: () => {
            // Drop BOTH behaviour modules (the ledger's update-on-remove rule
            // cancels their queued tasks — farmers go idle and re-plan through
            // the wider ladder) and tear the listener down. The plots are
            // THIS plugin's state — a swapped-out farm does not haunt its
            // replacement; the standing tile jobs belong to the tasks
            // environment (its dispose clears them, the lumber rule).
            tasks.dropBehaviour(FARM_HUNGER_BEHAVIOUR_ID);
            tasks.dropBehaviour(FARM_BEHAVIOUR_ID);
            unsubscribeComplete?.();
            unsubscribeComplete = null;
            plots.clear();
            world = null;
        },

        plotAt: (x, y) => {
            const plot = plotAtTile(x, y);
            return plot ? viewOf(plot) : undefined;
        },

        plots: () => Array.from(plots.values(), viewOf),

        eligibleAt: (x, y) => eligibleAt(x, y),

        plant: (x, y) => {
            // God-side immediate plant — the same eligibility law as the
            // actor payout, no job (the integration/inspector plants a test
            // farm without waiting on the ladder)
            if (!eligibleAt(x, y)) {
                return false;
            }
            plots.set(keyOf(x, y), {
                x,
                y,
                plantedAt: now(),
                matureAt: now() + matureMinutes,
                cycles: 0,
            });
            // The same log line the actor payout emits (a new farm is a
            // world-scale happening; the god hand has no actor behind it)
            world?.events.emit({
                kind: 'farm',
                message: `A berry plot is planted at (${x}, ${y}).`,
            });
            return true;
        },

        removePlot: (x, y) => plots.delete(keyOf(x, y)),

        reset: () => {
            plots.clear();
        },

        pacing: () => ({
            matureMinutes,
            regrowMinutes,
            plantMinutes,
            tendMinutes,
            harvestMinutes,
            tendAdvanceMinutes,
            berryPerHarvest,
            maxPlots,
        }),
    };
};
