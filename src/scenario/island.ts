// The island scenario — assembles the stock plugin set into a ready world.
//
// This is the composition root of the god simulator: choose a seed, a tick
// size, how many actors wash ashore, and which environment plugins to mount.
// Every plugin is optional — drop `tasks` and the behavior plugin cannot
// mount at all (the agents plan through the ledger), so the actors stand
// still; drop `inventory` and there is nothing to gather, eat or trade.
//
// Two plugins come from the @godspace workspace packages (imported as
// dependencies, not source):
//   @godspace/core  — the coordinate system: the world's 3D spatial record
//                     (World.coordinates); castaways live on the ground
//                     plane, seabirds travel the Z axis
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
import { SCALE_DEFAULT, createScaleSystem, position3, type ScaleSystem } from '@godspace/core';
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
    type IslandTerrainOptions,
} from '../plugins/terrain/islandTerrain';
import { inventoryPlugin, type InventoryPlugin } from '../plugins/inventory/inventoryPlugin';
import { ITEM_TYPE_GLYPHS } from '../plugins/inventory/items';
import { needsPlugin, type NeedsPlugin, type NeedsPluginOptions } from '../plugins/needs/needsPlugin';
import { relationshipPlugin, type RelationshipPlugin } from '../plugins/relationship/relationshipPlugin';
import { behaviorPlugin } from '../plugins/behavior/behaviorPlugin';
import { tasksPlugin, type TasksPlugin } from '../plugins/tasks/tasksPlugin';
import { sleepPlugin, type SleepPlugin } from '../plugins/sleep/sleepPlugin';
import {
    birdsPlugin,
    BIRD_ALTITUDE_STATES,
    type BirdsPlugin,
} from '../plugins/birds/birdsPlugin';
import { sharksPlugin, SHARK_TYPE_GLYPH, type SharksPlugin } from '../plugins/sharks/sharksPlugin';
import type { Actor, TileResources } from '../engine/types';

