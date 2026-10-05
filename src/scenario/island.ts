// The island scenario — assembles the stock plugin set into a ready world.
//
// This is the composition root of the god simulator: choose a seed, a tick
// size, how many actors wash ashore, and which environment plugins to mount.
// Every plugin is optional — drop `behavior` and the actors stand still;
// drop `inventory` and there is nothing to gather, eat or trade.
//
// Two plugins come from the @godspace workspace packages (imported as
// dependencies, not source):
//   @godspace/core  — the coordinate system: the world's 3D spatial record
//                     (World.coordinates); castaways live on the ground
//                     plane, seabirds travel the Z axis
//   @godspace/canvas — the ASCII canvas representation plugin, bound and
//                     loaded by the engine to draw the god-view island
//
// The returned handle exposes each plugin instance so the god-view (and
// tests) can drive the environment directly: force exchanges, inspect
// relationships, read the ASCII frame, regenerate the island, etc.

import { arrayEach } from '@presource/core';
import { position3 } from '@godspace/core';
import {
    asciiCanvasPlugin,
    unicodeCanvasPlugin,
    dataCanvasPlugin,
    type AsciiCanvasPlugin,
    type UnicodeCanvasPlugin,
    type DataCanvasPlugin,
} from '@godspace/canvas';
import { createWorld, type World } from '../engine/world';
import { islandTerrainPlugin, type IslandTerrainOptions } from '../plugins/terrain/islandTerrain';
import { inventoryPlugin, type InventoryPlugin } from '../plugins/inventory/inventoryPlugin';
import { needsPlugin, type NeedsPlugin, type NeedsPluginOptions } from '../plugins/needs/needsPlugin';
import { relationshipPlugin, type RelationshipPlugin } from '../plugins/relationship/relationshipPlugin';
import { behaviorPlugin } from '../plugins/behavior/behaviorPlugin';
import { birdsPlugin, type BirdsPlugin } from '../plugins/birds/birdsPlugin';
import type { Actor } from '../engine/types';

export type IslandOptions = {
    /** Simulation seed — drives terrain, resources and all agent randomness. */
    seed?: number;
    /** Minutes of world time per tick. Default 10. */
    tickSize?: number;
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
        behavior?: boolean;
        birds?: boolean;
        /** The @godspace/canvas ASCII representation plugin. Default on. */
        ascii?: boolean;
        /** The @godspace/canvas unicode (emoji) representation. Default on. */
        unicode?: boolean;
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
    /** Seabirds — the Z-axis travelers of the world. */
    birds: BirdsPlugin;
    /** The ASCII canvas representation plugin (@godspace/canvas). */
    ascii: AsciiCanvasPlugin;
    /** The unicode canvas sibling — emoji glyphs, same binding contract. */
    unicode: UnicodeCanvasPlugin;
    /** The data canvas sibling — plain position/terrain tables. */
    data: DataCanvasPlugin;
};

/** The stranded cast — markers are the first letters, all distinct. */
const CAST = ['Ael', 'Bram', 'Cove', 'Dune', 'Eir', 'Fenn'];

/** Starting kit: something to eat and a tool to work with. */
const STARTING_KIT = { berry: 2, flint: 1 };

export const createIslandWorld = (options: IslandOptions = {}): IslandHandle => {
    // Plugin toggles default to all-on
    const toggles = {
        terrain: true,
        inventory: true,
        needs: true,
        relationship: true,
        behavior: true,
        birds: true,
        ascii: true,
        unicode: true,
        data: true,
        ...(options.plugins ?? {}),
    };

    // Build the environment modules. Behavior receives the plugin instances
    // it coordinates with — this wiring is the whole point of the plugin
    // architecture: swap any piece by removing it from the list below.
    // Behavior coordinates with inventory + needs + relationship, so it only
    // mounts when all three do.
    const terrain = islandTerrainPlugin(options.terrain ?? {});
    const inventory = inventoryPlugin();
    const needs = needsPlugin(options.needs ?? {});
    const relationship = relationshipPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship });
    // The representation plugin from @godspace/canvas — binds itself through
    // the engine's plugin context (world.canvas + world.coordinates)
    const ascii = asciiCanvasPlugin({
        // The island's ground cells key their surface by biome
        surfaceOf: (cell) => (cell as { biome?: string }).biome,
        titleOf: (cell) => {
            const column = cell as { biome?: string; height?: number; voxels?: string[] };
            return `${column.biome} · height ${column.height} · ${(column.voxels ?? []).join(' / ')}`;
        },
    });
    const birds = birdsPlugin();
    // The unicode sibling binds the SAME structural slice as the ascii canvas
    // (same surfaceOf/titleOf adapters) — an emoji-skinned twin of the god view
    const unicode = unicodeCanvasPlugin({
        surfaceOf: (cell) => (cell as { biome?: string }).biome,
        titleOf: (cell) => {
            const column = cell as { biome?: string; height?: number; voxels?: string[] };
            return `${column.biome} · height ${column.height} · ${(column.voxels ?? []).join(' / ')}`;
        },
    });
    // The data sibling renders plain tables instead of tiles: every entity's
    // coordinates + the terrain census (also biome-keyed)
    const data = dataCanvasPlugin({
        surfaceOf: (cell) => (cell as { biome?: string }).biome,
    });

    const mounted = [
        ...(toggles.terrain ? [terrain] : []),
        ...(toggles.inventory ? [inventory] : []),
        ...(toggles.needs ? [needs] : []),
        ...(toggles.relationship ? [relationship] : []),
        ...(toggles.behavior && toggles.inventory && toggles.needs && toggles.relationship
            ? [behavior]
            : []),
        ...(toggles.birds ? [birds] : []),
        ...(toggles.ascii ? [ascii] : []),
        ...(toggles.unicode ? [unicode] : []),
        ...(toggles.data ? [data] : []),
    ];

    const world = createWorld({
        seed: options.seed ?? 1,
        tickSize: options.tickSize ?? 10,
        plugins: mounted,
    });

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

    return { world, terrain, inventory, needs, relationship, birds, ascii, unicode, data };
};
