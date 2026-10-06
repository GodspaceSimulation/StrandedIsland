// The construction environment plugin — the island's BUILD and CRAFT
// governance, planned through the shared @godspace stack.
//
// This plugin is the distribution half of the T4 loop: it wires the SHARED
// registries (@godspace/blueprint's blueprint + site registries,
// @godspace/material's crafting registry) to the island world and registers
// the construction behaviour modules into the task ledger
// (plugins/tasks/taskLedger.ts). The reusable halves of its conduct are
// built from the CORE's stock behaviour factories (craftTaskBehaviour,
// buildTaskBehaviour — packages/godspace/core/src/task) with island gates
// composed on top, so the shared factories genuinely underpin the island's
// custom behaviours.
//
// THE PLAN — one stock structure at a time, in a fixed order (cooperative,
// deterministic: the whole cast serves the same live site):
//   shelter → raft → house → boat → fort
// The tick places the current project's site (a feasible dry-land scan
// ranked by centrality; vessels moor on beaches with a water neighbour)
// when nothing is live, and advances the cursor when the project's site
// stands BUILT.
//
// THE WORK CYCLE (every sentient, every minute — the behavior plugin's
// whole-world sweep consults these rungs):
//   deliver 24 — the bag holds a material the site still lacks → haul it to
//                an open cell of the footprint and stage it (1-minute task
//                on the footprint). Deliveries are PROGRESSIVE: a house
//                needs 12 units but a bag carries 8, so the crew ferries
//                several loads.
//   craft   23 — the bag holds a recipe's inputs and the site still lacks
//                the output → the craft (the atomic craft revalidates the
//                bag at completion: a spent stock loses nothing). Island
//                recipes: vine→rope, wood→plank, frond→thatch, frond→cloth.
//   materials 22 — a raw fetch is owed (demand-directed: only what the
//                site's staging still lacks, never bag-filling lumber) →
//                take it underfoot (the fetch modules ride the CORE's
//                gather factory), fell a tree for wood, or travel toward
//                the nearest stocked cell.
//   build   21 — the site is fully staged → stand on its footprint and
//                work one world-minute per task (the shared site
//                registry's per-minute workOn stages).
// Every rung sits BELOW the survival needs (rest 25 / sleep 30 / hunger 40
// / thirst 50 / flee 60) — needs always interrupt construction, and ABOVE
// social (20) and lumber (10) — the build projects are never starved by
// small talk or the wood rack's one-wood habit.
//
// THE GATE (doorway) — a site's walkable cell is the resolved FIRST
// definition cell (blueprint cells[0]; every stock blueprint's cells[0] is
// its anchor corner). While the footprint is unbuilt its cells are open
// ground the whole crew stages and works from (a body can always step OFF
// a cell a wall later rises on — only movement DESTINATIONS are
// validated); when the footprint COMPLETES, its registry occupancy walls
// every cell but the gate off (fineMovement.fineSpotTaken reads the
// world's structures hook) — the intentional doorway/adjacency rule.
// PLANNED footprints do not block movement: their clearance is checked at
// placement (dry land, nobody standing in the cells).
//
// THE SHELTER'S SURVIVAL USE — a body SLEEPING or RESTING on a built
// roofed structure's gate recovers energy faster (+0.5 per world minute,
// applied by this plugin's tick, mirroring the sleep plugin's per-minute
// restore): the sheltered night is the safe night.
//
// THE VESSELS — a built raft or boat is a CONCRETE OUTPUT: `launch(site)`
// requires a water neighbour beside the shore it was built on, frees the
// site's cells (the beach is a beach again — no refund: the materials sail
// with the hull) and records the moored vessel (inspectable via vessels(),
// a 'launch' log line). Launching is as far as the simulation goes — no
// water travel is faked.
//
// Mounts only beside tasks + behavior + inventory + needs (its tasks ride
// the behavior plugin's move/collect effects; its staging reads the
// inventory) — the scenario guards the mount (scenario/island.ts).

import { arrayEach } from '@presource/core';
import {
    buildTaskBehaviour,
    craftTaskBehaviour,
    gatherTaskBehaviour,
    position3,
    type Position3D,
    type WorldPlugin,
} from '@godspace/core';
import {
    createBlueprintRegistry,
    createSiteRegistry,
    siteCellKey,
    type BlueprintRegistry,
    type Site,
    type SiteCell,
    type SiteRegistry,
    type SiteSpec,
} from '@godspace/blueprint';
import {
    createCraftingRegistry,
    type CraftingRegistry,
    type Recipe,
    type RecipeLine,
} from '@godspace/material';
import type { World } from '../../engine/world';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { EntityProfiles } from '../entity/entityPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { TaskBehaviour, TaskSubject } from '../tasks/taskLedger';
import { inventoryRemove, inventoryTotal } from '../inventory/inventory';
import { materials, MINED_ITEMS } from '../inventory/items';
import { fineTargetStep, fineSpotTaken, nearestCell, travelSpec } from '../movement/fineMovement';

// ── The island's buildable plan ──────────────────────────────────────────────

/**
 * The build order — one stock blueprint at a time, the shelter first (the
 * first night's cover), the escape craft next, then the long homes. The
 * boat needs cloth (frond-woven) and the fort needs mined stone, so they
 * sit late in the order where their supply chains have had time to run.
 */
export const PLAN_ORDER: readonly string[] = ['shelter', 'raft', 'house', 'boat', 'fort'];

/** The blueprints whose built output floats — the launchable craft. */
export const VESSEL_BLUEPRINTS: readonly string[] = ['raft', 'boat'];

/** The blueprints a sleeper shelters under — the rest-bonus structures. */
export const ROOFED_BLUEPRINTS: readonly string[] = ['shelter', 'house'];

/**
 * The raw materials the crew TAKES OFF CELLS (the core gather factory's
 * underfoot fetches). Wood is NOT on this list — wood never stands on a
 * tile; it is FELLED off the trees (the materials rung's harvest). Stone
 * rides the take (the mine gate revalidates at completion — the species'
 * 'mine' ability); vine and frond hang in the woods.
 */
