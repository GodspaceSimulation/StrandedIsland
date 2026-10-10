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
//   shelter → raft → house → boat → quarry → furnace → fort
// The tick places the current project's site (a feasible dry-land scan
// ranked by what the structure WANTS — R1 priority-aware siting: homes near
// water/food/camp, the fort on defensible rock near its assets, the quarry
// on the highland gravel bedrock, vessels on a beach with a sea mooring)
// when nothing is live, and advances the cursor when the project's site
// stands BUILT.
//
// THE MATERIAL ANATOMY (T3 R3/R4, plugins/construction/structureModel.ts) —
// a BUILT structure stands with material SECTIONS (wood/thatch/stone/brick)
// that WEAR with time and never heal on their own (dead material — the
// living woods regrow wood biologically, a wall does not). The crew keeps
// them sound: maintenance ORDERS (auto-opened at the wear trigger, or god-
// ordered) stage the section's own material onto the footprint and work it
// back, one world-minute stage at a time. Sections upgrade one rung up the
// ladder wood → stone → brick — and BRICK only comes from a real kiln: the
// brick craft is gated on a BUILT furnace. The quarry, once built, opens
// the gravel bedrock under its highland tile (the stone the fort's walls
// and the furnace need — the surface rock alone never fed them).
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
//                take it underfoot (R6: the fetch is a 1-minute BEAT on the
//                tile's shared gather job for that material — the
//                plugins/tasks/gatherWork ledger, one job per tile per
//                resource, the take pays on the atomic claim), fell a tree
//                for wood, or travel toward the nearest stocked cell.
//   build   21 — the site is fully staged → stand on its footprint and
//                work one world-minute per task (the shared site
//                registry's per-minute workOn stages).
//   maintain 15 — a BUILT structure's open maintenance order (repair or
//                upgrade): fetch the order's material (the underfoot beat,
//                the trek, or BRICK fired at a built furnace), haul it to
//                the footprint and stage it, then work the order one
//                world-minute stage at a time. Below the live projects —
//                finished structures are mended after the plan is served.
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
// restore) AND mends its wounds (+0.1 health per minute while wounded and
// not severely deprived — R3 healing, no invulnerability: bites still land
// and starvation still wounds): the sheltered night is the safe night. The
// built roofed gates are published through the SHELTER SERVICE —
// `shelters()` — the clean lookup the sleep plugin treks to at bedtime
// (the scenario wires sleep's deferred `shelters` provider to this method).
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
    subTileStep,
    tileWorkKey,
    type Position3D,
    type TileCoord,
    type WorldPlugin,
} from '@godspace/core';
import { CHOP_WORK_KIND } from '../lumber/lumberPlugin';
import { openGatherJob } from '../tasks/gatherWork';
import {
    createBlueprintRegistry,
    createSiteRegistry,
    shiftPath,
    siteCellKey,
    type BlueprintRegistry,
    type BlueprintRequirement,
    type BlueprintSpec,
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
import type { Actor, TerrainCell } from '../../engine/types';
import { isFreshBasin, isSeaWater } from '../../engine/types';
import type { InventoryPlugin } from '../inventory/inventoryPlugin';
import type { NeedsPlugin } from '../needs/needsPlugin';
import type { EntityProfiles } from '../entity/entityPlugin';
import type { TasksPlugin } from '../tasks/tasksPlugin';
import type { TaskBehaviour, TaskEntity, TaskSpec, TaskSubject } from '../tasks/taskLedger';
import { inventoryRemove } from '../inventory/inventory';
import { itemWeight, inventoryWeight } from '../inventory/items';
import { materials, MINED_ITEMS } from '../inventory/items';
import {
    mendTool,
    toolDurabilityViews,
    toolMendDue,
    TOOL_REPAIR_MATERIAL,
    TOOL_REPAIR_WORK,
    useTool,
} from '../inventory/toolDurability';
import { fineSpotTaken, fineTargetStep, nearestCell, travelSpec, type FineMover } from '../movement/fineMovement';
import {
    footprintIsDry,
    footprintTouchesSeaWater,
    spiralAnchors,
    type FineTerrainResolver,
} from './fineSiting';
// Type-only coupling — the resolver reads the terrain plugin's cellFor/depth
// surface through the roster lookup (no runtime dependency, no wiring edit)
import type { IslandTerrainPlugin } from '../terrain/islandTerrain';
import {
    createSections,
    repairPrice,
    sectionHealth,
    upgradeCost,
    REPAIR_TRIGGER,
    SECTION_MAX_HEALTH,
    UPGRADE_LADDER,
    type SectionTier,
    type StructureSection,
} from './structureModel';

// ── The island's buildable plan ──────────────────────────────────────────────

/**
 * The build order — one blueprint at a time, the shelter first (the
 * first night's cover), the escape craft next, then the long homes. The
 * boat needs cloth (frond-woven) and the fort needs mined stone, so they
 * sit late in the order where their supply chains have had time to run.
 * R3 — the QUARRY comes before the furnace and the fort: the fort's walls
 * (1920 stone) and the furnace's body (120 stone) can only be fed once the
 * quarry has opened the highland bedrock (the surface rock is a handful).
 */
export const PLAN_ORDER: readonly string[] = ['shelter', 'raft', 'house', 'boat', 'quarry', 'furnace', 'fort'];

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
    // R4 — the early hand tools, crafted from the raw island materials the
    // crew gathers from the first minutes (one log + a flint-knapped stone
    // edge for the axe; a couple of hafted boards for the hammer). They are
    // DULABLE (the catalog's 'tool' kind, never stacked) and the construction
    // plugin's tool-craft rung (below) builds them ONCE per tool before the
    // long build projects, so the crew works with real equipment early.
    { id: 'axe', label: 'Axe', kind: 'tool', inputs: [{ item: 'wood', count: 1 }, { item: 'stone', count: 1 }], outputs: [{ item: 'axe', count: 1 }], minutes: 5 },
    { id: 'hammer', label: 'Hammer', kind: 'tool', inputs: [{ item: 'wood', count: 2 }], outputs: [{ item: 'hammer', count: 1 }], minutes: 5 },
    // R3 — BRICK: sand packed around stone and FIRED. The recipe exists for
    // everyone to read, but the firing only happens at a BUILT furnace — the
    // maintain rung's brick path carries the inputs to the kiln and crafts
    // beside it (no kiln, no brick). Brick is what upgrades a stone section
    // to brick; nothing stages brick for a site (no blueprint requires it),
    // so the generic craft rung never plans it.
    { id: 'brick', label: 'Brick', kind: 'part', inputs: [{ item: 'sand', count: 2 }, { item: 'stone', count: 1 }], outputs: [{ item: 'brick', count: 1 }], minutes: 5 },
];

/**
 * R4 — the EARLY TOOLS the crew crafts before the long build projects: the
 * axe (a wood chop) and the hammer (the build work). Each is crafted ONCE —
 * the tool-craft rung below gates on "no crew carries this tool yet." The
 * axe speeds the lumber chop (plugins/lumber reads the bag); the hammer is
 * the build work's durable equipment (a minimal, low-pacing effect so the
 * plan cursor's site placement pins stay stable).
 */
export const TOOL_RECIPE_IDS: readonly string[] = ['axe', 'hammer'];

/**
 * R5/R6 — THE ISLAND'S WORK COSTS: the construction-time WORK-MINUTES each
 * stock blueprint demands, re-priced from the generic @godspace/blueprint
 * stock values (shelter 10 / house 40 / fort 120 / raft 30 / boat 60) onto
 * the island's own time scale — a shelter is a few hours of honest labor
 * (240), a house THREE DAYS (4320), and the long projects scale between
 * them. The overrides are ISLAND-LOCAL: the shared package's stock specs
 * stay untouched for every other distribution. They apply to the plugin's
 * OWN registry instance (remove + define — `define` throws on a collision),
 * so every NEW site placed here snapshots the island cost (`site.cost` at
 * placement, @godspace/blueprint site/index.ts) while existing sites keep
 * theirs — the same snapshot rule the staging costs already ride.
 */
export const ISLAND_BLUEPRINT_WORK: Record<string, number> = {
    shelter: 240, // 4 hours
    raft: 480, // 8 hours
    house: 4320, // 3 days
    boat: 1440, // 1 day
    quarry: 480, // 8 hours
    furnace: 240, // 4 hours
    fort: 2880, // 2 days
};

/**
 * R2 — THE MATERIAL-TO-WORK LAW: every blueprint's staged material UNITS
 * sum EXACTLY to its work minutes — one unit of material, one minute of
 * honest labor (no divisor, no scaling shortcut). The staging totals below
 * are the literal work totals: a 4320-minute house stands on 4320 units
 * (1440 wood + 1440 plank + 1440 thatch), and every one of those units is
 * genuinely gathered, carried, staged and consumed. These requires REPLACE
 * the stock registry's token counts (shelter 2+2, raft 4+2, house 4+4+4,
 * boat 6+4+2, fort 8+4) on the island's own registry instance — the same
 * island-local remove + define pass as the work re-pricing above.
 */
export const ISLAND_BLUEPRINT_REQUIRES: Record<string, BlueprintRequirement[]> = {
    shelter: [{ item: 'wood', count: 120 }, { item: 'thatch', count: 120 }], // 240
    raft: [{ item: 'wood', count: 320 }, { item: 'rope', count: 160 }], // 480
    house: [{ item: 'wood', count: 1440 }, { item: 'plank', count: 1440 }, { item: 'thatch', count: 1440 }], // 4320
    boat: [{ item: 'plank', count: 720 }, { item: 'rope', count: 480 }, { item: 'cloth', count: 240 }], // 1440
    fort: [{ item: 'stone', count: 1920 }, { item: 'wood', count: 960 }], // 2880
};

/**
 * R3 — the island's OWN blueprints (not stock shapes): the QUARRY and the
 * FURNACE the upgrade ladder is gated on. The quarry is a two-cell cut on
 * the highland rock; once BUILT it opens the gravel bedrock under its tile
 * (QUARRY_STONE_YIELD — the stone economy's only real source). The furnace
 * is a one-cell kiln of stone; once BUILT it is where sand + stone are
 * fired into BRICK — no kiln, no brick (the craft gate). Their requires
 * obey the material-to-work law too (480 and 240 units).
 */
export const ISLAND_BLUEPRINTS: readonly BlueprintSpec[] = [
    {
        id: 'quarry',
        label: 'Quarry',
        cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
        requires: [{ item: 'wood', count: 240 }, { item: 'sand', count: 240 }],
        work: 480,
    },
    {
        id: 'furnace',
        label: 'Furnace',
        cells: [{ x: 0, y: 0 }],
        requires: [{ item: 'stone', count: 120 }, { item: 'sand', count: 120 }],
        work: 240,
    },
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
    quarry: '⛏️',
    furnace: '🔥',
};

/** The construction rung priorities — between rest (25) and social (20). */
const DELIVER_PRIORITY = 24;
const CRAFT_PRIORITY = 23;
const MATERIALS_PRIORITY = 22;
const BUILD_PRIORITY = 21;
/** R4 — the upkeep rung sits below the live projects (21) and social (20),
 * above the lumber chop (10): finished structures are mended only after
 * the plan's own staging and work are served. */