export type IslandOptions = {
    /** Simulation seed — drives terrain, resources and all agent randomness. */
    seed?: number;
    /** Terrain generator options (width/height/seaLevel/…). */
    terrain?: IslandTerrainOptions;
    /** Needs pacing overrides (decay rates per world minute). */
    needs?: NeedsPluginOptions;
    /** How many actors wash ashore. Default 4, capped by the cast roster. */
    actorCount?: number;
    /** Plugin toggles — every environment module can be swapped out. */
    plugins?: {
        terrain?: boolean;
        inventory?: boolean;
        needs?: boolean;
        relationship?: boolean;
        /** The task ledger the agents plan through. Default on. */
        tasks?: boolean;
        behavior?: boolean;
        /** Timed sleep as a ledger behaviour (shadows the rest fallback). Default on. */
        sleep?: boolean;
        birds?: boolean;
        /** The sharks — water creatures swimming in past the edge. Default on. */
        sharks?: boolean;
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
    inventory: InventoryPlugin;
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
    /** Seabirds — the Z-axis travelers of the world. */
    birds: BirdsPlugin;
    /** Sharks — the water creatures that come in past the world edge. */
    sharks: SharksPlugin;
    /**
     * The view-scale ladder (@godspace/core src/scale) — anchored so scale 0
     * IS the island view (this engine's maximum view) and the ladder
     * reaches as deep as the terrain plugin generates sub-grids (scale +1
     * zooms a tile into its interior world — features/tileDetails.ts
     * scaleView). Zooming out past 0 is unreachable — there is no wider
     * view above this island in the simulation.
     *
     * The ladder is BOUND TO THE CLOCK (the scale-time rule): every move
     * re-times the step — 10 × 10^−scale world minutes per tick (scale 0 =
     * 10 min, scale +1 = 1 min, scale −1 = 100 min).
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

/** The stranded cast — markers are the first letters, all distinct. */
const CAST = ['Ael', 'Bram', 'Cove', 'Dune', 'Eir', 'Fenn'];

/** Starting kit: something to eat and a tool to work with. */
const STARTING_KIT = { berry: 2, flint: 1 };

// ── The scale-time rule ──────────────────────────────────────────────────────
// The view scale defines the step's world time — one zoom rung is one factor
// of 10: scale 0 steps 10 minutes, scale +1 (zoomed in) steps 1 minute, and
// a scale −1 (zoomed out) would step 100 minutes. The STEP SIZE is the only
// thing the scale changes: inside a step, the world always runs its minutes
// one at a time (engine/world.ts sub-stepping), so simulation behaviour is
// identical at every zoom level.
const SCALE_MINUTES = 10;

/** World minutes one step covers at the given view scale. */
export const minutesPerScaleStep = (scale: number): number => SCALE_MINUTES * Math.pow(10, -scale);

/**
 * ONE TILE takes 10 world minutes at scale 0 — the scale-0 step time
 * (minutesPerScaleStep(0)): a castaway that plans a move is busy exactly one
 * scale-0 step, and the move's effect lands on the completing step. The
 * travel cost is defined by THIS engine, not by @godspace/* — the task
 * ledger only counts the minutes down (plugins/tasks/taskLedger.ts).
 */
export const TRAVEL_MINUTES_PER_TILE = 10;

export const createIslandWorld = (options: IslandOptions = {}): IslandHandle => {
    // Plugin toggles default to all-on
    const toggles = {
        terrain: true,
        inventory: true,
        needs: true,
        relationship: true,
        tasks: true,
        behavior: true,
        sleep: true,
        birds: true,
        sharks: true,
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
    // agents plan through (plugins/tasks/taskLedger.ts); the sleep plugin
    // registers its timed-sleep behaviour into it and needs only tasks + needs.
    const terrain = islandTerrainPlugin(options.terrain ?? {});
    const inventory = inventoryPlugin();
    const needs = needsPlugin(options.needs ?? {});
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const sleep = sleepPlugin({ needs, tasks });
    const behavior = behaviorPlugin({
        inventory,
        needs,
        relationship,
        tasks,
        travelMinutesPerTile: TRAVEL_MINUTES_PER_TILE,
    });

    // The view-scale ladder — godspace/core owns the scale concept (which
    // depth reads as scale 0, the adjustable anchor); THIS engine anchors
    // scale 0 at its island view and reaches as deep as the terrain plugin
    // generates sub-grids (features/tileDetails.ts scaleView resolves them).
    // The default terrain produces one subtile level: scale 0 (the island,
    //     every tile of it) and scale 1 (each tile's interior sub-grid — same
    //     dimensions, 425×425 = 180,625 tiles on the default island). Bounded
    // below at 0 — there is no wider view above the island to zoom out to.
    // The core system is wrapped further down (after the world exists) so
    // every scale move can re-time the step clock.
    const scaleSystem = createScaleSystem({
        base: SCALE_DEFAULT,
        min: 0,
        max: toggles.terrain ? terrain.depth() : 0,
    });

    // ── Tile representation adapters ────────────────────────────────────────
    // The tiles appear as the RESOURCES they carry (scenario-wide rule for
    // all four @godspace/canvas representations): a tile's surface key is
    // derived from its deposits by the terrain plugin's tileSurfaceKey —
    // timber tiles, ore tiles, and the unlimited sand/dirt tiles — falling
    // back to the plain biome when the tile carries no resources (sea, or
    // finite deposits gathered away). Hover text keeps the biome/voxel
    // summary and appends the deposit line ("wood ×2 · sand ×∞").
    const surfaceOfCell = (cell: unknown): string | undefined =>
        tileSurfaceKey(cell as { biome?: string; resources?: TileResources });
    const titleOfCell = (cell: unknown): string => {
        const column = cell as { biome?: string; height?: number; voxels?: string[]; resources?: TileResources };
        const ground = `${column.biome} · height ${column.height} · ${(column.voxels ?? []).join(' / ')}`;
        const deposits = tileDepositSummary(column.resources);
        return deposits ? `${ground} · ${deposits}` : ground;
    };

    // The representation plugin from @godspace/canvas — binds itself through
    // the engine's plugin context (world.canvas + world.coordinates)
    const ascii = asciiCanvasPlugin({
        // Tiles appear as the resources they carry (see surfaceOfCell above)
        surfaceOf: surfaceOfCell,
        titleOf: titleOfCell,
        // The birds' altitude fade bands — flying-N states draw with their
        // hex-alpha tint (plugins/birds/birdsPlugin.ts BIRD_ALTITUDE_STATES)
        states: BIRD_ALTITUDE_STATES,
    });
    const birds = birdsPlugin();
    const sharks = sharksPlugin();
    // The unicode sibling binds the SAME structural slice as the ascii canvas
    // (same surfaceOf/titleOf adapters) — an emoji-skinned twin of the god view.
    // The type palette extends with ITEM_TYPE_GLYPHS so ground-item entries
    // (typed with the item id, see features/tileDetails scaleView) draw their
    // emoji in every zoomed view, plus SHARK_TYPE_GLYPH for the sharks
    const unicode = unicodeCanvasPlugin({
        surfaceOf: surfaceOfCell,
        titleOf: titleOfCell,
        types: { ...ITEM_TYPE_GLYPHS, ...SHARK_TYPE_GLYPH },
        states: BIRD_ALTITUDE_STATES,
    });
    // The svg sibling draws the same world as a scalable vector document —
    // same adapters, glyphs from the unicode ladder (with the item emoji and
    // the shark fin), geometry on the shared 26px tile grid (no layout
    // breakage between canvas tabs)
    const svg = svgCanvasPlugin({
        surfaceOf: surfaceOfCell,
        titleOf: titleOfCell,
        types: { ...ITEM_TYPE_GLYPHS, ...SHARK_TYPE_GLYPH },
        states: BIRD_ALTITUDE_STATES,
    });
    // The data sibling renders plain tables instead of tiles: every entity's
    // coordinates + the terrain census (also resource-keyed)
    const data = dataCanvasPlugin({
        surfaceOf: surfaceOfCell,
    });

    const mounted = [
        ...(toggles.terrain ? [terrain] : []),
        ...(toggles.inventory ? [inventory] : []),
        ...(toggles.needs ? [needs] : []),
        ...(toggles.relationship ? [relationship] : []),
        // The ledger advances BEFORE the behavior tick — a completed task's
        // effect (tasks.ledger.onComplete, see behaviorPlugin setup) lands on
        // the completing minute, then the idle actor re-plans the same minute
        ...(toggles.tasks ? [tasks] : []),
        ...(toggles.behavior && toggles.tasks && toggles.inventory && toggles.needs && toggles.relationship
            ? [behavior]
            : []),
        // Sleep registers its behaviour into the tasks ledger at setup and
        // restores energy AFTER the behavior tick (sleeping actors restore
        // while their task counts down)
        ...(toggles.sleep && toggles.tasks && toggles.needs ? [sleep] : []),
        ...(toggles.birds ? [birds] : []),
        // Sharks mount after the birds — the sea creatures tick behind the
        // air ones (fixed plugin order, scenario roster tests pin it)
        ...(toggles.sharks ? [sharks] : []),
        ...(toggles.ascii ? [ascii] : []),
        ...(toggles.unicode ? [unicode] : []),
        ...(toggles.svg ? [svg] : []),
        ...(toggles.data ? [data] : []),
    ];

    const world = createWorld({
        seed: options.seed ?? 1,
        plugins: mounted,
    });

    // ── Scale ↔ clock binding ── every move on the scale ladder re-times
    // the step (the scale-time rule): the ticker's minutes-per-tick always
    // reads 10 × 10^−scale. The five mutators wrap the core system — the
    // clamping/anchoring stays godspace/core's, the time sync rides along.
    const syncScaleTime = () => {
        world.ticker.tickSize(minutesPerScaleStep(scaleSystem.current()));
    };
    const scale: ScaleSystem = {
        ...scaleSystem,
        set: (value) => {
            const next = scaleSystem.set(value);
            syncScaleTime();
            return next;
        },
        setBase: (base) => {
            scaleSystem.setBase(base);
            syncScaleTime();
        },
        setRange: (range) => {
            scaleSystem.setRange(range);
            syncScaleTime();
        },
        zoomIn: () => {
            const next = scaleSystem.zoomIn();
            syncScaleTime();
            return next;
        },
        zoomOut: () => {
            const next = scaleSystem.zoomOut();
            syncScaleTime();
            return next;
        },
    };
    // The initial scale (0) sets the initial step time (10 minutes)
    syncScaleTime();

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
            const name = CAST[index];
            const actor: Actor = {
                id: `actor-${index + 1}`,
                name,
                // The cast are stranded people — sentients of the human race
                // (kind 'sentient', type 'human'; never the generic 'person',
                // future plugins may add orcs, elves, …)
                kind: 'sentient',
                type: 'human',
                position: position3(cell.x, cell.y),
                marker: name.slice(0, 1),
                condition: 'well',
            };
            world.spawn(actor);
            inventory.spawnKit(actor.id, STARTING_KIT);
        });
    }

    // The seabird launches after the cast, wheeling above the island center
    if (toggles.birds) {
        birds.release();
    }

    return { world, terrain, inventory, needs, relationship, tasks, sleep, birds, sharks, scale, ascii, unicode, svg, data };
};