export const TAKEN_MATERIALS: readonly string[] = ['vine', 'frond', 'stone'];

/**
 * The island's recipes — coined on @godspace/material's crafting registry
 * (stock: false — the stock recipes reference fiber/clay items the island
 * does not grow). The chains are one level deep: every crafted part comes
 * off a raw island material (vine, wood, frond).
 */
export const ISLAND_RECIPES: readonly Recipe[] = [
    // Rope: two vines twisted (the raft's lashings, the boats' rigging).
    { id: 'rope', label: 'Rope', kind: 'part', inputs: [{ item: 'vine', count: 2 }], outputs: [{ item: 'rope', count: 1 }], minutes: 5 },
    // Planks: one log splits into two boards (the house's floor, the boat's hull).
    { id: 'plank', label: 'Plank', kind: 'part', inputs: [{ item: 'wood', count: 1 }], outputs: [{ item: 'plank', count: 2 }], minutes: 5 },
    // Thatch: two fronds woven (the shelter's and the house's roof).
    { id: 'thatch', label: 'Thatch', kind: 'part', inputs: [{ item: 'frond', count: 2 }], outputs: [{ item: 'thatch', count: 1 }], minutes: 3 },
    // Cloth: three fronds beaten and woven (the boat's sail canvas).
    { id: 'cloth', label: 'Cloth', kind: 'part', inputs: [{ item: 'frond', count: 3 }], outputs: [{ item: 'cloth', count: 1 }], minutes: 6 },
];

/** Canvas type-glyphs for the structures — the scale-0 footprint entries
 * (features/tileDetails scaleView) and the unicode/svg type palettes
 * resolve an entry's TYPE through these, so a site's cells draw their
 * structure emoji in the zoomed views. */
export const STRUCTURE_TYPE_GLYPHS: Record<string, string> = {
    shelter: '🏕️',
    house: '🏠',
    fort: '🏰',
    raft: '🛶',
    boat: '⛵',
};

/** The construction rung priorities — between rest (25) and social (20). */
const DELIVER_PRIORITY = 24;
const CRAFT_PRIORITY = 23;
const MATERIALS_PRIORITY = 22;
const BUILD_PRIORITY = 21;

/** World minutes one staging task occupies the deliverer at the gate. */
const DELIVER_MINUTES = 1;
/** World minutes taking one raw material off a cell occupies. */
const TAKE_MINUTES = 2;
/** World minutes felling one tree occupies (the lumber chop's pace). */
const FELL_MINUTES = 15;
/** World minutes one build task stages (the per-minute work stage). */
const BUILD_MINUTES = 1;
/** Extra energy per world minute a sheltered sleeper recovers. */
const SHELTER_REST_PER_MINUTE = 0.5;

/** One moored vessel — the concrete output of a launched raft or boat. */
export type Vessel = {
    /** Vessel id, "v-1", "v-2", … in launch order. */
    id: string;
    /** The site the vessel was built on (removed at launch). */
    siteId: string;
    /** The blueprint the vessel was built from. */
    blueprintId: string;
    /** Display label (the blueprint's). */
    label: string;
    /** The shore tile the vessel moors at (the site's anchor tile). */
    x: number;
    y: number;
    /** Elapsed world minutes at the launch. */
    launchedAt: number;
};

/**
 * The demand of one site — what its staging still lacks, expanded through
 * the crafting chains: `raw` lists the fetches (requirement order,
 * first-seen accumulation), `recipes` the crafts owed (with how many runs).
 */
export type SiteDemand = {
    raw: Array<{ item: string; count: number }>;
    recipes: Array<{ recipe: Recipe; count: number }>;
};

/** The walkable spot of a site — its GATE cell resolved to world addresses. */
export type GateSpot = { tileX: number; tileY: number; x: number; y: number };

export type ConstructionPluginOptions = {
    inventory: InventoryPlugin;
    needs: NeedsPlugin;
    tasks: TasksPlugin;
    /**
     * The entity profiles — the species ability gates (the mine unlock for
     * stone) and the bag sizes the staging gates read. Absent: every hand
     * may take everything and bags are unlimited (the pre-entity behavior).
     */
    profiles?: EntityProfiles;
    /** World minutes to move ONE SCALE-0 tile. Default 1 (the
     * distribution's distance rule, scenario/island.ts). */
    travelMinutesPerTile?: number;
};

export type ConstructionPlugin = WorldPlugin<World> & {
    /** The blueprint registry — the stock structural patterns (shelter,
     * house, fort, raft, boat) the island builds through. */
    blueprints: BlueprintRegistry;
    /** The crafting registry — the island's recipes over the island materials. */
    crafting: CraftingRegistry;
    /**
     * The site registry — created at SETUP against the live canvas (the
     * grid dims are the sub-grid dims the whole zoom ladder shares). Before
     * setup it is a 1×1 placeholder; every consumer reads it post-setup.
     */
    readonly sites: SiteRegistry;
    /** The live site the crew serves (staged or building), or undefined. */
    activeSite(): Site | undefined;
    /** The blueprint the plan cursor is on, or undefined when all stand. */
    project(): string | undefined;
    /** The blueprint ids completed, in completion order. */
    completedBlueprints(): string[];
    /** The moored vessels, in launch order. */
    vessels(): Vessel[];
    /**
     * Launches a BUILT raft or boat: requires a water neighbour beside the
     * shore it stands on (the mooring), frees the site (no refund — the
     * materials sail with the hull) and records the moored vessel.
     * Undefined when the site is unknown, unbuilt, not a vessel, or the
     * shore has no water to launch into.
     */
    launch(siteId: string): Vessel | undefined;
};

