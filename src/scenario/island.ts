// The island scenario — assembles the stock plugin set into a ready world.
//
// This is the composition root of the god simulator: choose a seed, how many
// actors wash ashore, and which environment plugins to mount. Every plugin
// is optional — drop `tasks` and the behaviour plugins cannot mount at all
// (the agents plan through the ledger), so the actors stand still; drop
// `inventory` and there is nothing to gather, fell, drink or trade.
//
// The TASK LADDER is governed by behaviour plugins (the sampled conduct
// set): the behavior plugin mounts the survival needs rungs (thirst,
// hunger, rest, social, wander); the sleep, survival and lumber plugins
// each register one more governance slice into the same ledger (timed
// sleep, flee-from-wild-animals at the top rung, tree felling → wood).
//
// The engine core comes from the @godspace workspace packages (imported as
// dependencies, not source):
//   @godspace/core  — the ENGINE: the generic world container (coordinate
//                     record + entity registry + ticker + events + plugin
//                     roster) that the distribution inserts its entities
//                     into (engine/world.ts is the adapter). The coordinate
//                     system is the world's 3D spatial record
//                     (World.coordinates); castaways live on the ground
//                     plane, seabirds travel the Z axis. The scale system
//                     (the view ladder, Scale 0 the lowest level) also
//                     lives here.
//   @godspace/canvas — the representation plugins, bound and loaded by the
//                     engine to draw the god-view island: ASCII (glyph
//                     letters), Unicode (emoji), SVG (a scalable vector
//                     document) and Data (plain tables) — all four bind the
//                     SAME structural slice and stay drop-in interchangeable
//
// The returned handle exposes each plugin instance so the god-view (and
// tests) can drive the environment directly: force exchanges, inspect
// relationships, read the ASCII frame, regenerate the island, etc.

import { arrayEach } from '@presource/core';
import {
    createScaleSystem,
    position3,
    type CoordinateEntry,
    type ScaleSystem,
} from '@godspace/core';
import {
    asciiCanvasPlugin,
    unicodeCanvasPlugin,
    svgCanvasPlugin,
    dataCanvasPlugin,
    type AsciiCanvasPlugin,
    type UnicodeCanvasPlugin,
    type SvgCanvasPlugin,
    type DataCanvasPlugin,
} from '@godspace/canvas';
import { createWorld, type World } from '../engine/world';
import {
    islandTerrainPlugin,
    tileDepositSummary,
    tileSurfaceKey,
    RIVER_TILE_COLOR,
    type IslandTerrainOptions,
} from '../plugins/terrain/islandTerrain';
import { inventoryPlugin, type InventoryPlugin } from '../plugins/inventory/inventoryPlugin';
import { forestPlugin, type ForestPlugin, type ForestPacingOptions } from '../plugins/forest/forestPlugin';
import { ITEM_TYPE_GLYPHS } from '../plugins/inventory/items';
import { entityPlugin, type EntityPlugin } from '../plugins/entity/entityPlugin';
import { needsPlugin, type NeedsPlugin, type NeedsPluginOptions } from '../plugins/needs/needsPlugin';
import { relationshipPlugin, type RelationshipPlugin } from '../plugins/relationship/relationshipPlugin';
import { behaviorPlugin } from '../plugins/behavior/behaviorPlugin';
import { tasksPlugin, type TasksPlugin } from '../plugins/tasks/tasksPlugin';
import { sleepPlugin, type SleepPlugin } from '../plugins/sleep/sleepPlugin';
import { survivalPlugin, type SurvivalPlugin } from '../plugins/survival/survivalPlugin';
import { lumberPlugin, type LumberPlugin } from '../plugins/lumber/lumberPlugin';
import {
    constructionPlugin,
    STRUCTURE_TYPE_GLYPHS,
    type ConstructionPlugin,
} from '../plugins/construction/constructionPlugin';
// R5 — the farming governance: cultivated berry plots as the island's food
// floor (plugins/farming). Mounted beside the other ledger rungs; the
// handle exposes it so the god-view (board decor, inspector, legend) and the
// tests read the plots through the public API.
import { createFarmPlugin, type FarmingPlugin } from '../plugins/farming/farmingPlugin';
import { storyPlugin, type StoryPlugin } from '../plugins/story/storyPlugin';
import {
    birdsPlugin,
    BIRD_ALTITUDE_STATES,
    type BirdsPlugin,
} from '../plugins/birds/birdsPlugin';
import { sharksPlugin, SHARK_TYPE_GLYPH, type SharksPlugin } from '../plugins/sharks/sharksPlugin';
import {
    predatorsPlugin,
    BOAR_TYPE_GLYPH,
    type PredatorsPlugin,
} from '../plugins/predators/predatorsPlugin';
import type { Actor, Sex, TerrainCell, TileResources } from '../engine/types';
import { dominantVisibleType } from '../features/tileDetails';