const MAINTAIN_PRIORITY = 15;
/** R3 — the hand tools' mend rung: below the structure upkeep (15), above
 * the lumber chop (10) — a worn tool is mended in idle gaps, before break. */
const MEND_PRIORITY = 14;

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
/**
 * R3 — health points per world minute a sheltered SLEEPER/RESTER mends on a
 * built roofed gate (the shelter's healing). Gated: only while the body is
 * not severely deprived (both belly pressures under the 90 critical line —
 * no healing through starvation, the needs plugin's deficit drains stay the
 * only movement then) and below the full reservoir. Over a 480-minute
 * sheltered night this is ~48 health — real healing, not invulnerability
 * (a bite minute still lands through the predators plugin).
 */
const SHELTER_HEAL_PER_MINUTE = 0.1;
/** Belly pressure at or above which the shelter's healing refuses (severe deprivation). */
const SHELTER_HEAL_DEPRIVATION_LINE = 90;

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

/**
 * R3/R4 — one section of a built structure, as the god layer and the tile
 * panel read it: the tier it stands in and its live health (wear already
 * applied). Health is derived, never stored — the wear clock is the record.
 */
export type SectionView = {
    id: string;
    tier: SectionTier;
    health: number;
    maxHealth: number;
};

/** The material anatomy of one BUILT structure (site id keyed). */
export type BuiltStructureView = {
    siteId: string;
    blueprintId: string;
    sections: SectionView[];
};

/** The two kinds of maintenance order — mend what wears, raise what stands. */
export type MaintenanceKind = 'repair' | 'upgrade';

/**
 * R3/R4 — one maintenance order against a built structure's section: the
 * material it owes (staged onto the footprint), the work it costs, and the
 * progress. AT MOST ONE open order per section (a repair or an upgrade,
 * never both); orders are created by the wear trigger (repair) or the god
 * API (repair or upgrade) and completed by the crew through the maintain
 * rung.
 */
export type MaintenanceOrder = {
    /** Order id, "m-1", "m-2", … in creation order. */
    id: string;
    /** The built site the order stands on. */
    siteId: string;
    /** The section the order serves. */
    sectionId: string;
    kind: MaintenanceKind;
    /** The item the crew must stage (the section's tier material). */
    item: string;
    /** Material units the order consumes. */
    units: number;
    /** Work-minutes the order costs. */
    work: number;
    /** Units staged onto the footprint so far. */
    staged: number;
    /** Work-minutes done so far. */
    workDone: number;
    state: 'open' | 'done';
};