export const constructionPlugin = (options: ConstructionPluginOptions): ConstructionPlugin => {
    const { inventory, needs, tasks } = options;
    // The entity profiles — the mine gate + the bag sizes. Null: unlimited
    // bags, every hand takes everything (the pre-entity behavior).
    const profiles = options.profiles ?? null;
    const travel = options.travelMinutesPerTile ?? 1;

    // The shared registries. The blueprint registry seeds the stock
    // structural patterns; the crafting registry starts EMPTY (stock:
    // false — the stock recipes reference fiber/clay the island does not
    // grow) and takes the island's recipes, validated against the island's
    // own slice of the shared item catalog (materials, plugins/inventory).
    const blueprints = createBlueprintRegistry();
    const crafting = createCraftingRegistry({ stock: false, items: materials });
    arrayEach([...ISLAND_RECIPES], ({ value: recipe }) => {
        crafting.define({
            id: recipe.id,
            label: recipe.label,
            kind: recipe.kind,
            inputs: recipe.inputs.map((line) => ({ ...line })),
            outputs: recipe.outputs.map((line) => ({ ...line })),
            minutes: recipe.minutes,
        });
    });

    // The site registry — a 1×1 placeholder until setup rebuilds it against
    // the live canvas (the grid dims come from the world, not the options).
    let sites: SiteRegistry = createSiteRegistry({ grid: { width: 1, height: 1 }, blueprints });

    // The world arrives with setup — the plans, effects and hooks read
    // through it
    let world: World | null = null;

    // The plan cursor + the completed ledger (a launched vessel removes its
    // site, so completion is recorded explicitly, not re-derived)
    let projectIndex = 0;
    const completed: string[] = [];

    // The launched vessels, in launch order
    const moored: Vessel[] = [];
    let vesselCounter = 0;

    // The effect subscription (wired in setup, torn down at dispose)
    let unsubscribeEffects: (() => void) | null = null;
    // The behaviour ids THIS plugin registered at setup — dispose drops
    // exactly these (the registries can shrink between setup and dispose: a
    // removed blueprint/recipe would otherwise leave its module queued in
    // the ledger, a stale planner)
    let registered: string[] = [];

    // ── reads ────────────────────────────────────────────────────────────────

    /** The live site the crew serves — the first staged/building site in
     * placement order (one project runs at a time). */
    const activeSite = (): Site | undefined =>
        sites.sites().find((site) => site.state === 'staged' || site.state === 'building');

    /**
     * A site's requirement line still owed, or 0. Reads the SITE's
     * requirement SNAPSHOT (`site.required`, taken at placement) — never the
     * live definition: a blueprint removed or redefined mid-build cannot
     * alter an existing site's staging costs, and the effect's arithmetic
     * stays exactly the arithmetic `sites.deliver` validates against (a
     * definition-read here would over-stage and throw inside the step).
     */
    const remainingOf = (site: Site, item: string): number => {
        const line = site.required.find((candidate) => candidate.item === item);
        return line ? line.count - (site.delivered[item] ?? 0) : 0;
    };

    /** Whether the active site still lacks `item`. */
    const siteNeeds = (item: string): boolean => {
        const site = activeSite();
        return site !== undefined && remainingOf(site, item) > 0;
    };

    /**
     * The site's demand — its unmet requirements expanded through the
     * crafting chains (one lookup per output item; recipes are one level
     * deep, the depth guard is the cycle safety). Deterministic: the
     * requires order drives the walk, first-seen lines accumulate.
     */
    const demandOf = (site: Site): SiteDemand => {
        const demand: SiteDemand = { raw: [], recipes: [] };
        // The first recipe producing each item (registry order — deterministic)
        const recipeByOutput = new Map<string, Recipe>();
        arrayEach(crafting.recipes(), ({ value: recipe }) => {
            arrayEach(recipe.outputs, ({ value: line }) => {
                if (!recipeByOutput.has(line.item)) {
                    recipeByOutput.set(line.item, recipe);
                }
            });
        });
        const resolve = (item: string, count: number, depth: number): void => {
            const recipe = recipeByOutput.get(item);
            if (!recipe || depth > 4) {
                const held = demand.raw.find((candidate) => candidate.item === item);
                if (held) {
                    held.count = held.count + count;
                } else {
                    demand.raw.push({ item, count });
                }
                return;
            }
            const outputLine = recipe.outputs.find((line) => line.item === item) as RecipeLine;
            const runs = Math.ceil(count / outputLine.count);
            const entry = demand.recipes.find((candidate) => candidate.recipe.id === recipe.id);
            if (entry) {
                entry.count = entry.count + runs;
            } else {
                demand.recipes.push({ recipe, count: runs });
            }
            arrayEach(recipe.inputs, ({ value: input }) => {
                resolve(input.item, input.count * runs, depth + 1);
            });
        };
        // THE SITE'S SNAPSHOT drives the walk (`site.required`, taken at
        // placement) — a removed or redefined blueprint never rewrites an
        // existing site's demand; the site record carries the costs. No
        // definition lookup: a removed definition leaves the site workable.
        arrayEach(site.required, ({ value: line }) => {
            const remaining = line.count - (site.delivered[line.item] ?? 0);
            if (remaining > 0) {
                resolve(line.item, remaining, 0);
            }
        });
        return demand;
    };

    /** The site's GATE — the resolved first definition cell, the walkable one. */
    const siteGate = (site: Site): GateSpot | undefined => {
        const cells = sites.cellsOf(site.id);
        const gate = cells?.[0];
        if (!gate || gate.parent.length !== 1) {
            return undefined;
        }
        return { tileX: gate.parent[0].x, tileY: gate.parent[0].y, x: gate.x, y: gate.y };
    };

    /**
     * Whether the body stands on ANY resolved footprint cell — the staging
     * surface. While the site is unbuilt its cells are open ground, so the
     * crew spreads over the whole footprint (a 2-cell shelter stages two
     * workers at once); the walkable GATE is the doorway rule of the
     * COMPLETED structure, not a congestion point during the work.
     */
    const atSite = (entity: { id: string; position: Position3D }, site: Site): boolean => {
        const active = world;
        if (!active) {
            return false;
        }
        const sub = active.subOf(entity.id);
        if (!sub) {
            return false;
        }
        return (sites.cellsOf(site.id) ?? []).some(
            (cell) =>
                cell.parent.length === 1 &&
                entity.position.x === cell.parent[0].x &&
                entity.position.y === cell.parent[0].y &&
                sub.x === cell.x &&
                sub.y === cell.y,
        );
    };

    /**
     * The work spot: the first footprint cell (definition order —
     * deterministic) whose fine spot no OTHER grounded body stands on. The
     * traveller converges on an open cell of the footprint instead of
     * milling forever against an occupied gate. When every cell is taken
     * the gate remains the meeting point.
     */
    const workSpot = (site: Site, selfId: string): GateSpot | undefined => {
        const active = world;
        if (!active) {
            return undefined;
        }
        const cells = sites.cellsOf(site.id) ?? [];
        for (let index = 0; index < cells.length; index++) {
            const cell = cells[index];
            if (cell.parent.length !== 1) {
                continue;
            }
            if (
                !fineSpotTaken(
                    active,
                    selfId,
                    cell.parent[0].x,
                    cell.parent[0].y,
                    cell.x,
                    cell.y,
                )
            ) {
                return { tileX: cell.parent[0].x, tileY: cell.parent[0].y, x: cell.x, y: cell.y };
            }
        }
        return siteGate(site);
    };

    /** Whether the bag holds a requirement line the site still lacks — read
     * off the site's SNAPSHOT (`site.required`), never the live definition. */
    const carryingForSite = (actorId: string, site: Site): boolean => {
        const bag = inventory.of(actorId);
        return (
            site.required.some(
                (line) => (bag[line.item] ?? 0) > 0 && line.count - (site.delivered[line.item] ?? 0) > 0,
            )
        );
    };

    /**
     * The CREW's strongest single bag count of one item — the largest held
     * stack across every sentient bag. The fetch gate reads this because
     * progress needs a FULL batch in ONE bag: a craft consumes its inputs
     * from a single bag and a delivery stages from one bag, so a demand
     * split as 1+1 across two bags satisfies a crew-TOTAL read while
     * NOTHING can ever be crafted or delivered with it (the deadlock the
     * first draft had). The gate shuts once ONE bag holds the full demand
     * — that bag then crafts/delivers it — and the overshoot is bounded by
     * one unit per extra worker (the demand-directed rule: the crew
     * gathers what the site lacks, never a lumber mountain).
     */
    const crewMaxOf = (item: string): number => {
        let max = 0;
        world?.actors.forEach((actor) => {
            max = Math.max(max, inventory.of(actor.id)[item] ?? 0);
        });
        return max;
    };

    /** The site of a blueprint that may be worked on: fully staged ('staged'
     * and ready()) or already open ('building'). */
    const readySiteOf = (blueprintId: string): Site | undefined =>
        sites.sites().find(
            (site) =>
                site.blueprintId === blueprintId &&
                (site.state === 'building' || (site.state === 'staged' && sites.ready(site.id))),
        );

    /**
     * The craft gate's ability unlock — the species' 'craft' ability (the
     * entity profiles' work-kind unlock the building feature reads). Without
     * profiles every hand may work (the pre-entity behavior).
     */
    const mayCraft = (type: string | undefined): boolean =>
        !profiles || (type !== undefined && profiles.hasAbility(type, 'craft'));

    // ── the plan cursor: place or advance ────────────────────────────────────

    /**
     * One plan-cursor pass: advances past completed projects, then places
     * the current project's site when nothing is live. The placement scan
     * ranks the land cells by centrality (deterministic — ties keep the
     * row-major order), vessels requiring a beach tile, and places on the
     * FIRST tile the shared registry accepts (the hooks veto water,
     * occupied fine spots and standing bodies).
     */
    const placeOrAdvance = (): void => {
        for (;;) {
            const blueprint = PLAN_ORDER[projectIndex];
            if (blueprint === undefined) {
                // Every stock structure stands — the plan is spent
                return;
            }
            if (completed.includes(blueprint)) {
                projectIndex = projectIndex + 1;
                continue;
            }
            if (sites.sitesOfBlueprint(blueprint).some((site) => site.state === 'built')) {
                // The project finished while the cursor waited on it
                completed.push(blueprint);
                projectIndex = projectIndex + 1;
                continue;
            }
            // A REMOVED definition can never be placed again — the registry's
            // conflicts()/place() throw "unknown blueprint" on it (a caller
            // bug there, a stuck planner here). The cursor skips the project:
            // the god removed the plan, the crew moves on. NEW placements
            // always resolve through the LIVE definition (a redefined
            // blueprint's new requirements apply from the next site on).
            if (!blueprints.has(blueprint)) {
                projectIndex = projectIndex + 1;
                continue;
            }
            break;
        }
        const blueprint = PLAN_ORDER[projectIndex] as string;
        if (activeSite() !== undefined) {
            // A crew is already serving a live site (never two at once)
            return;
        }
        // The placement scan — row-major land cells, anchor at the tile's
        // center fine cell. The anchor sits at the grid's exact middle, so
        // the stock footprints (±1 offsets) never wrap across the world's
        // edge: every resolved cell lands on the anchor tile or an immediate
        // neighbour. Vessels moor on BEACH tiles (the shore the launch reads);
        // the land structures stand on the first feasible dry tile.
        const active = world;
        if (!active) {
            return;
        }
        const cells = active.landCells();
        const shoreOnly = VESSEL_BLUEPRINTS.includes(blueprint);
        // The scan prefers the island's INTERIOR: land cells ranked by how
        // close they sit to the canvas middle (Chebyshev), ties keeping the
        // row-major order — the crew's hauling trips stay short for the
        // whole campaign. Vessels moor on BEACH tiles WITH a water
        // neighbour (the mooring the launch needs must exist where the
        // hull is built); the land structures stand on the first feasible
        // dry tile.
        const halfX = (active.canvas.width - 1) / 2;
        const halfY = (active.canvas.height - 1) / 2;
        const centrality = (cell: { x: number; y: number }): number =>
            Math.max(Math.abs(cell.x) / halfX, Math.abs(cell.y) / halfY);
        const mooring = (cell: { x: number; y: number }): boolean =>
            [
                { x: cell.x - 1, y: cell.y },
                { x: cell.x + 1, y: cell.y },
                { x: cell.x, y: cell.y - 1 },
                { x: cell.x, y: cell.y + 1 },
            ].some((neighbor) => {
                const neighborCell = active.cellAt(neighbor.x, neighbor.y);
                return neighborCell !== undefined && !neighborCell.passable;
            });
        const ranked = cells
            .filter((cell) => !shoreOnly || (cell.biome === 'beach' && mooring(cell)))
            .sort((left, right) => centrality(left) - centrality(right));
        for (let index = 0; index < ranked.length; index++) {
            const cell = ranked[index];
            const spec: SiteSpec = {
                blueprintId: blueprint,
                parent: [{ x: cell.x, y: cell.y }],
                anchor: { x: 0, y: 0 },
            };
            // The registry's own pre-check: hooks + occupancy + self-overlap
            if (sites.conflicts(spec).length === 0) {
                sites.place(spec);
                // ONE placement per pass — the next project waits its turn
                break;
            }
        }
    };

    // ── the shelter's survival use ───────────────────────────────────────────

    /**
     * The rest bonus sweep: a body whose head task is a sleep or a rest AND
     * that stands on a BUILT roofed structure's gate recovers energy faster
     * — the sheltered night is the safe night. Registry castaways first,
     * then the coordinate-space creatures (the sleep plugin's sweep order).
     */
    const shelterRest = (): void => {
        const active = world;
        if (!active) {
            return;
        }
        // The built roofed gates — usually zero or one
        const gates: GateSpot[] = [];
        arrayEach(sites.sites(), ({ value: site }) => {
            if (site.state === 'built' && ROOFED_BLUEPRINTS.includes(site.blueprintId)) {
                const gate = siteGate(site);
                if (gate) {
                    gates.push(gate);
                }
            }
        });
        if (gates.length === 0) {
            return;
        }
        const sheltered = (id: string, position: Position3D): boolean => {
            const sub = active.subOf(id);
            if (!sub) {
                return false;
            }
            return gates.some(
                (gate) =>
                    gate.tileX === position.x &&
                    gate.tileY === position.y &&
                    gate.x === sub.x &&
                    gate.y === sub.y,
            );
        };
        const seen = new Set<string>();
        active.actors.forEach((actor) => {
            seen.add(actor.id);
            const task = tasks.taskOf(actor.id);
            if ((task?.kind === 'sleep' || task?.kind === 'rest') && sheltered(actor.id, actor.position)) {
                needs.satisfy(actor.id, { energy: SHELTER_REST_PER_MINUTE });
            }
        });
        active.coordinates.all().forEach((entry) => {
            if (seen.has(entry.id)) {
                return;
            }
            seen.add(entry.id);
            const task = tasks.taskOf(entry.id);
            if ((task?.kind === 'sleep' || task?.kind === 'rest') && sheltered(entry.id, entry.position)) {
                needs.satisfy(entry.id, { energy: SHELTER_REST_PER_MINUTE });
            }
        });
    };

    // ── the plugin ───────────────────────────────────────────────────────────

    return {
        id: 'construction',
        label: 'Construction',

        blueprints,

        crafting,

        get sites() {
            return sites;
        },

        activeSite: () => activeSite(),

        project: () => PLAN_ORDER[projectIndex],

        completedBlueprints: () => [...completed],

        vessels: () => [...moored],

        launch: (siteId) => {
            const active = world;
            if (!active) {
                return undefined;
            }
            const site = sites.siteOf(siteId);
            if (!site || site.state !== 'built' || !VESSEL_BLUEPRINTS.includes(site.blueprintId)) {
                return undefined;
            }
            // THE MOORING — the launch needs water beside the shore tile the
            // vessel was built on; a hull built inland cannot reach the sea
            const anchor = site.parent[0];
            const waterNeighbors: Array<{ x: number; y: number }> = [];
            arrayEach(
                [
                    { x: anchor.x - 1, y: anchor.y },
                    { x: anchor.x + 1, y: anchor.y },
                    { x: anchor.x, y: anchor.y - 1 },
                    { x: anchor.x, y: anchor.y + 1 },
                ],
                ({ value: neighbor }) => {
                    const cell = active.cellAt(neighbor.x, neighbor.y);
                    if (cell && !cell.passable) {
                        waterNeighbors.push(neighbor);
                    }
                },
            );
            if (waterNeighbors.length === 0) {
                return undefined;
            }
            // The vessel leaves the shore: the site record is dropped (its
            // cells free — the beach is a beach again) and the concrete
            // output lives on as the moored vessel
            sites.remove(siteId);
            if (!completed.includes(site.blueprintId)) {
                completed.push(site.blueprintId);
            }
            vesselCounter = vesselCounter + 1;
            const definition = blueprints.definitionOf(site.blueprintId);
            const vessel: Vessel = {
                id: `v-${vesselCounter}`,
                siteId,
                blueprintId: site.blueprintId,
                label: definition?.label ?? site.blueprintId,
                x: anchor.x,
                y: anchor.y,
                launchedAt: active.ticker.elapsed(),
            };
            moored.push(vessel);
            active.events.emit({
                kind: 'launch',
                message: `The ${vessel.label.toLowerCase()} is launched into the water at (${anchor.x}, ${anchor.y}).`,
            });
            return vessel;
        },

        setup: (context) => {
            const active = context.world;
            world = active;

            // The site registry rebuilds against the LIVE canvas — the grid
            // is the sub-grid dims the whole zoom ladder shares (the
            // recursion rule), so one configuration addresses the island
            // tiles (parent paths of length 1) and their scale-0 interiors.
            sites = createSiteRegistry({
                grid: { width: active.canvas.width, height: active.canvas.height },
                blueprints,
                hooks: {
                    // INSIDE — the island builds scale-0 sites on island
                    // tiles only: a length-1 parent path whose tile exists
                    inside: (parent, scale) =>
                        parent.length === 1 &&
                        scale === 0 &&
                        active.cellAt(parent[0].x, parent[0].y) !== undefined,
                    // CLEARANCE — every footprint cell needs dry land and no
                    // grounded body standing on the fine spot (nobody is
                    // ever sealed inside a footprint at placement)
                    clearance: (cell: SiteCell) => {
                        const tile = active.cellAt(cell.parent[0].x, cell.parent[0].y);
                        if (!tile || !tile.passable) {
                            return false;
                        }
                        // The Scale-0 occupancy scan (fineMovement) — the
                        // sentinel selfId matches no living body
                        return !fineSpotTaken(
                            active,
                            'site-placement-scan',
                            cell.parent[0].x,
                            cell.parent[0].y,
                            cell.x,
                            cell.y,
                        );
                    },
                },
            });

            // The world's structure hook — COMPLETED footprints wall their
            // cells off (the gate excepted); fineSpotTaken reads it for
            // every destination step
            active.structures = {
                blocksFineSpot: (tileX, tileY, sx, sy) =>
                    sites
                        .sites()
                        .filter((site) => site.state === 'built')
                        .some((site) => {
                            const cells = sites.cellsOf(site.id) ?? [];
                            if (cells.length === 0) {
                                return false;
                            }
                            const gateKey = siteCellKey(cells[0]);
                            return cells.some(
                                (cell) =>
                                    cell.parent.length === 1 &&
                                    cell.parent[0].x === tileX &&
                                    cell.parent[0].y === tileY &&
                                    cell.x === sx &&
                                    cell.y === sy &&
                                    siteCellKey(cell) !== gateKey,
                            );
                        }),
            };

        // The rungs register into the tasks ledger at setup — the craft and
        // build rungs are composed FROM the core's stock behaviour
        // factories (craftTaskBehaviour / buildTaskBehaviour / the
        // gatherTaskBehaviour fetches) with the island gates layered on
        // top; the deliver and materials rungs are the island's own
        // (staging at the footprint + wood felling + the treks).

            //
            // DELIVER 24 — the bag holds a material the site still lacks:
            // haul it to the gate and stage it. One minute at the gate per
            // task; the trips are the progressive delivery (a house's 12
            // units ride several 8-unit loads).
            registered.push('deliver');
            tasks.behaviour({
                id: 'deliver',
                label: 'Deliver',
                priority: DELIVER_PRIORITY,
                appliesTo: (subject) => {
                    if (subject.actor.kind === 'creature') {
                        return false;
                    }
                    const site = activeSite();
                    return site !== undefined && site.state === 'staged' && carryingForSite(subject.actor.id, site);
                },
                plan: (subject) => {
                    const active = world;
                    const site = activeSite();
                    const actor = subject.actor;
                    if (!active || !site || site.state !== 'staged') {
                        return undefined;
                    }
                    // Standing anywhere on the footprint — the staging is the
                    // task (the effect applies it, revalidated, on completion)
                    if (atSite(actor, site)) {
                        return {
                            kind: 'deliver',
                            label: 'delivers materials',
                            minutes: DELIVER_MINUTES,
                            payload: { siteId: site.id },
                        };
                    }
                    // One fine step toward an OPEN cell of the footprint (the
                    // fine-targeted twin of the treks — the staging happens on
                    // exact subtile spots, and a taken cell would mill the
                    // hauler forever against it)
                    const spot = workSpot(site, actor.id);
                    if (!spot) {
                        return undefined;
                    }
                    const step = fineTargetStep(
                        active,
                        actor,
                        { x: spot.tileX, y: spot.tileY },
                        { x: spot.x, y: spot.y },
                    );
                    if (!step) {
                        return undefined;
                    }
                    return {
                        kind: 'move',
                        label: 'hauls materials',
                        minutes: travel,
                        payload: { dx: step[0], dy: step[1] },
                    };
                },
            });

            // CRAFT 23 — one module per island recipe, each composed FROM the
            // core's stock craft factory (the plan and the ingredient gate
            // are the factory's; the island layers the sentient + demand +
            // bag-room gates on top).
            arrayEach(crafting.recipes(), ({ value: recipe }) => {
                const output = recipe.outputs[0];
                const factory = craftTaskBehaviour<TaskSubject>({
                    id: `craft-${recipe.id}`,
                    label: `crafts ${output.item}`,
                    // The rung priority rides the factory (the composed module
                    // spreads it — the craft rungs sit above social, below rest)
                    priority: CRAFT_PRIORITY,
                    recipe: recipe.id,
                    inputs: recipe.inputs.map((line) => ({ item: line.item, count: line.count })),
                    minutes: Math.max(1, recipe.minutes),
                    // The factory's ingredient gate reads the LIVE bag
                    stockOf: (subject) => inventory.of(subject.actor.id),
                });
                const composed: TaskBehaviour = {
                    ...factory,
                    appliesTo: (subject) => {
                        if (subject.actor.kind === 'creature') {
                            return false;
                        }
                        // The craft ABILITY unlock — the species profile's
                        // work-kind gate ('craft', plugins/entity)
                        if (!mayCraft(subject.actor.type)) {
                            return false;
                        }
                        // The site still lacks this recipe's output…
                        if (!siteNeeds(output.item)) {
                            return false;
                        }
                        // …the finished goods fit the bag (the atomic craft
                        // would refuse a wedged bag at completion — the gate
                        // refuses it before the minutes are spent)…
                        if (
                            inventoryTotal(inventory.of(subject.actor.id)) + output.count >
                            inventory.capacityOf(subject.actor.id)
                        ) {
                            return false;
                        }
                        // …and the factory's own ingredient gate passes
                        return factory.appliesTo ? factory.appliesTo(subject) : true;
                    },
                };
                registered.push(`craft-${recipe.id}`);
                tasks.behaviour(composed);
            });

            // THE UNDERFOOT FETCHES — one module per cell-taken raw material,
            // each composed FROM the core's stock gather factory (the plan
            // and the payload are the factory's: kind 'gather' with the item
            // id; the behavior plugin's gather effect takes the named item
            // off the cell). Registered BEFORE the materials module — at the
            // same priority the ledger consults registration order first, so
            // an underfoot fetch wins the minute and the materials module
            // handles only the wood felling and the treks.
            arrayEach([...TAKEN_MATERIALS], ({ value: item }) => {
                const factory = gatherTaskBehaviour<TaskSubject>({
                    id: `fetch-${item}`,
                    label: `takes ${item}`,
                    item,
                    minutes: TAKE_MINUTES,
                });
                const composed: TaskBehaviour = {
                    ...factory,
                    priority: MATERIALS_PRIORITY,
                    appliesTo: (subject) => {
                        if (subject.actor.kind === 'creature') {
                            return false;
                        }
                        const site = activeSite();
                        if (!site) {
                            return false;
                        }
                        // The demand gate: the site still lacks the item AND
                        // no single bag can already use what the site needs
                        const demand = demandOf(site).raw.find((line) => line.item === item);
                        if (!demand || crewMaxOf(item) >= demand.count) {
                            return false;
                        }
                        // THE BAG ROOM GATE — a full hand fetches nothing
                        if (inventoryTotal(inventory.of(subject.actor.id)) >= inventory.capacityOf(subject.actor.id)) {
                            return false;
                        }
                        // THE MINE GATE — stone demands the species' mine
                        // ability (the take would silently refuse it)
                        if (MINED_ITEMS.includes(item) && profiles && !profiles.hasAbility(subject.actor.type ?? '', 'mine')) {
                            return false;
                        }
                        // THE item must stand underfoot — otherwise the
                        // materials module travels toward it
                        return (
                            (inventory.cellStock(subject.actor.position.x, subject.actor.position.y)[item] ?? 0) > 0
                        );
                    },
                };
                registered.push(`fetch-${item}`);
                tasks.behaviour(composed);
            });

            // MATERIALS 22 — the demand-directed fetch: only what the site's
            // staging still lacks AND no single bag can already use, so
            // nobody wedges their bag full of lumber the site stopped
            // needing. Wood is felled off the trees (the harvest); every
            // other raw material is either taken underfoot (the fetch
            // modules above) or travelled toward.
            registered.push('materials');
            tasks.behaviour({
                id: 'materials',
                label: 'Materials',
                priority: MATERIALS_PRIORITY,
                appliesTo: (subject) => {
                    if (subject.actor.kind === 'creature') {
                        return false;
                    }
                    const site = activeSite();
                    if (!site) {
                        return false;
                    }
                    const bag = inventory.of(subject.actor.id);
                    // THE BAG ROOM GATE — a full hand fetches nothing
                    if (inventoryTotal(bag) >= inventory.capacityOf(subject.actor.id)) {
                        return false;
                    }
                    // A raw fetch no single bag can already use (the
                    // strongest bag still lacks the full demand)
                    return demandOf(site).raw.some(
                        (line) => crewMaxOf(line.item) < line.count,
                    );
                },
                plan: (subject) => {
                    const active = world;
                    const site = activeSite();
                    const actor = subject.actor;
                    if (!active || !site) {
                        return undefined;
                    }
                    const line = demandOf(site).raw.find(
                        (candidate) => crewMaxOf(candidate.item) < candidate.count,
                    );
                    if (!line) {
                        return undefined;
                    }
                    // WOOD is felled off the trees — a standing tree
                    // underfoot is the task (the harvest converts one tree
                    // deposit into one wood item, atomically)
                    if (line.item === 'wood') {
                        const stock = inventory.cellStock(actor.position.x, actor.position.y);
                        if ((stock.tree ?? 0) > 0) {
                            return { kind: 'fell', label: 'fells a tree', minutes: FELL_MINUTES };
                        }
                        const grove = nearestCell(actor, inventory.cellsWithItem('tree'));
                        if (!grove) {
                            return undefined;
                        }
                        return travelSpec(active, actor, 'seeks wood', grove, travel);
                    }
                    // Every other raw material is taken off the cell it
                    // stands on (the take revalidates capacity + the mine
                    // gate at completion)
                    const stock = inventory.cellStock(actor.position.x, actor.position.y);
                    if ((stock[line.item] ?? 0) > 0) {
                        if (
                            MINED_ITEMS.includes(line.item) &&
                            profiles &&
                            !profiles.hasAbility(actor.type ?? '', 'mine')
                        ) {
                            return undefined;
                        }
                        return {
                            kind: 'collect',
                            label: `takes ${line.item}`,
                            minutes: TAKE_MINUTES,
                            payload: { itemId: line.item },
                        };
                    }
                    const source = nearestCell(actor, inventory.cellsWithItem(line.item));
                    if (!source) {
                        return undefined;
                    }
                    return travelSpec(active, actor, `seeks ${line.item}`, source, travel);
                },
            });

            // BUILD 21 — one module per blueprint, each composed FROM the
            // core's stock build factory (the plan and the site-read payload
            // are the factory's; the island layers the sentient + ready +
            // at-the-gate gates on top). Work stages ONE world minute per
            // task (the shared registry's per-minute workOn).
            arrayEach(blueprints.blueprints(), ({ value: definition }) => {
                const factory = buildTaskBehaviour<TaskSubject>({
                    id: `build-${definition.id}`,
                    label: `builds ${definition.label.toLowerCase()}`,
                    // The rung priority rides the factory (the composed module
                    // spreads it — the build rungs sit above social, below rest)
                    priority: BUILD_PRIORITY,
                    blueprint: definition.id,
                    // The injected site read — the factory's payload carries
                    // the work site's tile position ('to')
                    site: () => {
                        const site = readySiteOf(definition.id);
                        const gate = site ? siteGate(site) : undefined;
                        return gate ? position3(gate.tileX, gate.tileY) : undefined;
                    },
                    minutes: BUILD_MINUTES,
                });
                const composed: TaskBehaviour = {
                    ...factory,
                    appliesTo: (subject) =>
                        subject.actor.kind !== 'creature' &&
                        mayCraft(subject.actor.type) &&
                        readySiteOf(definition.id) !== undefined,
                    plan: (subject) => {
                        const active = world;
                        const site = readySiteOf(definition.id);
                        if (!active || !site) {
                            return undefined;
                        }
                        // Standing anywhere on the footprint — the factory's
                        // one-minute build stage is the task
                        if (atSite(subject.actor, site)) {
                            return factory.plan?.(subject);
                        }
                        // Walk to an open cell of the footprint first — the
                        // work happens ON the structure's cells (the taken
                        // ones are skipped, the gate the fallback)
                        const spot = workSpot(site, subject.actor.id);
                        if (!spot) {
                            return undefined;
                        }
                        const step = fineTargetStep(
                            active,
                            subject.actor,
                            { x: spot.tileX, y: spot.tileY },
                            { x: spot.x, y: spot.y },
                        );
                        if (!step) {
                            return undefined;
                        }
                        return {
                            kind: 'move',
                            label: `heads to the ${definition.label.toLowerCase()}`,
                            minutes: travel,
                            payload: { dx: step[0], dy: step[1] },
                        };
                    },
                };
                registered.push(`build-${definition.id}`);
                tasks.behaviour(composed);
            });

            // ── the construction effects: what each completed kind DOES ────
            unsubscribeEffects = tasks.ledger.onComplete((task) => {
                const active = world;
                if (!active) {
                    return;
                }
                // Construction work is SENTIENT — the registry holds every
                // body that queues these kinds; a despawned worker's effect
                // is dropped
                const actor = active.actors.get(task.actorId);
                if (!actor) {
                    return;
                }
                switch (task.kind) {
                    case 'craft': {
                        const recipeId = task.payload?.recipe;
                        if (typeof recipeId !== 'string') {
                            return;
                        }
                        // THE ATOMIC CRAFT — the registry validates the whole
                        // operation against the bag BEFORE anything changes:
                        // a moved/short stock loses nothing (the outcome is
                        // discarded, the minutes were the cost)
                        const bag = inventory.of(actor.id);
                        const outcome = crafting.craft(recipeId, bag);
                        if (!outcome.ok) {
                            return;
                        }
                        // Capacity revalidated: a yield that would not fit is
                        // discarded with the outcome (no conjured overflow)
                        if (inventoryTotal(outcome.stock) > inventory.capacityOf(actor.id)) {
                            return;
                        }
                        // The bag record is swapped in place — inventory.of
                        // keeps returning the same record the world reads
                        Object.keys(bag).forEach((key) => {
                            delete bag[key];
                        });
                        Object.entries(outcome.stock).forEach(([item, count]) => {
                            bag[item] = count;
                        });
                        return;
                    }
                    case 'fell': {
                        // Tree → wood, atomically (the harvest revalidates
                        // the standing tree and the bag room; a tree felled
                        // by a co-worker during the wait means the harvest
                        // silently fails — the worker re-plans next minute)
                        inventory.harvest(actor, 'tree', 'wood');
                        return;
                    }
                    case 'deliver': {
                        const siteId = task.payload?.siteId;
                        if (typeof siteId !== 'string') {
                            return;
                        }
                        const site = sites.siteOf(siteId);
                        // The site must still be taking deliveries (a
                        // co-worker may have finished the staging during the
                        // wait — the leftovers stay in the bag) and the
                        // worker must still be ON the footprint (a task
                        // never applies from a spot it did not plan from)
                        if (!site || site.state !== 'staged' || !atSite(actor, site)) {
                            return;
                        }
                        // THE SNAPSHOT ARITHMETIC — the staging walks the
                        // SITE's requirement snapshot (`site.required`, taken
                        // at placement), the exact lines `sites.deliver`
                        // validates against. Reading the live definition
                        // instead would let a mid-build remove+redefine
                        // stage past the snapshot and throw "over-staged"
                        // inside the world step (the reviewer's repro). With
                        // the snapshot read the take is capped at the same
                        // remaining the registry enforces — the deliver can
                        // never throw, the subtraction is exact and no item
                        // is conjured or lost.
                        const bag = inventory.of(actor.id);
                        arrayEach(site.required, ({ value: line }) => {
                            const remaining = line.count - (site.delivered[line.item] ?? 0);
                            if (remaining <= 0) {
                                return;
                            }
                            const take = Math.min(bag[line.item] ?? 0, remaining);
                            if (take <= 0) {
                                return;
                            }
                            // The registry validates the staging against the
                            // same snapshot (capped exactly at the
                            // requirement — no over-staging)
                            const updated = sites.deliver(site.id, line.item, take);
                            if (!updated) {
                                return;
                            }
                            inventoryRemove(bag, line.item, take);
                        });
                        return;
                    }
                    case 'build': {
                        const blueprintId = task.payload?.blueprint;
                        if (typeof blueprintId !== 'string') {
                            return;
                        }
                        const site = readySiteOf(blueprintId);
                        // The work revalidates: the site is still workable
                        // and the builder still stands on its footprint
                        if (!site || !atSite(actor, site)) {
                            return;
                        }
                        // ONE world minute of work per completed task — the
                        // per-minute stage the shared registry accrues
                        sites.workOn(site.id, BUILD_MINUTES);
                        return;
                    }
                    default:
                        // Other kinds belong to their own plugins
                        return;
                }
            });
        },

        dispose: () => {
            // The effect subscription goes with the environment — a swapped
            // out construction plugin must not keep staging into the world
            unsubscribeEffects?.();
            unsubscribeEffects = null;
            // Drop the rungs and cancel their queued tasks (the ledger's
            // update-on-remove rule) — the cast falls back to the wider
            // behaviour ladder immediately. The EXACT registration list is
            // dropped, not a re-derivation from the registries: a blueprint
            // or recipe removed between setup and dispose would otherwise
            // leave its rung queued in the ledger (a stale planner).
            arrayEach(registered, ({ value: id }) => {
                tasks.dropBehaviour(id);
            });
            registered = [];
            // The structure hook comes off the world — the fine ground is
            // all free again
            if (world) {
                world.structures = null;
            }
            // The sites go with the environment (the plan cursor restarts)
            sites.clear();
            moored.length = 0;
            completed.length = 0;
            projectIndex = 0;
            vesselCounter = 0;
            world = null;
        },

        tick: () => {
            // The plan cursor (place the next project / advance past a
            // finished one), then the sheltered-sleep bonus sweep
            placeOrAdvance();
            shelterRest();
        },
    };
};