export type IslandOptions = {
    /** Simulation seed — drives terrain, resources and all agent randomness. */
    seed?: number;
    /** Terrain generator options (width/height/seaLevel/…). */
    terrain?: IslandTerrainOptions;
    /**
     * Forest ecology pacing — the biology's maturity/recruitment/spread
     * rates (plugins/forest/forestPlugin.ts: research-backed defaults at
     * the REAL pace; growthRateMultiplier or the direct minute overrides
     * fast-forward the ecology without stepping millions of world minutes).
     */
    forest?: ForestPacingOptions;
    /** Needs pacing overrides (decay rates per world minute). */
    needs?: NeedsPluginOptions;
    /** How many actors wash ashore. Default 4, capped by the cast roster. */
    actorCount?: number;
    /** Plugin toggles — every environment module can be swapped out. */
    plugins?: {
        terrain?: boolean;
        /**
         * The entity profiles — the species registry every living thing
         * reads (stats, attributes, abilities, movement economics,
         * inventory sizes). Default on; dropping it leaves unlimited bags,
         * flat needs rates and free movement (the pre-entity behavior).
         */
        entity?: boolean;
        inventory?: boolean;
        /**
         * The forest ecology — trees grow wood biologically, stands
         * recruit and the woods spread over the grass. Needs terrain +
         * inventory (the stands live in the terrain plugin, the stock
         * mirrors + the harvest entry in the inventory plugin). Default on;
         * dropping it leaves a static forest (the legacy whole-tree
         * harvest, no growth/recruitment/spread).
         */
        forest?: boolean;
        needs?: boolean;
        relationship?: boolean;
        /** The task ledger the agents plan through. Default on. */
        tasks?: boolean;
        behavior?: boolean;
        /** Timed sleep as a ledger behaviour (shadows the rest fallback). Default on. */
        sleep?: boolean;
        /**
         * The flee-from-wild-animals behaviour (priority 60 — the highest
         * rung; a threat nearby pre-empts every other queue). Needs tasks +
         * behavior (the flee is a move task the behavior plugin applies).
         * Default on.
         */
        survival?: boolean;
        /**
         * The tree-felling behaviour (chop a tree → wood). Needs tasks +
         * inventory + behavior. Default on.
         */
        lumber?: boolean;
        /**
         * The construction governance — the build/craft rungs over the
         * shared @godspace blueprint/site/crafting registries (the seven
         * PLAN_ORDER projects: shelter, raft, house, boat, quarry, furnace,
         * fort). Needs tasks + behavior +
         * inventory + needs (its tasks ride the move/collect effects; the
         * staging reads the bags and the shelter bonus reads needs).
         * Default on.
         */
         construction?: boolean;
         /**
         * R5 — the farming governance — cultivated berry plots: actors
         * autonomously site, plant, tend and harvest plots that fruit on
         * the world clock (plugins/farming/farmingPlugin.ts). Needs tasks +
         * behavior + inventory + needs (the rungs ride the ledger and the
         * behavior planning sweep). Default on.
         */
         farming?: boolean;
        /**
         * The storyteller — scenario encounters sampled from the one-shot
         * deck, injected into the log as story blocks. Needs needs +
         * relationships. Default on.
         */
        story?: boolean;
        birds?: boolean;
        /** The sharks — water creatures swimming in past the edge. Default on. */
        sharks?: boolean;
        /** The wild boars — the land predators that maul castaways. Needs
         * needs (the bite drains energy). Default on. */
        predators?: boolean;
        /** The @godspace/canvas ASCII representation plugin. Default on. */
        ascii?: boolean;
        /** The @godspace/canvas unicode (emoji) representation. Default on. */
        unicode?: boolean;
        /** The @godspace/canvas svg (vector) representation. Default on. */
        svg?: boolean;
        /** The @godspace/canvas data (plain tables) representation. Default on. */
        data?: boolean;
    };
};