/** The internal record of one built structure (keyed by site id). */
type StructureRecord = {
    siteId: string;
    blueprintId: string;
    sections: StructureSection[];
};

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
     * R3 — THE SHELTER SERVICE: the walkable GATE of every BUILT roofed
     * structure (shelter/house), placement order. This is the clean lookup
     * the sleep plugin treks to (its `shelters` provider option wires to
     * this method — the scenario mounts sleep first, so the provider is a
     * deferred getter and resolves after construction stands). Empty before
     * the first roof; a gate is by definition the doorway cell the
     * completed footprint leaves open (the occupancy rule's exception), so
     * every reported gate is accessible.
     */
    shelters(): GateSpot[];
    /**
     * R3-INTEGRATION — whether a body stands SHELTERED: exactly on a built
     * roofed structure's usable gate (the same read `shelters()` and the
     * rest-bonus sweep make — one source, never disagreeing). This is the
     * exposure flag the scenario wires into the predators' bite gate and
     * the survival flee's land-threat scan: the walls keep the beasts out
     * of the footprint, and the gate is the footprint's one usable cell
     * (the interior stays walled), so standing sheltered means standing
     * behind the structure. Bounded protection, not invulnerability — it
     * covers this cell only, ends the moment the body steps off, and
     * never shields against needs, wounds already taken, or the open sea.
     */
    isSheltered(entityId: string): boolean;
    /**
     * R3/R4 — the BUILT structures' section anatomy (one entry per built
     * site, placement order). Health is LIVE (the wear clock applied).
     */
    structures(): BuiltStructureView[];
    /**
     * The section views of one built site (the tile panel reads it), or
     * undefined when the site carries no structure record (unbuilt, gone).
     */
    sectionsOf(siteId: string): SectionView[] | undefined;
    /** The maintenance orders (open + done), in creation order. */
    orders(): MaintenanceOrder[];
    /**
     * God API — order a built section's repair (the price is the CURRENT
     * wear, snapshotted on the order). Undefined for unknown ids; an
     * already-open order on the section is returned as-is (one open order
     * per section, repair or upgrade).
     */
    orderRepair(siteId: string, sectionId: string): MaintenanceOrder | undefined;
    /**
     * God API — order a built section's one-rung upgrade (wood → stone →
     * brick; the brick leg's material waits on the kiln gate). Undefined
     * at the top of the ladder or for unknown ids; an already-open order
     * on the section is returned as-is.
     */
    orderUpgrade(siteId: string, sectionId: string): MaintenanceOrder | undefined;
    /**
     * R3 — the durability views of the CREW's hand tools (one entry per
     * tool a living sentient bag holds, health live — the wear ledger keyed
     * entity+tool, plugins/inventory/toolDurability.ts). The inspector/
     * integration read: an empty list when no tool is held or the plugin
     * stands down.
     */
    tools(): Array<{ actorId: string; tool: string; health: number; maxHealth: number; damage: number }>;
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
    // R5/R6 — re-price the stock blueprints onto the island's time scale
    // (see ISLAND_BLUEPRINT_WORK): remove + define, because `define` throws
    // on an id collision. Only THIS registry instance changes — the shared
    // package's stock specs stay generic for every other distribution.
    // TWO PASSES (collect in the registry's own define order, then remove +
    // re-define) so the re-priced entries keep the stock definition ORDER —
    // the build rungs are generated from blueprints.blueprints() and the
    // campaign's staging sequence depends on that order staying put.
    const repriced = blueprints
        .blueprints()
        .filter((definition) => ISLAND_BLUEPRINT_WORK[definition.id] !== undefined)
        .map((definition) => ({
            ...definition,
            // R5/R6 — the island work re-pricing, AND R2 — the material-to-
            // work law: the island requires REPLACE the stock token counts
            // (shelter 2+2 … fort 8+4) with the literal staging totals whose
            // units sum to the work minutes. Same snapshot rule as the work:
            // sites placed after this pass carry the island totals.
            work: ISLAND_BLUEPRINT_WORK[definition.id],
            requires: ISLAND_BLUEPRINT_REQUIRES[definition.id].map((line) => ({ ...line })),
        }));
    arrayEach(repriced, ({ value: definition }) => {
        blueprints.remove(definition.id);
        blueprints.define(definition);
    });
    // R3 — the island's OWN blueprints (quarry + furnace): not stock shapes,
    // defined fresh on this instance — the shared package never sees them.
    // BRACED body on purpose: `define` RETURNS the stored copy, and arrayEach
    // short-circuits on any non-undefined callback return — an expression
    // body would define the quarry and silently skip the furnace.
    arrayEach([...ISLAND_BLUEPRINTS], ({ value: spec }) => {
        blueprints.define(spec);
    });
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

    // R2 — the fine terrain resolver, resolved at SETUP from the world's
    // plugin roster (the terrain plugin mounts before construction in the
    // scenario's plugin list — scenario/island.ts; a terrainless world
    // leaves this undefined and the placement scan falls back to the legacy
    // coarse-only gates at the center anchor). Type-only coupling: the
    // resolver reads the terrain plugin's EXISTING cellFor path API
    // ([{tile},{fine}], plugins/terrain islandTerrain.ts) — no terrain
    // change, no wiring edit.
    let fineTerrain: FineTerrainResolver | undefined;

    // The plan cursor + the completed ledger (a launched vessel removes its
    // site, so completion is recorded explicitly, not re-derived)
    let projectIndex = 0;
    const completed: string[] = [];

    // The launched vessels, in launch order
    const moored: Vessel[] = [];
    let vesselCounter = 0;

    // R3/R4 — the built structures' section records (siteId → sections) and
    // the maintenance orders (repair + upgrade), island-local beside the
    // shared site registry. Records are created when a site turns BUILT and
    // dropped when the site leaves the registry (launch, god remove); open
    // orders on a vanished site close with it.
    const structureRecords = new Map<string, StructureRecord>();
    const orders: MaintenanceOrder[] = [];
    let orderCounter = 0;

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

    /**
     * R4 — the RAW demand the EARLY TOOLS still owe the crew: for each tool
     * the crew does NOT already carry (crewHasTool), the tool recipe's
     * inputs summed. The axe (wood 1 + stone 1) and the hammer (wood 2) are
     * crafted ONCE, so once a tool lands in any bag its raw demand
     * disappears — the crew is done owing its ingredients. This is what the
     * fetch/materials rungs consult so the crew gathers a tool's STONE (the
     * axe's edge) early: before this, the stone demand only surfaced at the
     * fort (late in PLAN_ORDER) and the axe starved, so no early tool ever
     * appeared in a normal (non-injected) world.
     */
    const toolRawOf = (): Array<{ item: string; count: number }> => {
        const demand: Array<{ item: string; count: number }> = [];
        arrayEach([...TOOL_RECIPE_IDS], ({ value: toolId }) => {
            // The once gate — a tool the crew already carries owes nothing.
            if (crewHasTool(toolId)) {
                return;
            }
            const recipe = crafting.recipes().find((candidate) => candidate.id === toolId);
            if (!recipe) {
                return;
            }
            arrayEach(recipe.inputs, ({ value: input }) => {
                const held = demand.find((line) => line.item === input.item);
                if (held) {
                    held.count = held.count + input.count;
                } else {
                    demand.push({ item: input.item, count: input.count });
                }
            });
        });
        return demand;
    };

    /**
     * R4 — the site's EFFECTIVE raw demand: the site's own `raw` merged with
     * the tools' raw demand, the per-item MAX (a single bag must be able to
     * hold BOTH the site's staging AND the tool's inputs, so the bigger of
     * the two is the demand the crew must satisfy — the site's, not the
     * tool's, is the longer-lived obligation and the max never over-fetches
     * the shorter one). The fetch/materials rungs read THIS, not the bare
     * site demand, so the crew gathers a tool's stone/wood before the early
     * craft rung can fire.
     */
    const effectiveRawOf = (site: Site): Array<{ item: string; count: number }> => {
        const lines = demandOf(site).raw.map((line) => ({ item: line.item, count: line.count }));
        arrayEach(toolRawOf(), ({ value: line }) => {
            const held = lines.find((candidate) => candidate.item === line.item);
            if (held) {
                held.count = Math.max(held.count, line.count);
            } else {
                lines.push({ item: line.item, count: line.count });
            }
        });
        return lines;
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

    /**
     * THE OPEN FOOTPRINT CELL — the workSpot rule WITHOUT the gate fallback:
     * the first footprint cell no other grounded body stands on, or undefined
     * when the whole staging surface is occupied. The haul rungs (deliver /
     * maintain) decline on a taken footprint instead of milling: four
     * castaways circling one 1-cell raft footprint burned 83k move-minutes
     * on the seed-7 march (the convergence tax the stock costs hid). A
     * declined hauler holds its load at camp — the spot frees the moment a
     * worker finishes, and the next minute the haul lands.
     */
    const openSpot = (site: Site, selfId: string): GateSpot | undefined => {
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
        return undefined;
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

    /**
     * R4 — whether ANY sentient crew member already carries `tool` (the
     * once-per-craft gate): the crew builds each tool a single time and
     * shares the result conceptually, so once one castaway's bag holds the
     * axe the crew considers it "has an axe" and the tool-craft rung stops
     * owing it. Reads every actor bag (castaways only — the creatures never
     * craft).
     */
    const crewHasTool = (tool: string): boolean => {
        let held = false;
        world?.actors.forEach((actor) => {
            if ((inventory.of(actor.id)[tool] ?? 0) > 0) {
                held = true;
            }
        });
        return held;
    };

    /**
     * R4 — the DETERMINISTIC LEAD who may craft `toolId`: the first eligible
     * crew actor in actor-iteration order who can build it (not a creature,
     * the species' craft ability, the finished tool fits the bag, and the bag
     * ALREADY holds the full input set). Exactly one actor — the lead — may
     * craft the tool; every other actor with the same inputs DEFERS to the
     * lead. This makes the once-gate ATOMIC within a minute: the old check
     * (appliesTo read `crewHasTool` per actor at plan time) let two actors
     * who BOTH held the inputs see "the crew has no tool yet" before
     * either's craft landed, so one minute flooded the crew with a duplicate
     * axe (and the same for the hammer). Gating on the single lead removes
     * that same-minute race — the crew crafts each tool exactly once.
     */
    const toolLeadOf = (toolId: string, recipe: Recipe): Actor | undefined => {
        let lead: Actor | undefined;
        world?.actors.forEach((actor) => {
            if (lead) {
                return;
            }
            if (actor.kind === 'creature') {
                return;
            }
            if (!mayCraft(actor.type)) {
                return;
            }
            const bag = inventory.of(actor.id);
            // The bag must already hold the FULL input set (the craft
            // consumes from a single bag)
            const ready = recipe.inputs.every((input) => (bag[input.item] ?? 0) >= input.count);
            if (!ready) {
                return;
            }
            // The finished tool's NET change fits the bag — the same rule as
            // the site-craft gate (see the craft rungs below): the
            // conversion consumes the inputs, so the POST-CRAFT total is
            // what must fit, never `total + 1`. Both tool recipes take two
            // raw for one tool (the net change is −1), so a full-handed lead
            // that holds the inputs crafts the tool and FREES a slot —
            // exactly the full-hand release the starvation ladder depends
            // on; the old capacity check refused it and wedged the hand.
            // R5 — the same net-change rule in WEIGHT: the post-craft carried
            // weight (carried − inputs' weight + the tool's weight) must stay
            // within the carrier's weight budget.
            const inputWeight = recipe.inputs.reduce(
                (sum, input) => sum + input.count * itemWeight(input.item),
                0,
            );
            if (inventoryWeight(bag) - inputWeight + itemWeight(toolId) > inventory.capacityOf(actor.id)) {
                return;
            }
            lead = actor;
        });
        return lead;
    };

    /**
     * R4 — the full input set of the UNMET early tool that `actorId` is the
     * deterministic craft-lead for (the first TOOL_RECIPE_IDS tool whose
     * toolLeadOf resolves to this actor), or the empty set when the actor
     * leads no unmet tool. The material rungs read this as the TOOL-LEAD
     * HOLD: the one pair of hands the crew trusts to hold the complete
     * input set must not be drafted away with those inputs. The deliver
     * rung sits ABOVE the tool-craft rung (24 > 23), so without the hold
     * the lead's tool inputs leave its bag as site staging faster than the
     * 5-minute craft can commit them — the seed-7 finite-stone campaign is
     * the proof: the fort's permanent stone/wood staging keeps the lead
     * actor hauling (hauls the deliver rung's label), the axe's inputs
     * first land in one bag at minute 399, and at minute 800 the axe still
     * has not crafted while the hammer landed at 262 on a lucky 5-minute
     * gap. With the hold the lead sits on its inputs, the ladder falls
     * past the declined material rungs to the tool-craft rung, and the
     * first idle minute commits the craft.
     *
     * UNMET means UNMET — the same once-per-crew gate the tool-craft rung
     * reads (crewHasTool): the moment ANY bag holds the tool the owed craft
     * is closed, so the tool is SKIPPED and its inputs are no longer
     * reserved. Without this skip a lead whose axe already exists would go
     * on protecting the axe's wood + stone forever — the closed craft never
     * consumes them, and the fetch/seek/fell/deliver rungs stay declined on
     * material the crew now needs (the reserve outlives the debt). The skip
     * cannot reopen the duplicate race the lead gate closed: while the craft
     * is owed (tool in no bag) the hold behaves exactly as before, and the
     * moment a tool lands the craft rung itself is closed for everyone.
     */
    const owedToolInputsOf = (actorId: string): Array<{ item: string; count: number }> => {
        for (const toolId of TOOL_RECIPE_IDS) {
            // The once-gate: a tool any crew member already carries is not
            // owed — no reserve for a craft that will never run (the lead is
            // RELEASED with the tool, the same instant the craft rung ends)
            if (crewHasTool(toolId)) {
                continue;
            }
            const recipe = crafting.recipes().find((candidate) => candidate.id === toolId);
            if (recipe && toolLeadOf(toolId, recipe)?.id === actorId) {
                return recipe.inputs.map((line) => ({ item: line.item, count: line.count }));
            }
        }
        return [];
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
     * R3 — the first held tool worn past the mend trigger (TOOL_RECIPE_IDS
     * order — deterministic), or undefined. Reads the durability ledger
     * keyed entity+tool (plugins/inventory/toolDurability) with the LIVE bag
     * count as the canonical existence check: a broken/lost tool never
     * reads as mendable (its record died with the bag), a replacement starts
     * fresh.
     */
    const mendableToolOf = (
        active: World,
        actorId: string,
        bag: Record<string, number | undefined>,
    ): string | undefined => {
        for (const toolId of TOOL_RECIPE_IDS) {
            if (toolMendDue(active, actorId, toolId, bag[toolId] ?? 0)) {
                return toolId;
            }
        }
        return undefined;
    };

    /**
     * The craft gate's ability unlock — the species' 'craft' ability (the
     * entity profiles' work-kind unlock the building feature reads). Without
     * profiles every hand may work (the pre-entity behavior).
     */
    const mayCraft = (type: string | undefined): boolean =>
        !profiles || (type !== undefined && profiles.hasAbility(type, 'craft'));

    /**
     * The fell gate's ability unlock — the species' 'chop' ability (the same
     * work-kind unlock the lumber plugin's chop reads). Felling wood for the
     * site is chopping a tree: an entity that cannot chop cannot feed the
     * shared chop job. Without profiles every hand may chop (the pre-entity
     * behavior).
     */
    const mayChop = (type: string | undefined): boolean =>
        !profiles || (type !== undefined && profiles.hasAbility(type, 'chop'));

    // ── R3/R4 — the built structures: sections, the quarry cut, orders ──────

    /**
     * R3 — the stone a BUILT quarry cuts: the gravel bedrock under its
     * highland tile opens to the crew (2400 units — enough for the fort's
     * 1920-unit walls and the furnace's body with a margin). The island's
     * NATURAL surface stone (a handful of loose rock, STONE_GUARANTEE_MIN)
     * could never feed those walls — the quarry is the mine that does, and
     * it pays out ONCE when the quarry stands (a finite bedrock cut, not an
     * infinite spring). The yield lands on BOTH stone layers of the anchor
     * tile, exactly once at the cut: the DEPOSIT record (`resources.stone`,
     * the landmark the surface derivation reads) AND the GATHERABLE STOCK
     * (the inventory's live per-tile stock — takeFromCell and cellsWithItem
     * read the stock, which the survey seeds from the deposit only at
     * survey time; a deposit-only cut would be invisible to the crew, the
     * independent review's seed-7 probe: 2400 stone lay in the record and
     * nothing could lift it). Accounting stays whole from here: every take
     * draws stock AND deposit in step (the inventory's drawDeposit), and a
     * later resurvey rebuilds the stock FROM the deposit — the yield is
     * counted once, never minted twice.
     */
    const QUARRY_STONE_YIELD = 2400;

    /** The quarry's cut — stage the bedrock yield onto the anchor tile. */
    const openQuarryBedrock = (site: Site): void => {
        const active = world;
        if (!active) {
            return;
        }
        const anchor = site.parent[0];
        const cell = active.cellAt(anchor.x, anchor.y);
        if (!cell) {
            return;
        }
        cell.resources.stone = (cell.resources.stone ?? 0) + QUARRY_STONE_YIELD;
        // THE GATHERABLE MIRROR - the live stock is what takeFromCell and
        // cellsWithItem actually read (the survey seeds it from the deposit
        // only at setup/resurvey), so the cut must land on it too or the
        // bedrock is unmineable. One write, at the cut; from then on the
        // two layers draw down in step and a resurvey rebuilds the stock
        // from the deposit (no double count - see the doc above)
        const stock = inventory.cellStock(anchor.x, anchor.y);
        stock.stone = (stock.stone ?? 0) + QUARRY_STONE_YIELD;
        active.events.emit({
            kind: 'quarry',
            message: `The quarry cuts the bedrock at (${anchor.x}, ${anchor.y}) — ${QUARRY_STONE_YIELD} stone lies ready.`,
        });
    };

    /** The anchor of the first BUILT furnace, if the island has a kiln. */
    const builtFurnaceAnchor = (): { x: number; y: number } | undefined =>
        sites.sites().find((site) => site.blueprintId === 'furnace' && site.state === 'built')
            ?.parent[0];

    /**
     * R3 — the KILN GATE: bricks are fired, not woven. A craft of brick is
     * only honest within arm's reach (Chebyshev ≤ 1) of a BUILT furnace —
     * the maintain rung's brick path and the craft effect both revalidate
     * this at completion (a furnace demolished mid-firing loses the batch).
     */
    const nearBuiltFurnace = (position: { x: number; y: number }): boolean => {
        const furnace = builtFurnaceAnchor();
        if (!furnace) {
            return false;
        }
        return Math.max(Math.abs(position.x - furnace.x), Math.abs(position.y - furnace.y)) <= 1;
    };

    /** The section views of a record — health derived from the wear clock. */
    const sectionsView = (record: StructureRecord): SectionView[] =>
        record.sections.map((section) => ({
            id: section.id,
            tier: section.tier,
            health: sectionHealth(section),
            maxHealth: SECTION_MAX_HEALTH[section.tier],
        }));

    /**
     * Open one maintenance order against a section — the price is read at
     * OPENING (repairPrice walks the CURRENT wear; upgradeCost the current
     * tier) and then SNAPSHOT on the order: the crew owes exactly what was
     * written when the order opened, even if wear keeps banking meanwhile
     * (the same snapshot discipline as the site's staging costs).
     */
    const openOrder = (
        kind: MaintenanceKind,
        siteId: string,
        section: StructureSection,
    ): MaintenanceOrder | undefined => {
        const price = kind === 'repair' ? repairPrice(section) : upgradeCost(section.tier);
        if (!price) {
            return undefined; // brick sits at the top of the ladder
        }
        orderCounter = orderCounter + 1;
        const order: MaintenanceOrder = {
            id: `m-${orderCounter}`,
            siteId,
            sectionId: section.id,
            kind,
            item: price.item,
            units: 'units' in price ? price.units : price.count,
            work: price.work,
            staged: 0,
            workDone: 0,
            state: 'open',
        };
        orders.push(order);
        return order;
    };

    /** The one open order a section carries (repairs and upgrades share it). */
    const openOrderOf = (siteId: string, sectionId: string): MaintenanceOrder | undefined =>
        orders.find(
            (order) => order.state === 'open' && order.siteId === siteId && order.sectionId === sectionId,
        );

    /**
     * THE STRUCTURE SWEEP — once per world minute:
     *  1. a site that just turned BUILT gets its section anatomy (and the
     *     quarry cuts its bedrock, once);
     *  2. records whose site left the registry (launch, god remove) drop
     *     with it — and their open orders close;
     *  3. THE WEAR CLOCK: every built section banks one worn minute (dead
     *     material never heals — the living woods regrow through the forest
     *     plugin, a wall does not);
     *  4. THE AUTO-REPAIR TRIGGER: a section worn to REPAIR_TRIGGER of its
     *     full health opens the crew's repair order (one open order per
     *     section; upgrades are god-ordered only).
     */
    const syncStructures = (): void => {
        const active = world;
        if (!active) {
            return;
        }
        // 1 — freshly built structures gain their sections; the quarry cuts
        for (const site of sites.sites()) {
            if (site.state !== 'built' || structureRecords.has(site.id)) {
                continue;
            }
            structureRecords.set(site.id, {
                siteId: site.id,
                blueprintId: site.blueprintId,
                sections: createSections(site.blueprintId),
            });
            if (site.blueprintId === 'quarry') {
                openQuarryBedrock(site);
            }
        }
        // 2 — records whose site vanished leave the ledger (orders with it)
        for (const siteId of Array.from(structureRecords.keys())) {
            if (sites.siteOf(siteId)) {
                continue;
            }
            structureRecords.delete(siteId);
            for (let index = orders.length - 1; index >= 0; index--) {
                if (orders[index].siteId === siteId && orders[index].state === 'open') {
                    orders.splice(index, 1);
                }
            }
        }
        // 3 — the wear clock (integer minutes, never float drift)
        structureRecords.forEach((record) => {
            record.sections.forEach((section) => {
                section.wornMinutes = section.wornMinutes + 1;
            });
        });
        // 4 — the auto-repair trigger (the crew keeps its works half-sound
        // at worst; the god can order better)
        structureRecords.forEach((record) => {
            record.sections.forEach((section) => {
                if (sectionHealth(section) > SECTION_MAX_HEALTH[section.tier] * REPAIR_TRIGGER) {
                    return;
                }
                if (openOrderOf(record.siteId, section.id)) {
                    return;
                }
                openOrder('repair', record.siteId, section);
            });
        });
    };

    /**
     * The trek target for `actor` — the nearest cell holding `item` that no
     * EARLIER actor (world.actors iteration order — deterministic) already
     * claims for the same item. THE CONVOY RULE: when the whole crew seeks
     * the SAME resource cell they funnel through one fine corridor, each
     * body blocking the next (the seed-7 raft march: 25 world minutes per
     * tile step, 83k haul-moves for 476 deliveries). Distinct nearest
     * targets spread the crew across the island's stands and the treks run
     * in parallel; when candidates run out the actor shares an earlier
     * claim (nearest still wins).
     */
    const seekSource = (actor: FineMover, item: string): TerrainCell | null => {
        const active = world;
        if (!active) {
            return null;
        }
        const candidates = inventory.cellsWithItem(item);
        if (candidates.length === 0) {
            return null;
        }
        const claimed = new Set<string>();
        let mine: TerrainCell | null = null;
        active.actors.forEach((other) => {
            const open = candidates.filter((cell) => !claimed.has(`${cell.x},${cell.y}`));
            const pick = nearestCell(other, open.length > 0 ? open : candidates);
            if (!pick) {
                return;
            }
            claimed.add(`${pick.x},${pick.y}`);
            if (other.id === actor.id) {
                mine = pick;
            }
        });
        return mine ?? nearestCell(actor, candidates);
    };

    /**
     * The maintain rung's FETCH half — the raw material an order owes, off
     * the ground: the underfoot beat (the SHARED tile job, the same R6
     * ledger the site fetches work) or the trek toward the nearest stocked
     * cell. Stone revalidates the mine gate at completion (the behavior
     * plugin's gather effect refuses the unskilled take).
     */
    const orderFetchPlan = (
        active: World,
        actor: TaskEntity,
        item: string,
    ): TaskSpec | undefined => {
        // WOOD is never lying on a tile — it stands in trees: the order's
        // wood is FELLED (the same shared chop job the materials rung and
        // the lumber plugin work — R6 one job per tile)
        if (item === 'wood') {
            if (!mayChop(actor.type)) {
                return undefined;
            }
            const key = tileWorkKey(actor.position.x, actor.position.y, CHOP_WORK_KIND);
            if (tasks.tileWork.get(key)) {
                return { kind: 'fell', label: 'fells a tree', minutes: 1 };
            }
            const standing = inventory.cellStock(actor.position.x, actor.position.y);
            if ((standing.tree ?? 0) > 0) {
                const carriesAxe = (inventory.of(actor.id).axe ?? 0) > 0;
                tasks.tileWork.open({
                    key,
                    kind: CHOP_WORK_KIND,
                    units: carriesAxe ? Math.max(1, Math.ceil(FELL_MINUTES / 2)) : FELL_MINUTES,
                    skill: 'chop',
                });
                return { kind: 'fell', label: 'fells a tree', minutes: 1 };
            }
            const grove = seekSource(actor, 'tree');
            if (!grove) {
                return undefined;
            }
            return travelSpec(active, actor, 'seeks wood', grove, travel);
        }
        const stock = inventory.cellStock(actor.position.x, actor.position.y);
        if ((stock[item] ?? 0) > 0) {
            openGatherJob(tasks.tileWork, {
                x: actor.position.x,
                y: actor.position.y,
                item,
                units: TAKE_MINUTES,
                skill: MINED_ITEMS.includes(item) ? 'mine' : 'forage',
            });
            return {
                kind: 'gather',
                label: `takes ${item}`,
                minutes: 1,
                payload: { item, beat: true, x: actor.position.x, y: actor.position.y },
            };
        }
        const source = seekSource(actor, item);
        if (!source) {
            return undefined;
        }
        return travelSpec(active, actor, `seeks ${item}`, source, travel);
    };

    /**
     * The maintain rung's BRICK half (R3) — an upgrade order owes bricks,
     * and bricks are FIRED, not found: fetch the inputs (sand + stone) off
     * the ground, CARRY them to a BUILT furnace, and craft beside it (the
     * atomic craft consumes them). No furnace stands → the order waits —
     * the gate is the whole point of building one.
     */
    const brickPlan = (
        active: World,
        actor: TaskEntity,
    ): TaskSpec | undefined => {
        const recipe = crafting.recipes().find((candidate) => candidate.id === 'brick');
        if (!recipe) {
            return undefined;
        }
        const bag = inventory.of(actor.id);
        const ready = recipe.inputs.every((line) => (bag[line.item] ?? 0) >= line.count);
        if (ready) {
            // The inputs ride to the kiln — the craft only happens within
            // arm's reach of a BUILT furnace (the kiln gate, revalidated by
            // the craft effect at completion)
            if (!nearBuiltFurnace(actor.position)) {
                const furnace = builtFurnaceAnchor();
                if (!furnace) {
                    return undefined;
                }
                // travelSpec addresses a real cell — the furnace's tile
                const furnaceCell = active.cellAt(furnace.x, furnace.y);
                if (!furnaceCell) {
                    return undefined;
                }
                return travelSpec(active, actor, 'carries brick inputs', furnaceCell, travel);
            }
            return {
                kind: 'craft',
                label: 'fires brick',
                minutes: Math.max(1, recipe.minutes),
                payload: { recipe: 'brick' },
            };
        }
        // Fetch the first missing input (sand is the unlimited ground
        // supply, stone the mined one — the quarry keeps it near)
        const missing = recipe.inputs.find((line) => (bag[line.item] ?? 0) < line.count);
        if (!missing) {
            return undefined;
        }
        return orderFetchPlan(active, actor, missing.item);
    };

    /**
     * R4 — the per-order maintenance planner: the haul (stage what the bag
     * holds), the fetch (gather what the order still owes — gated by the
     * kiln for brick, the mine ability for stone, and bag room for all),
     * or the work (stand on the structure and spend a minute). Returns
     * undefined when THIS order cannot be served right now; the caller
     * (the maintain rung's plan) then tries the next open order. The gates
     * live here, so a blocked order never bypasses one — it just yields
     * no plan.
     */
    const planOrder = (
        active: World,
        actor: TaskEntity,
        order: MaintenanceOrder,
    ): TaskSpec | undefined => {
        const site = sites.siteOf(order.siteId);
        if (!site) {
            return undefined;
        }
        const bag = inventory.of(actor.id);
        // THE HAUL — the bag already holds order material: carry it to
        // the footprint and stage it (the effect revalidates the
        // arithmetic at completion)
        if (order.staged < order.units && (bag[order.item] ?? 0) > 0) {
            if (atSite(actor, site)) {
                return {
                    kind: 'stage',
                    label: 'stages materials',
                    minutes: DELIVER_MINUTES,
                    payload: { orderId: order.id },
                };
            }
            const spot = openSpot(site, actor.id);
            if (!spot) {
                return undefined;
            }
            const step = fineTargetStep(active, actor, { x: spot.tileX, y: spot.tileY }, { x: spot.x, y: spot.y });
            if (!step) {
                return undefined;
            }
            return {
                kind: 'move',
                label: 'hauls materials',
                minutes: travel,
                payload: { dx: step[0], dy: step[1] },
            };
        }
        // THE FETCH — the order still owes material the bag does not
        // hold. BRICK comes off the kiln (the furnace gate — no kiln, no
        // brick); everything else off the ground.
        if (order.staged < order.units) {
            if (order.item === 'brick') {
                return brickPlan(active, actor);
            }
            // THE MINE GATE — a stone order needs the 'mine' ability
            // (the take revalidates at completion)
            if (
                MINED_ITEMS.includes(order.item) &&
                profiles &&
                !profiles.hasAbility(actor.type ?? '', 'mine')
            ) {
                return undefined;
            }
            // THE BAG ROOM GATE — a full hand fetches nothing
            if (inventoryWeight(bag) >= inventory.capacityOf(actor.id)) {
                return undefined;
            }
            return orderFetchPlan(active, actor, order.item);
        }
        // THE WORK — the order is fully staged: stand on the structure
        // and work it, one minute per task (the effect commits the order
        // on its last stage)
        if (atSite(actor, site)) {
            return {
                kind: 'maintain',
                label: order.kind === 'repair' ? 'repairs the structure' : 'upgrades the structure',
                minutes: BUILD_MINUTES,
                payload: { orderId: order.id },
            };
        }
        const spot = openSpot(site, actor.id);
        if (!spot) {
            return undefined;
        }
        const step = fineTargetStep(active, actor, { x: spot.tileX, y: spot.tileY }, { x: spot.x, y: spot.y });
        if (!step) {
            return undefined;
        }
        return {
            kind: 'move',
            label: 'heads to the structure',
            minutes: travel,
            payload: { dx: step[0], dy: step[1] },
        };
    };

    // ── the plan cursor: place or advance ────────────────────────────────────

    /**
     * One plan-cursor pass: advances past completed projects, then places
     * the current project's site when nothing is live. The placement scan
     * ranks the land cells by what the structure type WANTS (R1 — see the
     * scan comments; deterministic — ties keep the row-major order), and
     * places on the FIRST tile the shared registry accepts (the hooks veto
     * water, occupied fine spots and standing bodies). R2 — the anchor is
     * SEARCHED per tile over the whole fine grid (fineSiting spiralAnchors):
     * the fine center stays the first candidate, terrain/occupancy and the
     * vessels' fine mooring move it — never a hardcoded (0,0).
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
        // THE PLACEMENT SCAN (R1 — PRIORITY-AWARE SITING): row-major land
        // cells, anchor at the tile's center fine cell. The anchor sits at
        // the grid's exact middle, so the stock footprints (±1 offsets)
        // never wrap across the world's edge: every resolved cell lands on
        // the anchor tile or an immediate neighbour. Each structure type
        // SCORES the ground it WANTS and the scan places on the highest
        // score (ties keep the row-major order — deterministic):
        //   shelter / house — the CAMP CLUSTER: near the fresh water (the
        //     thirst treks are the longest errands in the game), near the
        //     food ground (meadow and forest forage), near the cast (short
        //     hauls from where the crew already stands);
        //   fort — DEFENSIBLE first: the highland rock and its ridge
        //     neighbours (walls on the heights command the island), then
        //     near the assets it guards (the BUILT structures), then camp;
        //   quarry — the rock ITSELF: only highland columns carry the
        //     gravel bedrock the quarry cuts, the nearest of them to camp
        //     (the stone hauls are the heaviest errands in the game);
        //   furnace — near the rock (its body and its firing draw stone and
        //     sand) and near camp;
        //   vessels — a beach tile WITH a sea mooring (the launch needs the
        //     water where the hull stands), the one nearest camp. R2 — the
        //     hull's fine footprint must additionally touch navigable fine
        //     sea water (the anchor rides the shoreline, the coarse gate
        //     stays so the launch's own recheck always holds).
        const active = world;
        if (!active) {
            return;
        }
        const cells = active.landCells();
        const shoreOnly = VESSEL_BLUEPRINTS.includes(blueprint);
        const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
            Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        // The cast's standing cells — the camp the crew's errands radiate
        // from (an empty pool zeroes the term: no cast, no preference)
        const actorCells: Array<{ x: number; y: number }> = [];
        active.actors.forEach((actor) => {
            actorCells.push({ x: actor.position.x, y: actor.position.y });
        });
        // The BUILT structures' anchors — the assets a fort guards
        const assetCells = sites
            .sites()
            .filter((site) => site.state === 'built')
            .map((site) => site.parent[0]);
        const nearestOf = (cell: { x: number; y: number }, pool: Array<{ x: number; y: number }>): number =>
            pool.length === 0 ? 0 : Math.min(...pool.map((entry) => cheb(cell, entry)));
        // How many cells within RADIUS satisfy TEST — the ground's character
        // AROUND a candidate tile (water, food, rock)
        const around = (
            cell: { x: number; y: number },
            radius: number,
            test: (cell: TerrainCell) => boolean,
        ): number => {
            let count = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const neighbor = active.cellAt(cell.x + dx, cell.y + dy);
                    if (neighbor && test(neighbor)) {
                        count = count + 1;
                    }
                }
            }
            return count;
        };
        // R2 — the fresh read rides the SHARED freshwater predicate
        // (engine/types isFreshBasin — lake/pond, and the river once the
        // terrain worker's passable-freshwater pass lands): a camp by a
        // flowing drink is as sensible as one by a still one.
        const isFresh = (cell: TerrainCell): boolean => isFreshBasin(cell.biome);
        const isFood = (cell: TerrainCell): boolean => cell.biome === 'meadow' || cell.biome === 'forest';
        const isRock = (cell: TerrainCell): boolean => cell.biome === 'highland';
        // R2 — the resource pools for the TIE-BREAK: the radius counts in
        // scoreOf are coarse, so many tiles tie at the same score; the old
        // row-major tie order then pinned the winner to the NORTH-WEST-most
        // equal tile (a placement bias, not a preference). The tie-break
        // below ranks equal scorers by their DISTANCE to the nearest fresh
        // water, then the nearest food ground — the genuinely closest camp
        // to the supplies wins, still fully deterministic (and the
        // row-major order keeps the last word on full ties).
        const freshPool = active.canvas.cells.filter((cell) => isFresh(cell));
        const foodPool = active.canvas.cells.filter((cell) => isFood(cell));
        const scoreOf = (cell: TerrainCell): number => {
            switch (blueprint) {
                case 'shelter':
                case 'house':
                    // Home ground: water first (weight 4), food (3), then
                    // the camp (2 per tile of distance)
                    return (
                        4 * around(cell, 3, isFresh) +
                        3 * around(cell, 3, isFood) -
                        2 * nearestOf(cell, actorCells)
                    );
                case 'fort':
                    // Defensible rock DOMINATES (standing on it beats every
                    // proximity term), rock neighbours next, then the assets
                    // it guards, then the camp
                    return (
                        10 * (isRock(cell) ? 1 : 0) +
                        2 * around(cell, 1, isRock) -
                        2 * nearestOf(cell, assetCells) -
                        nearestOf(cell, actorCells)
                    );
                case 'quarry':
                    // Only highland columns are eligible (the filter below);
                    // the best rock is the one nearest camp
                    return -nearestOf(cell, actorCells);
                case 'furnace':
                    // Near the rock (the kiln's stone and sand draws) and
                    // near camp
                    return 2 * around(cell, 2, isRock) - nearestOf(cell, actorCells);
                default:
                    // Vessels: the moored beach nearest camp
                    return -nearestOf(cell, actorCells);
            }
        };
        const mooring = (cell: { x: number; y: number }): boolean =>
            [
                { x: cell.x - 1, y: cell.y },
                { x: cell.x + 1, y: cell.y },
                { x: cell.x, y: cell.y - 1 },
                { x: cell.x, y: cell.y + 1 },
            ].some((neighbor) => {
                const neighborCell = active.cellAt(neighbor.x, neighbor.y);
                // R4 — the mooring is SEA water: since the fresh basins went
                // impassable too, a bare `!passable` read would let a hull
                // be built on a lake beach and "launched" into a landlocked
                // pond. Only the salt (ocean/shallows) carries a vessel.
                return neighborCell !== undefined && !neighborCell.passable &&
                    isSeaWater(neighborCell.biome);
            });
        const ranked = cells
            .filter((cell) => {
                if (shoreOnly) {
                    return cell.biome === 'beach' && mooring(cell);
                }
                // R3 — the quarry only stands on the highland gravel
                // bedrock: cutting stone anywhere else cuts nothing
                if (blueprint === 'quarry') {
                    return isRock(cell);
                }
                return true;
            })
            .sort((left, right) => {
                // R2 — score first; exact ties break toward the nearest
                // fresh water, then the nearest food ground (the supply
                // proximity the coarse radius counts cannot separate);
                // Array.sort is stable, so a full tie keeps the row-major
                // order (deterministic, the legacy winner on a dead-even
                // island)
                const byScore = scoreOf(right) - scoreOf(left);
                if (byScore !== 0) {
                    return byScore;
                }
                const byWater = nearestOf(left, freshPool) - nearestOf(right, freshPool);
                if (byWater !== 0) {
                    return byWater;
                }
                return nearestOf(left, foodPool) - nearestOf(right, foodPool);
            });
        // R2 — THE FINE ANCHOR SEARCH: the anchor is no longer hardcoded at
        // the fine (0,0) center. Each ranked tile is searched over its WHOLE
        // fine grid (spiralAnchors' deterministic center-out order — the
        // legacy center stays the first candidate, so an ordinary placement
        // resolves exactly as before; blocked terrain, a standing body or a
        // vessel's mooring requirement move the anchor off it). Validity:
        //   1. the registry's own pre-check (hooks: dry land + nobody
        //      standing in the cells; occupancy; self-overlap) — conflicts();
        //   2. every footprint fine cell stands on DRY fine terrain (the
        //      mixed-shore gate — a land tile's fine water cells are never
        //      built over; skipped when no terrain plugin resolves fine
        //      cells, the legacy terrainless world);
        //   3. VESSELS: at least one footprint cell stands directly beside
        //      NAVIGABLE fine sea water (biome shallows/ocean — the launch's
        //      own salt rule, kept at fine scale; a lake/pond fine cell is
        //      never a mooring). A fine step off the tile's edge wraps the
        //      coarse boundary and reads the ADJACENT tile's fine cell, so
        //      the hull always moors at the shore the launch rechecks.
        const dims = { width: active.canvas.width, height: active.canvas.height };
        const halfX = (dims.width - 1) / 2;
        const halfY = (dims.height - 1) / 2;
        const definitionCells = blueprints.definitionOf(blueprint)?.cells ?? [];
        const anchors = spiralAnchors(halfX, halfY);
        for (let index = 0; index < ranked.length; index++) {
            const cell = ranked[index];
            let placed = false;
            for (const anchor of anchors) {
                const spec: SiteSpec = {
                    blueprintId: blueprint,
                    parent: [{ x: cell.x, y: cell.y }],
                    anchor,
                };
                // The registry's own pre-check: hooks + occupancy + self-overlap
                if (sites.conflicts(spec).length !== 0) {
                    continue;
                }
                // Resolve the footprint's fine addresses once (definition
                // order, the registry's own resolution semantics — the wrap
                // and the parent shift ride subTileStep/shiftPath so the
                // gates read the EXACT addresses the site would store)
                const resolved = definitionCells.map((offset) => {
                    const stepped = subTileStep(dims.width, dims.height, anchor.x, anchor.y, offset.x, offset.y);
                    return {
                        parent: shiftPath([{ x: cell.x, y: cell.y }], dims, stepped.parent.dx, stepped.parent.dy)[0],
                        x: stepped.x,
                        y: stepped.y,
                    };
                });
                // The fine-scale terrain gates (skipped without a resolver —
                // the legacy terrainless world places at the coarse gates)
                if (fineTerrain) {
                    if (!footprintIsDry(resolved, fineTerrain)) {
                        continue;
                    }
                    if (
                        shoreOnly &&
                        !footprintTouchesSeaWater(
                            resolved,
                            fineTerrain,
                            dims,
                            (x, y) => active.inBounds(x, y),
                        )
                    ) {
                        continue;
                    }
                }
                sites.place(spec);
                placed = true;
                break;
            }
            if (placed) {
                // ONE placement per pass — the next project waits its turn
                break;
            }
        }
    };

    // ── the shelter's survival use ───────────────────────────────────────────

    /**
     * R3 — THE SHELTER SERVICE's gate collection: the walkable gate of every
     * BUILT roofed structure, placement order (the same read the rest-bonus
     * sweep builds each minute — shared so `shelters()` and the sweep can
     * never disagree).
     */
    const roofedGates = (): GateSpot[] => {
        const gates: GateSpot[] = [];
        arrayEach(sites.sites(), ({ value: site }) => {
            if (site.state === 'built' && ROOFED_BLUEPRINTS.includes(site.blueprintId)) {
                const gate = siteGate(site);
                if (gate) {
                    gates.push(gate);
                }
            }
        });
        return gates;
    };

    /**
     * R3-INTEGRATION — the public exposure read (see the ConstructionPlugin
     * doc above): whether the body stands exactly ON a built roofed gate.
     * The same gate collection `shelters()` and the rest-bonus sweep use —
     * the three reads can never disagree. Registry actors resolve through
     * the actor record, coordinate-space creatures through the facet (the
     * sleep sweep's own visit order); a body with no position or no fine
     * spot is simply not sheltered.
     */
    const isSheltered = (entityId: string): boolean => {
        const active = world;
        if (!active) {
            return false;
        }
        const position =
            active.actors.get(entityId)?.position ?? active.coordinates.positionOf(entityId);
        const sub = active.subOf(entityId);
        if (!position || !sub) {
            return false;
        }
        return roofedGates().some(
            (gate) =>
                gate.tileX === position.x &&
                gate.tileY === position.y &&
                gate.x === sub.x &&
                gate.y === sub.y,
        );
    };

    /**
     * The rest bonus sweep: a body whose head task is a sleep or a rest AND
     * that stands on a BUILT roofed structure's gate recovers energy faster
     * — the sheltered night is the safe night — AND mends its wounds (R3
     * healing, gated on not being severely deprived: the shelter comforts,
     * it does not feed). Registry castaways first, then the
     * coordinate-space creatures (the sleep plugin's sweep order).
     */
    const shelterRest = (): void => {
        const active = world;
        if (!active) {
            return;
        }
        // The built roofed gates — usually zero or one
        const gates = roofedGates();
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
        // R3 — the sheltered healing: +health per minute on the gate while
        // sleeping/resting, only while the body is WOUNDED (below the full
        // reservoir) and NOT severely deprived (either belly pressure at the
        // 90 critical line refuses the mend — no healing through starvation;
        // the needs plugin's deficit drains stay honest). The sanctioned
        // health write: the shelter is an in-simulation structure, the same
        // route the predators' bite uses (needs.satisfy), never the
        // unaccounted god-view one.
        const heal = (id: string): void => {
            const state = needs.of(id);
            if (
                state.health > 0 &&
                state.health < 100 &&
                state.hunger < SHELTER_HEAL_DEPRIVATION_LINE &&
                state.thirst < SHELTER_HEAL_DEPRIVATION_LINE
            ) {
                needs.satisfy(id, { health: SHELTER_HEAL_PER_MINUTE });
            }
        };
        const seen = new Set<string>();
        active.actors.forEach((actor) => {
            seen.add(actor.id);
            const task = tasks.taskOf(actor.id);
            if ((task?.kind === 'sleep' || task?.kind === 'rest') && sheltered(actor.id, actor.position)) {
                // THE RECOVERY ROUTE (T6) — the bonus is a REST gain, so it
                // rides needs.recovery like the sleep restore itself: the
                // actual gain is capped by the energy headroom and by the
                // charged resources' room (an empty source yields nothing —
                // the bonus never conjures energy from a full belly line),
                // and the equal hunger/thirst charge makes the sheltered
                // minute's whole spend honest. A body whose head task is
                // anything else (awake on the gate) gains nothing — the
                // gate above already declined it.
                needs.recovery(actor.id, SHELTER_REST_PER_MINUTE);
                heal(actor.id);
            }
        });
        active.coordinates.all().forEach((entry) => {
            if (seen.has(entry.id)) {
                return;
            }
            seen.add(entry.id);
            const task = tasks.taskOf(entry.id);
            if ((task?.kind === 'sleep' || task?.kind === 'rest') && sheltered(entry.id, entry.position)) {
                needs.recovery(entry.id, SHELTER_REST_PER_MINUTE);
                heal(entry.id);
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

        // R3 — the shelter service (see the ConstructionPlugin doc): the
        // built roofed gates, the same read the rest-bonus sweep uses.
        shelters: () => roofedGates(),

        // R3-INTEGRATION — the exposure flag beside the gate list (the
        // predators' bite gate + the survival flee read this)
        isSheltered: (entityId) => isSheltered(entityId),

        structures: () =>
            Array.from(structureRecords.values()).map((record) => ({
                siteId: record.siteId,
                blueprintId: record.blueprintId,
                sections: sectionsView(record),
            })),

        sectionsOf: (siteId) => {
            const record = structureRecords.get(siteId);
            return record ? sectionsView(record) : undefined;
        },

        orders: () => orders.map((order) => ({ ...order })),

        // R3 — the crew's hand-tool durability views (the declared
        // inspector/integration read): one entry per tool a living sentient
        // bag holds, health live off the wear ledger (keyed entity+tool,
        // plugins/inventory/toolDurability). The walk is the registry's
        // actor order × the TOOL_RECIPE_IDS order — deterministic. An
        // unbound plugin (or an empty cast) answers the empty list.
        tools: () => {
            const active = world;
            if (!active) {
                return [];
            }
            const views: Array<{
                actorId: string;
                tool: string;
                health: number;
                maxHealth: number;
                damage: number;
            }> = [];
            active.actors.forEach((actor) => {
                const bag = inventory.of(actor.id);
                toolDurabilityViews(active, actor.id, (toolId) => bag[toolId] ?? 0, TOOL_RECIPE_IDS).forEach(
                    (view) => {
                        views.push({ actorId: actor.id, ...view });
                    },
                );
            });
            return views;
        },

        orderRepair: (siteId, sectionId) => {
            const section = structureRecords
                .get(siteId)
                ?.sections.find((candidate) => candidate.id === sectionId);
            if (!section) {
                return undefined;
            }
            const existing = openOrderOf(siteId, sectionId);
            if (existing) {
                return { ...existing };
            }
            const opened = openOrder('repair', siteId, section);
            return opened ? { ...opened } : undefined;
        },

        orderUpgrade: (siteId, sectionId) => {
            const section = structureRecords
                .get(siteId)
                ?.sections.find((candidate) => candidate.id === sectionId);
            if (!section || !upgradeCost(section.tier)) {
                return undefined;
            }
            const existing = openOrderOf(siteId, sectionId);
            if (existing) {
                return { ...existing };
            }
            const opened = openOrder('upgrade', siteId, section);
            return opened ? { ...opened } : undefined;
        },

        launch: (siteId) => {
            const active = world;
            if (!active) {
                return undefined;
            }
            const site = sites.siteOf(siteId);
            if (!site || site.state !== 'built' || !VESSEL_BLUEPRINTS.includes(site.blueprintId)) {
                return undefined;
            }
            // THE MOORING — the launch needs SEA water beside the shore tile
            // the vessel was built on; a hull built inland cannot reach the
            // sea, and a hull built beside a fresh basin has no sea to sail
            // (R4 — the impassable lakes are water but not the sea)
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
                    if (cell && !cell.passable && isSeaWater(cell.biome)) {
                        waterNeighbors.push(neighbor);
                    }
                },
            );
            if (waterNeighbors.length === 0) {
                return undefined;
            }
            // THE MOORING TILE — the vessel floats on the sea neighbour, not
            // on the shore it was built on (the hull left the beach). The
            // scan order (west, east, north, south) makes the pick
            // deterministic for a given anchor
            const mooring = waterNeighbors[0];
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
                x: mooring.x,
                y: mooring.y,
                launchedAt: active.ticker.elapsed(),
            };
            moored.push(vessel);
            active.events.emit({
                kind: 'launch',
                message: `The ${vessel.label.toLowerCase()} is launched into the water at (${mooring.x}, ${mooring.y}).`,
            });
            return vessel;
        },

        setup: (context) => {
            const active = context.world;
            world = active;

            // R2 — resolve the fine terrain resolver from the world's plugin
            // roster (the scenario mounts the terrain plugin BEFORE
            // construction, so its setup — and its sub-grid machinery — is
            // live). A terrainless world (the toggled-off scenario) leaves
            // the resolver undefined: the placement scan then keeps the
            // legacy coarse-only gates and the center anchor.
            const terrainPlugin = active.plugins.get('island-terrain') as
                | (Pick<IslandTerrainPlugin, 'cellFor' | 'depth'> & WorldPlugin<World>)
                | undefined;
            fineTerrain =
                terrainPlugin && terrainPlugin.depth() > 0
                    ? (tileX, tileY, fx, fy) =>
                          terrainPlugin.cellFor([{ x: tileX, y: tileY }, { x: fx, y: fy }])
                    : undefined;

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
                    if (!site || site.state !== 'staged' || !carryingForSite(subject.actor.id, site)) {
                        return false;
                    }
                    // THE TOOL-LEAD HOLD (the draft half) — the actor leads
                    // an unmet early tool: the protection is PER-UNIT, the
                    // craft's own input count — the units the craft will
                    // consume stay in the bag (the effect below re-validates
                    // the same arithmetic at completion), and only the
                    // SURPLUS above them is a stageable haul. A lead holding
                    // wood 3 for the hammer's 2 still hauls the third; a
                    // lead whose bag is exactly its inputs hauls nothing
                    // (the input-only load that would draft the lead off the
                    // minute the 5-minute craft is waiting on — the seed-7
                    // axe starvation, see owedToolInputsOf).
                    const owed = owedToolInputsOf(subject.actor.id);
                    return site.required.some((line) => {
                        const remaining = line.count - (site.delivered[line.item] ?? 0);
                        if (remaining <= 0) {
                            return false;
                        }
                        const held = inventory.of(subject.actor.id)[line.item] ?? 0;
                        const protectedUnits = owed.find((input) => input.item === line.item)?.count ?? 0;
                        return held - protectedUnits > 0;
                    });
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
                    const spot = openSpot(site, actor.id);
                    if (!spot) {
                        return undefined;
                    }
                    const step = fineTargetStep(active, actor, { x: spot.tileX, y: spot.tileY }, { x: spot.x, y: spot.y });
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
                        // …and the finished BAG fits the bag. The gate
                        // mirrors the craft EFFECT's revalidation
                        // (outcome.stock = bag − inputs + outputs, see the
                        // 'craft' effect below): the conversion consumes the
                        // recipe's inputs FROM THE SAME HAND, so the
                        // post-craft total — not the current total plus the
                        // output — is what must fit. A bag full of EXACTLY
                        // the raw a recipe converts (the cloth's three
                        // fronds: eight − three + one = six) SHAVES the
                        // total and must stay craftable. The old
                        // `total + output` check wedged that bag for good:
                        // the craft is the ONLY rung that turns a raw the
                        // site lacks into the part it still owes (the
                        // deliver rung stages finished parts, the fetches
                        // take raw), so the refusal left a full hand with no
                        // path to free a slot for food — the needs rungs
                        // decline a full hand by design, the starvation
                        // drains the health and the carrier dies with
                        // berries one tile away (the long-march 6000-min
                        // deaths, seed 7: Bram @4,5 minute 3231 and Dune
                        // @3,5 — standing ON a bush cell — minute 3237, the
                        // boat owing its last cloth and rope).
                        {
                            const bag = inventory.of(subject.actor.id);
                            // R5 — the net change in WEIGHT: the post-craft
                            // carried weight (carried − inputs' weight +
                            // output's weight) must stay within the budget.
                            const inputWeight = recipe.inputs.reduce(
                                (sum, line) => sum + line.count * itemWeight(line.item),
                                0,
                            );
                            if (
                                inventoryWeight(bag) - inputWeight + output.count * itemWeight(output.item) >
                                inventory.capacityOf(subject.actor.id)
                            ) {
                                return false;
                            }
                        }
                        // …and the factory's own ingredient gate passes
                        return factory.appliesTo ? factory.appliesTo(subject) : true;
                    },
                };
                registered.push(`craft-${recipe.id}`);
                tasks.behaviour(composed);
            });

            // R4 — THE EARLY TOOL-CRAFT RUNG — one module per early tool
            // (TOOL_RECIPE_IDS: the axe, the hammer), each composed FROM the
            // core's stock craft factory exactly like the site recipes above,
            // with ONE island difference in the gate: the tools are built
            // ONCE PER TOOL — the gate is "no crew carries this tool yet"
            // (crewHasTool) instead of "the site still lacks it" (the build
            // projects do not consume tools, so the siteNeeds gate would
            // never fire for them). The plan returns the factory's kind
            // 'craft' task (payload.recipe), which the existing craft effect
            // below applies atomically (the registry revalidates the bag).
            // This is what makes the crew work with real equipment EARLY:
            // the axe appears in a castaway's bag before the long shelter /
            // house projects, speeding the lumber chop it feeds.
            arrayEach([...TOOL_RECIPE_IDS], ({ value: toolId }) => {
                const recipe = crafting.recipes().find((candidate) => candidate.id === toolId);
                if (!recipe) {
                    return;
                }
                const output = recipe.outputs[0];
                const factory = craftTaskBehaviour<TaskSubject>({
                    id: `tool-${toolId}`,
                    label: `crafts ${output.item}`,
                    priority: CRAFT_PRIORITY,
                    recipe: recipe.id,
                    inputs: recipe.inputs.map((line) => ({ item: line.item, count: line.count })),
                    minutes: Math.max(1, recipe.minutes),
                    // The factory's ingredient gate reads the LIVE bag — once
                    // the castaway has the axe's log + stone it may craft it
                    stockOf: (subject) => inventory.of(subject.actor.id),
                });
                const composed: TaskBehaviour = {
                    ...factory,
                    appliesTo: (subject) => {
                        if (subject.actor.kind === 'creature') {
                            return false;
                        }
                        // The craft ABILITY unlock (the same gate as site crafts)
                        if (!mayCraft(subject.actor.type)) {
                            return false;
                        }
                        // THE ONCE GATE — the crew already carries this tool →
                        // nothing to craft (the tool is a durable, shared
                        // concept: one axe in any bag ends the owed craft)
                        if (crewHasTool(output.item)) {
                            return false;
                        }
                        // THE DETERMINISTIC LEAD GATE — only the actor
                        // toolLeadOf computes may craft this tool (that check
                        // already folds in the creature/craft/bag-capacity AND
                        // full-input tests, in actor order, first match wins).
                        // Every other actor holding the same inputs DEFERS to
                        // the lead, so the once-gate is atomic within a minute
                        // (the old per-actor ingredient gate let two actors
                        // plan in the same minute and flood a duplicate tool).
                        const lead = toolLeadOf(toolId, recipe);
                        return lead?.id === subject.actor.id;
                    },
                };
                registered.push(`tool-${toolId}`);
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
                        // THE TOOL-LEAD HOLD — the actor leads an unmet early
                        // tool and this item is one of THOSE protected
                        // inputs: the underfoot fetch declines (the craft
                        // consumes exactly the recipe's count from this one
                        // bag, so a second copy serves nothing, and the
                        // 2-minute fetch beat is the beat the 5-minute craft
                        // is waiting on). Fetches of the item the actor does
                        // NOT lead with still serve the site.
                        if (owedToolInputsOf(subject.actor.id).some((input) => input.item === item)) {
                            return false;
                        }
                        const site = activeSite();
                        if (!site) {
                            return false;
                        }
                        // The demand gate: the site (OR an owed early tool)
                        // still lacks the item AND no single bag can already
                        // use what is needed — the EFFECTIVE demand folds in
                        // the tool's stone/wood so the crew gathers it early.
                        const demand = effectiveRawOf(site).find((line) => line.item === item);
                        if (!demand || crewMaxOf(item) >= demand.count) {
                            return false;
                        }
                        // THE BAG ROOM GATE — a full hand fetches nothing
                        if (inventoryWeight(inventory.of(subject.actor.id)) >= inventory.capacityOf(subject.actor.id)) {
                            return false;
                        }
                        // THE MINE GATE — stone demands the species' mine
                        // ability (the take would silently refuse it)
                        if (MINED_ITEMS.includes(item) && profiles && !profiles.hasAbility(subject.actor.type ?? '', 'mine')) {
                            return false;
                        }
                        // THE FORAGE GATE (R6) — the cell-taken renewables
                        // (vine, frond) demand the species' 'forage'
                        // ability, the same skill the tile job tags (the
                        // lumber 'chop' pattern); without profiles every
                        // hand may forage (the pre-entity fallback)
                        if (!MINED_ITEMS.includes(item) && profiles && !profiles.hasAbility(subject.actor.type ?? '', 'forage')) {
                            return false;
                        }
                        // THE item must stand underfoot — otherwise the
                        // materials module travels toward it
                        return (
                            (inventory.cellStock(subject.actor.position.x, subject.actor.position.y)[item] ?? 0) > 0
                        );
                    },
                    // R6 — the fetch is a SHARED TILE JOB, not a private
                    // countdown: the tile's unit for this material demands
                    // TAKE_MINUTES WORK-minutes in the tasks plugin's tile-
                    // work ledger (keyed `tileWorkKey(x, y, item)` — one job
                    // per tile per resource, so vine and stone on one tile
                    // are separate records). Every skilled hand's 1-minute
                    // beat banks a minute; the minutes survive pre-emption,
                    // death and walk-aways; ANY skilled contributor may
                    // finish it, and the take pays out only on the ATOMIC
                    // claim (the behavior plugin's gather effect sees the
                    // beat payload and rolls a failed payout back). The
                    // total labor per unit is exactly the old fetch's
                    // minutes — nothing weakened, only shared.
                    plan: (subject) => {
                        const actor = subject.actor;
                        const x = actor.position.x;
                        const y = actor.position.y;
                        openGatherJob(tasks.tileWork, {
                            x,
                            y,
                            item,
                            units: TAKE_MINUTES,
                            skill: MINED_ITEMS.includes(item) ? 'mine' : 'forage',
                        });
                        return {
                            kind: 'gather',
                            label: `takes ${item}`,
                            minutes: 1,
                            // The beat carries its item AND its tile — the
                            // claim takes exactly the job's kind, wherever
                            // the actor wanders by completion time
                            payload: { item, beat: true, x, y },
                        };
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
                    // THE TOOL-LEAD HOLD — the actor leads an unmet early
                    // tool (its bag holds the full input set): the seek/fell
                    // treks decline entirely. A trek would move the lead off
                    // its inputs' minute, and every beat spent walking to
                    // the site's next wood/stone is a beat the 5-minute
                    // craft waits behind. Its inputs are protected by the
                    // deliver hold above (they cannot be staged away), so
                    // sitting still loses nothing — the first idle minute
                    // the ladder falls past this rung to the tool-craft
                    // rung, which commits the craft.
                    if (owedToolInputsOf(subject.actor.id).length) {
                        return false;
                    }
                    const site = activeSite();
                    if (!site) {
                        return false;
                    }
                    const bag = inventory.of(subject.actor.id);
                    // THE BAG ROOM GATE — a full hand fetches nothing
                    if (inventoryWeight(bag) >= inventory.capacityOf(subject.actor.id)) {
                        return false;
                    }
                    // A raw fetch no single bag can already use (the
                    // strongest bag still lacks the full EFFECTIVE demand —
                    // the site's raw plus the owed tools', per-item max)
                    return effectiveRawOf(site).some(
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
                    // The EFFECTIVE demand (the site's raw plus the owed
                    // tools') drives the trek — a tool's stone/wood is
                    // sought just as hard as the site's.
                    const line = effectiveRawOf(site).find(
                        (candidate) => crewMaxOf(candidate.item) < candidate.count,
                    );
                    if (!line) {
                        return undefined;
                    }
                    // WOOD is felled off the trees — and the felling is the
                    // SAME shared tile job the lumber plugin works (R6): one
                    // chop record per tile (`tileWorkKey(x, y, 'chop')`),
                    // every skilled contributor adding a work-minute, the
                    // payout claimed atomically. A fell beat is ONE minute
                    // of that standing labor — the crew (and any passing
                    // lumber-chopper) push the same record forward.
                    if (line.item === 'wood') {
                        // THE SKILL GATE — no 'chop' ability, no felling
                        if (!mayChop(actor.type)) {
                            return undefined;
                        }
                        const key = tileWorkKey(actor.position.x, actor.position.y, CHOP_WORK_KIND);
                        // A standing job on this tile — join it
                        if (tasks.tileWork.get(key)) {
                            return { kind: 'fell', label: 'fells a tree', minutes: 1 };
                        }
                        const stock = inventory.cellStock(actor.position.x, actor.position.y);
                        if ((stock.tree ?? 0) > 0) {
                            // Open the job — the axe halves the demand at
                            // open (the same R4 rule the lumber chop applies)
                            const carriesAxe = (inventory.of(actor.id).axe ?? 0) > 0;
                            tasks.tileWork.open({
                                key,
                                kind: CHOP_WORK_KIND,
                                units: carriesAxe ? Math.max(1, Math.ceil(FELL_MINUTES / 2)) : FELL_MINUTES,
                                skill: 'chop',
                            });
                            return { kind: 'fell', label: 'fells a tree', minutes: 1 };
                        }
                        const grove = seekSource(actor, 'tree');
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
                    const source = seekSource(actor, line.item);
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
                        const spot = openSpot(site, subject.actor.id);
                        if (!spot) {
                            return undefined;
                        }
                        const step = fineTargetStep(active, subject.actor, { x: spot.tileX, y: spot.tileY }, { x: spot.x, y: spot.y });
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

            // MAINTAIN 15 (R4) — the upkeep of what already STANDS: one
            // module serves every open maintenance order (repair or upgrade)
            // on a BUILT structure. It plans the whole cycle for the FIRST
            // open order: fetch the order's material (the underfoot beat,
            // the trek — or BRICK through the built furnace, R3's kiln gate),
            // haul it to the footprint and STAGE it, then WORK the order one
            // world-minute stage at a time standing on the structure. The
            // cooperative rule holds: the whole crew serves the same order
            // (the first open one, creation order — deterministic). Below
            // the live projects (21) and social (20), above the lumber
            // chop (10): finished structures are mended after the plan's
            // own staging and work are served.
            registered.push('maintain');
            tasks.behaviour({
                id: 'maintain',
                label: 'Maintain',
                priority: MAINTAIN_PRIORITY,
                appliesTo: (subject) =>
                    subject.actor.kind !== 'creature' &&
                    // The upkeep is construction work — the same craft
                    // ability unlock the build rungs read
                    mayCraft(subject.actor.type) &&
                    orders.some((order) => order.state === 'open'),
                plan: (subject) => {
                    const active = world;
                    if (!active) {
                        return undefined;
                    }
                    // SERVICEABLE-ORDER SELECTION — the FIRST open order is
                    // not necessarily one this subject can serve: a brick
                    // upgrade with no BUILT furnace plans nothing (the kiln
                    // gate closes its fetch), and pinning the rung to that
                    // single order would starve every repair queued behind
                    // it forever (the review's blocked-upgrade case). Walk
                    // the open orders in registration order and take the
                    // FIRST one that yields a plan; the gates live inside
                    // planOrder, so a blocked order never bypasses one —
                    // it simply contributes no plan and the walk moves on.
                    let chosen: TaskSpec | undefined;
                    arrayEach(
                        orders.filter((candidate) => candidate.state === 'open'),
                        ({ value: order }) => {
                            const candidate = planOrder(active, subject.actor, order);
                            if (candidate !== undefined) {
                                chosen = candidate;
                                // arrayEach short-circuits on a DEFINED
                                // return — the first serviceable order wins
                                return chosen;
                            }
                        },
                    );
                    return chosen;
                },
            });

            // MEND 14 (R3) — the hand tools' autonomous upkeep, BELOW the
            // structure maintenance (15) and the live projects, ABOVE the
            // lumber chop (10): a worn tool is mended in the same gaps the
            // crew idles through, before it can break mid-campaign. The gate
            // reads the durability ledger (plugins/inventory/toolDurability —
            // keyed entity+tool beside the canonical bag counts): a held
            // tool worn past TOOL_REPAIR_TRIGGER (half sound) mends for one
            // wood + TOOL_REPAIR_WORK minutes — strictly cheaper than
            // crafting the replacement in both weight and work (the axe's
            // craft costs wood+stone at 5 minutes; the hammer's wood 2).
            // Deterministic: the first TOOL_RECIPE_IDS tool that is due.
            registered.push('mend');
            tasks.behaviour({
                id: 'mend',
                label: 'Mend',
                priority: MEND_PRIORITY,
                appliesTo: (subject) => {
                    if (subject.actor.kind === 'creature') {
                        return false;
                    }
                    // The mend is handwork — the same craft ability gate
                    if (!mayCraft(subject.actor.type)) {
                        return false;
                    }
                    const active = world;
                    if (!active) {
                        return false;
                    }
                    const bag = inventory.of(subject.actor.id);
                    // THE MATERIAL GATE (R3) — the mend is one wood +
                    // TOOL_REPAIR_WORK minutes: a hand without the raw never
                    // opens the order (the rung waits for the wood, exactly
                    // like the structure repair's staging)
                    if ((bag[TOOL_REPAIR_MATERIAL] ?? 0) <= 0) {
                        return false;
                    }
                    return mendableToolOf(active, subject.actor.id, bag) !== undefined;
                },
                plan: (subject) => {
                    const active = world;
                    if (!active) {
                        return undefined;
                    }
                    const bag = inventory.of(subject.actor.id);
                    const tool = mendableToolOf(active, subject.actor.id, bag);
                    if (tool === undefined) {
                        return undefined;
                    }
                    return {
                        kind: 'mend',
                        label: `mends the ${tool}`,
                        minutes: TOOL_REPAIR_WORK,
                        payload: { tool },
                    };
                },
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
                        // R3 — THE KILN GATE (the effect half): brick is
                        // FIRED at a furnace. The maintain rung planned the
                        // craft beside one; if the kiln was demolished (or
                        // the body wandered off) by completion, the inputs
                        // stay unspent — no brick without a kiln.
                        if (recipeId === 'brick' && !nearBuiltFurnace(actor.position)) {
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
                        // Capacity revalidated (R5 — in WEIGHT): a yield whose
                        // post-craft carried weight would not fit is discarded
                        // with the outcome (no conjured overflow)
                        if (inventoryWeight(outcome.stock) > inventory.capacityOf(actor.id)) {
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
                        // ONE work-minute into the SHARED tile job (the same
                        // record the lumber chop feeds — R6). The payout
                        // fires only on the atomic claim: exactly one
                        // contributor ever receives the finished job, and
                        // the harvest revalidates the standing tree and the
                        // bag room. A failed payout (a full bag, a
                        // co-worker's last pool unit) puts the standing work
                        // back for the next contributor — the minutes are
                        // never lost, the worker re-plans next minute.
                        const key = tileWorkKey(actor.position.x, actor.position.y, CHOP_WORK_KIND);
                        const unit = tasks.tileWork.add(key, 1);
                        if (!unit || unit.progress < unit.units) {
                            return;
                        }
                        const claimed = tasks.tileWork.complete(key);
                        if (!claimed) {
                            return;
                        }
                        // R2 — the same 3-wood chop payout the lumber rung
                        // pays (this feeds the SAME shared tile job, R6 —
                        // one job, one payout shape)
                        if (!inventory.harvest(actor, 'tree', 'wood', 3)) {
                            tasks.tileWork.put(claimed);
                            return;
                        }
                        // R3 — the tool wear rides the SUCCESSFUL payout (a
                        // tree actually felled): the feller's held axe spends
                        // toolWearPerUse('axe','fell') — 5 health per tree —
                        // through the durability ledger (keyed entity+tool,
                        // plugins/inventory/toolDurability). The canonical
                        // bag count gates the charge (an unheld axe is never
                        // worn) and the atomic break removes the last-health
                        // tool inside the same synchronous step.
                        useTool(active, actor.id, 'axe', 'fell', inventory.of(actor.id));
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
                        // THE TOOL-LEAD HOLD (the effect half) — revalidates
                        // the per-unit protection at COMPLETION against the
                        // LIVE bag: the units the craft itself will consume
                        // (the recipe's own input count, read fresh — a
                        // co-worker may have crafted the tool during the
                        // wait, releasing the obligation) stay in the bag,
                        // the surplus above them stages. The take therefore
                        // caps at `held − protected` as well as the site's
                        // remaining — the reviewer-repro site below (the
                        // wood 2 demand with the worker's wood 3 bag) still
                        // stages its snapshot unit exactly.
                        const owed = owedToolInputsOf(actor.id);
                        arrayEach(site.required, ({ value: line }) => {
                            const remaining = line.count - (site.delivered[line.item] ?? 0);
                            if (remaining <= 0) {
                                return;
                            }
                            const held = bag[line.item] ?? 0;
                            const protectedUnits = owed.find((input) => input.item === line.item)?.count ?? 0;
                            const take = Math.min(remaining, Math.max(0, held - protectedUnits));
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
                        // R3 — the tool wear rides the SUCCESSFUL build
                        // stage (a construction minute actually committed):
                        // the builder's held hammer spends
                        // toolWearPerUse('hammer','build') — 1 health per
                        // build minute — through the durability ledger. The
                        // canonical bag count gates the charge (no hammer,
                        // no wear) and the atomic break removes the tool at
                        // its last health point in the same step.
                        useTool(active, actor.id, 'hammer', 'build', inventory.of(actor.id));
                        return;
                    }
                    case 'stage': {
                        // R4 — stage the order's material onto the built
                        // structure's footprint (the maintenance analogue of
                        // 'deliver'). Revalidated at completion: the order
                        // is still open, the worker still stands on the
                        // footprint, and the take caps at the order's
                        // remaining units and the live bag — exact
                        // arithmetic, nothing conjured or lost.
                        const orderId = task.payload?.orderId;
                        if (typeof orderId !== 'string') {
                            return;
                        }
                        const order = orders.find((candidate) => candidate.id === orderId);
                        if (!order || order.state !== 'open') {
                            return;
                        }
                        const site = sites.siteOf(order.siteId);
                        if (!site || !atSite(actor, site)) {
                            return;
                        }
                        const bag = inventory.of(actor.id);
                        const remaining = order.units - order.staged;
                        const held = bag[order.item] ?? 0;
                        const take = Math.min(remaining, held);
                        if (take <= 0) {
                            return;
                        }
                        order.staged = order.staged + take;
                        inventoryRemove(bag, order.item, take);
                        return;
                    }
                    case 'maintain': {
                        // R4 — one world-minute stage of an order's work.
                        // The COMMIT lands when the order is fully staged
                        // AND fully worked: a repair resets the section's
                        // wear clock (the mended section stands sound — the
                        // consumed material bought its health back), an
                        // upgrade raises the tier AND resets the wear.
                        const orderId = task.payload?.orderId;
                        if (typeof orderId !== 'string') {
                            return;
                        }
                        const order = orders.find((candidate) => candidate.id === orderId);
                        if (!order || order.state !== 'open') {
                            return;
                        }
                        const site = sites.siteOf(order.siteId);
                        if (!site || !atSite(actor, site)) {
                            return;
                        }
                        order.workDone = order.workDone + 1;
                        if (order.workDone < order.work || order.staged < order.units) {
                            return;
                        }
                        const record = structureRecords.get(order.siteId);
                        const section = record?.sections.find(
                            (candidate) => candidate.id === order.sectionId,
                        );
                        if (!record || !section) {
                            // The structure left under the order (removed /
                            // launched) — the order closes unspent
                            order.state = 'done';
                            return;
                        }
                        if (order.kind === 'upgrade') {
                            const next = UPGRADE_LADDER[section.tier];
                            if (next) {
                                section.tier = next;
                            }
                        }
                        section.wornMinutes = 0;
                        order.state = 'done';
                        active.events.emit({
                            kind: 'maintain',
                            message:
                                order.kind === 'repair'
                                    ? `The crew repairs the ${record.blueprintId} (${section.id}) with ${order.units} ${order.item}.`
                                    : `The crew upgrades the ${record.blueprintId} (${section.id}) to ${section.tier}.`,
                        });
                        return;
                    }
                    case 'mend': {
                        // R3 — the tool mend COMMITS: the holder still
                        // carries the tool (the canonical bag count — a
                        // broken/lost tool never mends) and the raw wood;
                        // exactly one unit is consumed and the durability
                        // ledger resets (the consumed material bought the
                        // wear back — the repair-cheaper-than-craft rule:
                        // wood 1 + TOOL_REPAIR_WORK minutes against the
                        // axe's wood+stone 5-minute craft and the hammer's
                        // wood-2 craft). A lost tool or an empty wood stock
                        // mends nothing — the minutes were the cost, the
                        // same revalidate-at-completion discipline every
                        // construction effect keeps.
                        const tool = task.payload?.tool;
                        if (typeof tool !== 'string') {
                            return;
                        }
                        const bag = inventory.of(actor.id);
                        if ((bag[tool] ?? 0) <= 0 || (bag[TOOL_REPAIR_MATERIAL] ?? 0) <= 0) {
                            return;
                        }
                        inventoryRemove(bag, TOOL_REPAIR_MATERIAL, 1);
                        mendTool(active, actor.id, tool, bag);
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
            // R3/R4 — the structure ledger and the orders go with it (the
            // wear clock and the order counter restart with the next world)
            structureRecords.clear();
            orders.length = 0;
            orderCounter = 0;
            world = null;
        },

        tick: () => {
            // The plan cursor (place the next project / advance past a
            // finished one), then the structure sweep (R3/R4: section
            // anatomy for freshly built sites, the quarry's bedrock cut,
            // the wear clock, the auto-repair trigger), then the
            // sheltered-sleep bonus sweep
            placeOrAdvance();
            syncStructures();
            shelterRest();
        },
    };
};