export type IslandHandle = {
    world: World;
    terrain: ReturnType<typeof islandTerrainPlugin>;
    /**
     * The entity profiles — the species registry: stats, attributes,
     * abilities, movement economics and inventory sizes for every living
     * thing (plugins/entity/entityPlugin.ts). The needs, inventory,
     * behavior and creature plugins read their per-type definitions
     * through it.
     */
    entity: EntityPlugin;
    inventory: InventoryPlugin;
    /**
     * The forest ecology plugin — trees grow wood biologically (the
     * persistent fine-scale stands), stands recruit (even clearcut — the
     * seed bank), and living mature woods spread over adjacent grass tiles
     * (plugins/forest/forestPlugin.ts). Exposes the wood pools, the chop
     * (the harvest provider mounted into the inventory) and the stand/tree
     * inspection the Tile Inspector reads, plus the fast-forward control.
     */
    forest: ForestPlugin;
    needs: NeedsPlugin;
    relationship: RelationshipPlugin;
    /**
     * The task ledger plugin — behaviours register here and actors work
     * timed tasks (plugins/tasks/taskLedger.ts). Present on the handle even
     * when unmounted, matching how the handle exposes every plugin instance.
     */
    tasks: TasksPlugin;
    /** The sleep behaviour plugin — priority-30 timed sleep. */
    sleep: SleepPlugin;
    /**
     * The survival behaviour plugin — priority-60 flee-from-wild-animals.
     * The highest rung of the task ladder: a boar or shark within threat
     * range pre-empts every other queue (the ledger's per-tick
     * prioritization).
     */
    survival: SurvivalPlugin;
    /** The lumber behaviour plugin — fells trees into wood (chop → bag). */
    lumber: LumberPlugin;
    /**
     * The construction plugin — the build/craft governance: the shared
     * @godspace/blueprint blueprint + site registries and the island's
     * crafting recipes over @godspace/material (plugins/construction/
     * constructionPlugin.ts). Exposes the registries, the active project,
     * the completed blueprint list, the moored vessels, the launch control
     * and the R3/R4 maintenance surface (sectionsOf / orderRepair /
     * orderUpgrade / orders) for the god-view and the tests.
     */
    construction: ConstructionPlugin;
    /**
     * R5 — the farming plugin — cultivated berry plots (plugins/farming/
     * farmingPlugin.ts): the autonomous plant/tend/harvest rungs, the plot
     * reads the god-view draws (plots / plotAt + FARM_STAGE_GLYPHS), the
     * eligibility check and the regeneration reset. Exposed on the handle
     * even when unmounted, matching every other plugin instance.
     */
    farming: FarmingPlugin;
    /**
     * The storyteller plugin — samples one unused scenario per encounter
     * (two castaways within the meeting ring), routes the play's profile
     * adjustments onto needs + relationships and injects the narrative
     * into the log as a story block.
     */
    story: StoryPlugin;
    /** Seabirds — the Z-axis travelers of the world. */
    birds: BirdsPlugin;
    /** Sharks — the water creatures that come in past the world edge. */
    sharks: SharksPlugin;
    /** The wild boars — the land predators that maul castaways. */
    predators: PredatorsPlugin;
    /**
     * The view-scale ladder (@godspace/core src/scale) — the ladder counts
     * UP from the lowest level: Scale 0 is the tile interior (the
     * simulation ground, where the castaways move around), and every
     * higher rung is a wider view. The ISLAND is the top of this engine's
     * ladder (scale = the terrain's subtile depth, one by default) and is
     * THE DEFAULT VIEW: Scale 1 shows where the Scale-0 entities are.
     * Zooming in on an inspected tile descends the ladder into its
     * interior (features/tileDetails.ts scaleView).
     *
     * The ladder is a PURE VIEW ladder — it does not re-time the clock
     * (the Scale-0 pacing rule above owns time: one world minute per
     * tick at every view).
     */
    scale: ScaleSystem;
    /** The ASCII canvas representation plugin (@godspace/canvas). */
    ascii: AsciiCanvasPlugin;
    /** The unicode canvas sibling — emoji glyphs, same binding contract. */
    unicode: UnicodeCanvasPlugin;
    /** The svg canvas sibling — a scalable vector document, same binding contract. */
    svg: SvgCanvasPlugin;
    /** The data canvas sibling — plain position/terrain tables. */
    data: DataCanvasPlugin;
};

/**
 * The stranded cast — markers are the first letters, all distinct. Each
 * castaway carries a fixed sex (their profile fact): the god-view draws it
 * (the gendered emoji on the unicode/svg canvases, the Entity Inspector's
 * profile row).
 */
const CAST: Array<{ name: string; sex: Sex }> = [
    { name: 'Ael', sex: 'male' },
    { name: 'Bram', sex: 'male' },
    { name: 'Cove', sex: 'female' },
    { name: 'Dune', sex: 'male' },
    { name: 'Eir', sex: 'female' },
    { name: 'Fenn', sex: 'male' },
];

/** Starting kit: something to eat and a tool to work with. */
const STARTING_KIT = { berry: 2, flint: 1 };

// ── The Scale-0 pacing rule ──────────────────────────────────────────────────
// The distribution defines the distance per tick and the time per tick:
//
//   TIME  — one tick carries ONE world minute (TICK_MINUTES, engine/world.ts:
//           the ticker steps 1 minute at a time, and a step's minutes always
//           sub-step one at a time). The view scale does NOT re-time the
//           clock — the scale ladder is a pure view ladder.
//   SPACE — one tick moves an entity ONE SCALE-0 TILE (one subtile cell of
//           the tile interior — the ground the simulation runs on). A move
//           task therefore costs exactly one tick: TRAVEL_MINUTES_PER_TILE.
//
// The simulation is done at Scale 0: entities move around in the Scale-0
// sub-grids (world.relocateFine — the world flows across tile boundaries),
// and the island view (Scale 1, the default view) shows where they are.
const TRAVEL_MINUTES_PER_TILE = 1;

/**
 * World minutes one tick covers at the Scale-0 pace — ONE (TICK_MINUTES,
 * engine/world.ts). Kept here as the scenario-level name for the pacing
 * rule so the task ledger and tests can pin against it.
 */
export const MINUTES_PER_TICK = 1;

export const createIslandWorld = (options: IslandOptions = {}): IslandHandle => {
    // Plugin toggles default to all-on
    const toggles = {
        terrain: true,
        entity: true,
        inventory: true,
        forest: true,
        needs: true,
        relationship: true,
        tasks: true,
        behavior: true,
        sleep: true,
        survival: true,
        lumber: true,
        construction: true,
        farming: true,
        story: true,
        birds: true,
        sharks: true,
        predators: true,
        ascii: true,
        unicode: true,
        svg: true,
        data: true,
        ...(options.plugins ?? {}),
    };

    // Build the environment modules. Behavior receives the plugin instances
    // it coordinates with — this wiring is the whole point of the plugin
    // architecture: swap any piece by removing it from the list below.
    // Behavior coordinates with tasks + inventory + needs + relationship, so
    // it only mounts when all four do. The tasks plugin is the ledger the
    // agents plan through (plugins/tasks/taskLedger.ts); the behaviour
    // plugins (sleep, survival, lumber) register their conduct slices into
    // it and coordinate with the pieces they act on.
    const terrain = islandTerrainPlugin(options.terrain ?? {});
    // The entity profiles — the species registry every living thing reads
    // (needs rates, bag sizes, abilities, movement economics)
    const entity = entityPlugin();
    // The profiles ride along only while the entity plugin is mounted —
    // dropping it drops the whole per-type vocabulary with it (unlimited
    // bags, flat rates, free movement)
    const profiles = toggles.entity ? entity : undefined;
    const inventory = inventoryPlugin({ profiles });
    // The forest ecology — trees grow wood, stands recruit, woods spread.
    // It coordinates the terrain plugin (the persistent fine-scale stands)
    // and the inventory plugin (the stock mirrors + the harvest entry); it
    // mounts its harvest provider into the inventory at setup.
    const forest = forestPlugin({ terrain, inventory }, options.forest ?? {});
    // The task ledger is declared BEFORE the needs plugin: the T6/R4 wiring
    // below hands the ledger into the needs options (the resting-metabolism
    // read), so the reference must already be initialized (the declared-after
    // order threw the temporal-dead-zone "Cannot access 'tasks' before
    // initialization" on every world creation).
    const tasks = tasksPlugin();
    // T6/R4 WIRING — the needs sweep reads the task ledger's head kinds to
    // run the RESTING metabolism (a body mid sleep/rest suspends its awake
    // hunger/thirst decay; the recovery service's equal charge is the
    // minute's whole spend — plugins/needs/needsPlugin.ts). The ledger rides
    // along only while the tasks plugin is mounted; needsOptions spread
    // first so an explicit option wins.
    const needs = needsPlugin({ ...options.needs, profiles, tasks: toggles.tasks ? tasks : undefined });
    const relationship = relationshipPlugin();
    // R3-INTEGRATION — the SHELTER TREK wiring: sleep reads the built
    // roofed gates through a DEFERRED callback (the scenario mounts sleep
    // before construction, so the reference resolves at plan time, after
    // every plugin stands — the construction const is in scope but not yet
    // initialized at this line; the arrow never runs before world creation
    // completes). With no roof standing the provider returns [] and every
    // body sleeps where it falls (the location-agnostic fallback).
    const sleep = sleepPlugin({
        needs,
        tasks,
        shelters: () => construction.shelters(),
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
    });
    const story = storyPlugin({ needs, relationship });
    const behavior = behaviorPlugin({
        inventory,
        needs,
        relationship,
        tasks,
        profiles,
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
    });
    // The behaviour plugins — each registers one conduct slice into the
    // ledger (the sampled behaviour set: thirst/hunger/rest/social/wander
    // ride the behavior plugin itself; sleep, survival and lumber are
    // separate governance plugins):
    //   survival — the flee rung (priority 60): needs the move effect the
    //     behavior plugin applies, so it mounts only beside it
    //   lumber   — the wood-production rung (priority 10): fells trees into
    //     wood; needs the inventory (harvest) and the move effect too
    // R3-INTEGRATION — the shelter gate: a body standing on a built roofed
    // gate does not bolt from the land beasts its walls keep out (the
    // deferred construction read — sleep's trek pattern; the flee rung
    // itself stays mounted and dominant for every other meeting)
    const survival = survivalPlugin({
        tasks,
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
        sheltered: toggles.construction ? (id) => construction.isSheltered(id) : undefined,
    });
    const lumber = lumberPlugin({
        inventory,
        tasks,
        // The species 'chop' ability gate (R6) — only skilled hands work
        // the woods (the entity profiles' work-kind unlock)
        profiles,
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
    });
    // The construction governance — the build/craft rungs over the shared
    // @godspace blueprint/site/crafting registries (plugins/construction).
    // Its rungs sit between rest (25) and social (20): needs always
    // interrupt construction, and the build projects are never starved by
    // small talk or the lumber rack's one-wood habit.
    const construction = constructionPlugin({
        inventory,
        needs,
        tasks,
        profiles,
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
    });
    // The wild boars — the land predators. The bite drains the victim's
    // energy AND wounds its health through the needs plugin (health at 0 is
    // death — a cornered castaway can bleed out); the entity profiles derive
    // the lumbering pace from the boar's Speed attribute and make roaming
    // burn the walk row. The tasks handle gates the roam against the boars'
    // own ledger tasks (planned creatures never double-step)
    // R3-INTEGRATION — the shelter gate on the bite too: a victim standing
    // behind a built roof's walls cannot be mauled through them (bounded
    // protection — the gate cell only, while the roof stands; the roll
    // stays consumed so the beast stream never shifts)
    const predators = predatorsPlugin({
        needs,
        profiles,
        tasks: toggles.tasks ? tasks : undefined,
        sheltered: toggles.construction ? (id) => construction.isSheltered(id) : undefined,
    });
    // R5 — the farming governance — cultivated berry plots (plugins/farming).
    // Declared after the ledger/inventory/needs trio it coordinates with;
    // its two rungs (farm 12, the hungry-hand harvest bridge 41) register
    // into the ledger at setup and ride the behavior planning sweep, so it
    // MOUNTS after behavior (see the mounted list). The 'forage' skill gate
    // reads the species profiles — the same work ability the wild gather
    // uses, no new ability coined.
    const farming = createFarmPlugin({
        tasks,
        inventory,
        needs,
        profiles,
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
    });

    // The view-scale ladder — godspace/core owns the scale concept (the
    // ladder counts UP from the lowest level: scale 0 the simulation
    // ground); THIS engine anchors its tile interior at the bottom and its
    // island view at the top (features/tileDetails.ts scaleView resolves
    // the zoomed slices). With the default terrain (one subtile level):
    // scale 0 = the tile interior (where the castaways walk) and scale 1 =
    // the island — THE DEFAULT VIEW (`view` = the ladder's top). Bounded
    // below at 0 — there is nothing more detailed than the generated
    // sub-grids; a terrain without subtiles is a single-rung ladder.
    const scaleSystem = createScaleSystem({
        min: 0,
        max: toggles.terrain ? terrain.depth() : 0,
        view: toggles.terrain ? terrain.depth() : 0,
    });

    // ── Tile representation adapters ────────────────────────────────────────
    // The tiles appear as the RESOURCES they carry (scenario-wide rule for
    // all four @godspace/canvas representations): a tile's surface key is
    // derived from its deposits by the terrain plugin's tileSurfaceKey —
    // treed tiles, ore tiles, and the unlimited sand/dirt tiles — falling
    // back to the plain biome when the tile carries no resources (sea, or
    // finite deposits gathered away). Hover text keeps the biome/voxel
    // summary and appends the deposit line ("tree ×2 · sand ×∞").
    // R6 — at the ISLAND view the tile's visible type is the MAJORITY of
    // its Scale-0 children's visible types (features/tileDetails.ts
    // dominantVisibleType — recursive down the generated ladder, counted in
    // child cells, row-major tie-break): a Scale-1 tile shows what its
    // zoomed interior actually looks like, not its parent-level deposit.
    // The identity check (the cell IS the terrain's root cell at these
    // coordinates) scopes the majority to ROOT cells — the adapter cannot
    // otherwise tell a root cell from a zoomed subtile, and the zoomed
    // views already show the true children cell-for-cell.
    const surfaceOfCell = (cell: unknown): string | undefined => {
        const slice = cell as { x?: number; y?: number; biome?: string; resources?: TileResources };
        if (
            slice.x !== undefined &&
            slice.y !== undefined &&
            terrain.cellFor([{ x: slice.x, y: slice.y }]) === (cell as TerrainCell)
        ) {
            // The terrain resolver the dominant-type read runs through
            // (the helper only needs the terrain plugin's grid resolution)
            return dominantVisibleType({ terrain }, [{ x: slice.x, y: slice.y }]) ?? tileSurfaceKey(slice);
        }
        return tileSurfaceKey(slice);
    };
    const titleOfCell = (cell: unknown): string => {
        const column = cell as { biome?: string; height?: number; voxels?: string[]; resources?: TileResources };
        const ground = `${column.biome} · height ${column.height} · ${(column.voxels ?? []).join(' / ')}`;
        const deposits = tileDepositSummary(column.resources);
        return deposits ? `${ground} · ${deposits}` : ground;
    };

    // ── Tile decorations — the standing ICONS the canvases draw ─────────────
    // A tile may carry a DECORATION on top of its color: the canvas plugins
    // expose it per tile (AsciiTile.decoration) and the god-views draw it.
    // TWO standing icons decorate today (see the resolver below for the
    // resolution order + the stock-driven rules):
    //   THE TREE — a treed tile (a standing tree deposit — the lumber
    //   behaviour's harvest target) decorates as 'tree', so the unicode tab
    //   draws the 🌳 tree emoji and the SVG tab draws the vector tree icon
    //   on every tile trees stand on — at every zoom level (the
    //   decorationOf adapter runs per-cell on each frame's canvas, zoomed
    //   slices included, where the tile's tree subtiles each decorate too).
    //   THE ROCK — a stone-bearing tile (a live finite stone stock — the
    //   localized rock sites) decorates as 'rock', so the unicode tab
    //   draws the 🪨 rock emoji and the SVG tab draws the vector rock icon
    //   on every tile that still carries mineable stone.
    // Tiles carrying NEITHER decorate nothing (color-only — the same
    // no-flood rule the terrain emoji fix established).
    // (Built STRUCTURES are NOT decorations — the decoration adapter cannot
    // tell a root cell from a zoomed subtile, and a structure is not a
    // per-cell surface anyway. The scaleView slice appends the structure
    // entries instead — tile-level at the island view, fine-cell level in
    // the interior views — drawn through the same STRUCTURE_TYPE_GLYPHS
    // type palette the entity glyphs resolve; see features/tileDetails.ts.)
    // R2 — a basin (lake/pond wetland) paints its WATER surface, so the
    // standing decorations are suppressed on it: the meadow-ingress stand
    // that seeded beneath the carved basin must not obscure the fresh-water
    // body (the canopy-on-water the reviewer flags). Non-basin treed tiles
    // keep their tree decoration (the R1 grass-land fringe stands
    // unaffected).
    // THE ROCK (R4 finite stone) — a tile with a LIVE STONE STOCK (the
    // localized rock sites — the highland peaks' STONE_PER_HIGHLAND stock,
    // the stone-guarantee's top-up/heap stock) decorates as 'rock', so the
    // unicode tab draws the 🪨 rock emoji and the SVG tab draws the vector
    // rock icon. The adapter runs per-cell on every frame's canvas — zoomed
    // slices included — and generateSubCanvas mirrors the parent's live
    // stone stock onto its fine cells (the crown-first boulder split, each
    // crowned/scattered fine cell carrying resources.stone = 1), so the
    // stone-bearing fine cells decorate 'rock' AT THE FINE SCALE too.
    // The icon is BINARY and stock-driven, not opacity-driven: a live stock
    // draws it, an empty stock hides it (decorationOfCell reads the frame
    // cell's CURRENT resources.stone, and the canvas re-derives every frame
    // — the parent's stock change also breaks the cached sub-grid's
    // fingerprint — so the icon drops the moment the tile's stock reaches
    // 0, at the island scale and the fine scale alike). Rock ranks ABOVE
    // tree: a mineable rock site is a gameplay landmark (the early tools
    // gate on stone), and the generator seeds no stands on the gravel
    // highlands, so a tree + rock co-occurrence is only theoretical today —
    // but if one ever lands, the 🪨 must not hide under the (coverage-
    // faded, possibly 0.1-opacity) tree canopy.
    const decorationOfCell = (cell: unknown): string | undefined => {
        const slice = cell as { x?: number; y?: number; biome?: string; resources?: TileResources };
        // R2/R4 — water paints its surface: the standing decorations are
        // suppressed on the basins AND the river courses (a tree or rock
        // icon on a flowing ford would read as dry ground; the river is
        // passable shallow WATER — its glyph budget is the color alone)
        if (slice.biome === 'lake' || slice.biome === 'pond' || slice.biome === 'river') {
            return undefined;
        }
        // R5 — THE FARM — a standing cultivated plot marks the tile with its
        // stage glyph ('farm' immature / 'farm-ripe'), read through the
        // plugin's public plotAt (the lazy clock-derived stage — the decor
        // re-derives every frame, so the plot visibly ripens). The farm
        // ranks ABOVE rock/tree: cultivated ground is the deliberate
        // feature (and eligibility already refuses boulder tiles, so the
        // rock co-occurrence cannot happen; a plot may share a treed tile
        // while the stand is being worked, and the farm is what the god
        // must see there). Root tiles only — plots are keyed to island-scale
        // addresses, so a zoomed fine cell (never equal to a root cell)
        // falls through to the stock rules (the identity check mirrors
        // surfaceOfCell above).
        if (
            slice.x !== undefined &&
            slice.y !== undefined &&
            terrain.cellFor([{ x: slice.x, y: slice.y }]) === (cell as TerrainCell)
        ) {
            const plot = farming.plotAt(slice.x, slice.y);
            if (plot) {
                return plot.stage === 'ripe' ? 'farm-ripe' : 'farm';
            }
        }
        // A live finite stone stock — the localized rock site — marks the
        // rock icon (the binary stock-driven rule above)
        if ((slice.resources?.stone ?? 0) > 0) {
            return 'rock';
        }
        return (slice.resources?.tree ?? 0) > 0 ? 'tree' : undefined;
    };

    // ── Profile glyphs — the gendered human emoji ───────────────────────────
    // The cast's PROFILE (engine/types ActorProfile) rides the coordinate
    // facet (engine/world.ts facetOf), and the unicode/svg canvases resolve
    // it per entry through their `glyphOf` override: a HUMAN's sex emoji
    // replaces the stock standing person (🧍 — UNICODE_TYPE_GLYPHS.human),
    // every other type (birds, boars, ground items) returns undefined and
    // falls through to the stock taxonomy ladder.
    const HUMAN_SEX_GLYPHS: Record<string, string> = {
        'human:male': '🧍‍♂️', // U+1F9CD U+200D U+2642 U+FE0F — person standing, male
        'human:female': '🧍‍♀️', // U+1F9CD U+200D U+2640 U+FE0F — person standing, female
    };
    const sexGlyphOf = (entry: CoordinateEntry): string | undefined =>
        entry.type && entry.sex ? HUMAN_SEX_GLYPHS[`${entry.type}:${entry.sex}`] : undefined;

    // ── The grass surface palette — the GROUND-SUPPLY identity ──────────────
    // A grass-voxel tile (every meadow, and the woods' substrate) surfaces
    // as 'grass' since the ground supply gained its own resource identity
    // (formerly it read as the dirt under it). The @godspace/canvas stock
    // palettes don't list the key — the island extends them here (meadow
    // kin — the grass ground reads as meadow green) without touching the
    // shared package.
    // R2 — the interior fresh-water basins (the lake/pond wetland biomes the
    // terrain generator carves) get their own water-blue tile colors beside
    // the grass ground identity
    const GRASS_TILE_COLOR = '#5f9450';
    const LAKE_TILE_COLOR = '#3f7fbf';
    const POND_TILE_COLOR = '#5aa0cf';
    const GRASS_TILE_PALETTE = {
        grass: GRASS_TILE_COLOR,
        lake: LAKE_TILE_COLOR,
        pond: POND_TILE_COLOR,
        // R4 — the meandering fresh-water courses surface with the terrain
        // plugin's own river color (single source of truth — the theme's
        // BIOME_COLORS.river joins the same export; the legend reads the
        // palette, so the swatch and the painted tiles can never disagree)
        river: RIVER_TILE_COLOR,
    };

    // The representation plugin from @godspace/canvas — binds itself through
    // the engine's plugin context (world.canvas + world.coordinates)
    const ascii = asciiCanvasPlugin({
        // Tiles appear as the resources they carry (see surfaceOfCell above)
        surfaceOf: surfaceOfCell,
        titleOf: titleOfCell,
        // Treed + rock-bearing tiles decorate (the ASCII view stays
        // color-only — the frame data carries the decoration for the
        // emoji/vector siblings)
        decorationOf: decorationOfCell,
        // The grass surface joins the palette (the ground-supply identity)
        tiles: GRASS_TILE_PALETTE,
        // The birds' altitude fade bands — flying-N states draw with their
        // hex-alpha tint (plugins/birds/birdsPlugin.ts BIRD_ALTITUDE_STATES)
        states: BIRD_ALTITUDE_STATES,
    });
    const birds = birdsPlugin({
        needs,
        profiles,
        // The ledger's busy gate — a perched bird with queued tasks skips
        // its takeoff/hop rolls (the behavior plugin plans grounded
        // creatures; two drivers would double-step the gull)
        tasks: toggles.tasks ? tasks : undefined,
    });
    // The sharks take the same busy gate — the behavior plugin plans the
    // water realm's non-travel rungs (the fish hunt underfoot, the spent
    // rest), and a busy shark skips its random swim that minute
    const sharks = sharksPlugin({
        needs,
        profiles,
        tasks: toggles.tasks ? tasks : undefined,
    });
    // The unicode sibling binds the SAME structural slice as the ascii canvas
    // (same surfaceOf/titleOf adapters) — an emoji-skinned twin of the god view.
    // The type palette extends with ITEM_TYPE_GLYPHS so ground-item entries
    // (typed with the item id, see features/tileDetails scaleView) draw their
    // emoji in every zoomed view, STRUCTURE_TYPE_GLYPHS so the construction
    // sites' footprint entries (typed with the blueprint id) draw theirs,
    // plus SHARK_TYPE_GLYPH for the sharks and BOAR_TYPE_GLYPH for the boars
    const unicode = unicodeCanvasPlugin({
        surfaceOf: surfaceOfCell,
        titleOf: titleOfCell,
        // Treed + rock-bearing tiles decorate — the unicode view draws the
        // 🌳 tree emoji and the 🪨 rock icon
        decorationOf: decorationOfCell,
        tiles: GRASS_TILE_PALETTE,
        types: {
            ...ITEM_TYPE_GLYPHS,
            ...STRUCTURE_TYPE_GLYPHS,
            ...SHARK_TYPE_GLYPH,
            ...BOAR_TYPE_GLYPH,
        },
        states: BIRD_ALTITUDE_STATES,
        // The gendered human emoji — the profile's sex resolves per entry
        glyphOf: sexGlyphOf,
    });
    // The svg sibling draws the same world as a scalable vector document —
    // same adapters, glyphs from the unicode ladder (with the item emoji,
    // the shark fin and the boar), geometry on the shared 26px tile grid
    // (no layout breakage between canvas tabs)
    const svg = svgCanvasPlugin({
        surfaceOf: surfaceOfCell,
        titleOf: titleOfCell,
        // Treed + rock-bearing tiles decorate — the SVG view draws the
        // vector tree icon and the vector rock icon
        decorationOf: decorationOfCell,
        tiles: GRASS_TILE_PALETTE,
        types: {
            ...ITEM_TYPE_GLYPHS,
            ...STRUCTURE_TYPE_GLYPHS,
            ...SHARK_TYPE_GLYPH,
            ...BOAR_TYPE_GLYPH,
        },
        states: BIRD_ALTITUDE_STATES,
        // The gendered human emoji — same per-entry sex resolver as unicode
        glyphOf: sexGlyphOf,
    });
    // The data sibling renders plain tables instead of tiles: every entity's
    // coordinates + the terrain census (also resource-keyed)
    const data = dataCanvasPlugin({
        surfaceOf: surfaceOfCell,
    });

    const mounted = [
        ...(toggles.terrain ? [terrain] : []),
        // The entity profiles mount right behind the terrain — the species
        // vocabulary the rest of the environment reads (its setup is data
        // only; plugin order is tick order and this plugin has no tick)
        ...(toggles.entity ? [entity] : []),
        ...(toggles.inventory ? [inventory] : []),
        // The forest ecology mounts right behind the inventory — its tick
        // advances the woods (growth is lazy; recruitment and spread run on
        // the staggered per-tile schedules) and its setup mounts the wood
        // harvest provider into the inventory
        ...(toggles.forest && toggles.terrain && toggles.inventory ? [forest] : []),
        ...(toggles.needs ? [needs] : []),
        ...(toggles.relationship ? [relationship] : []),
        // The ledger advances BEFORE the behavior tick — a completed task's
        // effect (tasks.ledger.onComplete, see behaviorPlugin setup) lands on
        // the completing minute, then the actor re-plans the same minute
        // (the behavior tick plans EVERY actor — the ledger pre-empts busy
        // queues only for strictly higher-priority behaviours)
        ...(toggles.tasks ? [tasks] : []),
        ...(toggles.behavior && toggles.tasks && toggles.inventory && toggles.needs && toggles.relationship
            ? [behavior]
            : []),
        // The behaviour governance plugins register into the tasks ledger at
        // setup, right behind the behavior ladder:
        //   sleep    — priority 30 timed sleep, restores energy AFTER the
        //              behavior tick (sleeping actors restore while their
        //              task counts down)
        //   survival — priority 60 flee (needs the behavior move effect)
        //   lumber   — priority 10 chop (needs the inventory + move effect)
        ...(toggles.sleep && toggles.tasks && toggles.needs ? [sleep] : []),
        ...(toggles.survival && toggles.tasks && toggles.behavior ? [survival] : []),
        ...(toggles.lumber && toggles.tasks && toggles.inventory && toggles.behavior ? [lumber] : []),
        // The construction governance mounts right behind the lumber rung
        // (the rungs register into the tasks ledger at setup; its tick runs
        // after the whole environment minute — the plan cursor places the
        // next project when nothing is live, and the sheltered-sleep bonus
        // reads the freshest task heads)
        ...(toggles.construction && toggles.tasks && toggles.behavior && toggles.inventory && toggles.needs
            ? [construction]
            : []),
        // R5 — the farming rungs mount right behind the construction block
        // (same governance shape: the modules register into the ledger at
        // setup and ride the behavior planning sweep; the plot growth is
        // clock-derived, so the plugin's tick only drives the siting trek
        // and the standing jobs — no ecology schedules to step)
        ...(toggles.farming && toggles.tasks && toggles.behavior && toggles.inventory && toggles.needs
            ? [farming]
            : []),
        // The storyteller runs after the whole environment minute (needs,
        // tasks, behavior, sleep) — an encounter reads the freshest state
        // and needs the needs + relationship systems
        ...(toggles.story && toggles.needs && toggles.relationship ? [story] : []),
        ...(toggles.birds ? [birds] : []),
        // Sharks mount after the birds, the boars after the sharks — the
        // creatures tick in their realm order (air, sea, land; fixed plugin
        // order, scenario roster tests pin it)
        ...(toggles.sharks ? [sharks] : []),
        ...(toggles.predators && toggles.needs ? [predators] : []),
        ...(toggles.ascii ? [ascii] : []),
        ...(toggles.unicode ? [unicode] : []),
        ...(toggles.svg ? [svg] : []),
        ...(toggles.data ? [data] : []),
    ];

    const world = createWorld({
        seed: options.seed ?? 1,
        plugins: mounted,
    });

    // ── Pure view ladder ── the scale system is returned as-is: the tick
    // carries its fixed world minute (TICK_MINUTES, engine/world.ts) at
    // every view, so no move on the ladder re-times the clock.
    const scale = scaleSystem;

    // Spawn the cast at the island's EDGE — the castaways' ship wrecked on
    // the coast, so everyone comes ashore on the outermost dry ring and
    // starts their journey inland from there. Positions are 3D coordinates
    // (@godspace/core) — castaways land on the ground plane, z = 0.
    // Deterministic: land cells rank by how close they sit to the canvas rim
    // (elliptical rim metric max(|x|/halfX, |y|/halfY), 1 at the rim → 0 at
    // the center), ties keep row-major order, then a row-major stride
    // spreads the cast along the ranked shore.
    const land = world.landCells();
    const count = Math.min(options.actorCount ?? 4, CAST.length, land.length);
    if (count > 0) {
        const halfX = (world.canvas.width - 1) / 2;
        const halfY = (world.canvas.height - 1) / 2;
        // Rim distance of a dry cell — the largest axis fraction; sorting
        // descending puts the outermost beach ring first
        const rimOf = (cell: { x: number; y: number }) =>
            Math.max(Math.abs(cell.x) / halfX, Math.abs(cell.y) / halfY);
        const edge = land
            .slice()
            .sort((left, right) => rimOf(right) - rimOf(left));
        const stride = Math.max(1, Math.floor(edge.length / count));
        arrayEach(Array.from({ length: count }, (_, index) => index), ({ value: index }) => {
            const cell = edge[index * stride];
            const cast = CAST[index];
            const actor: Actor = {
                id: `actor-${index + 1}`,
                name: cast.name,
                // The cast are stranded people — sentients of the human race
                // (kind 'sentient', type 'human'; never the generic 'person',
                // future plugins may add orcs, elves, …)
                kind: 'sentient',
                type: 'human',
                position: position3(cell.x, cell.y),
                marker: cast.name.slice(0, 1),
                condition: 'well',
                // The castaway's profile — the sex the god-view draws
                // (gendered emoji + the Entity Inspector's profile row)
                profile: { sex: cast.sex },
            };
            world.spawn(actor);
            inventory.spawnKit(actor.id, STARTING_KIT);
        });
    }

    // The seabird launches after the cast, wheeling above the island center
    if (toggles.birds) {
        birds.release();
    }

    return { world, terrain, entity, inventory, forest, needs, relationship, tasks, sleep, survival, lumber, construction, farming, story, birds, sharks, predators, scale, ascii, unicode, svg, data };
};
