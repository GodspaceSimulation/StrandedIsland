// World resize settlement — the pure, framework-free half of the World Size
// feature (worldControls.tsx renders the panel).
//
// Resizing the canvas (terrain plugin `resize` + inventory `resurvey`) can
// leave residents stranded in two ways:
//   1. entities (castaways, seabirds) can end up OUTSIDE the new bounds
//   2. castaways can end up standing on water that used to be dry land
// settleAfterResize() clamps every coordinate-space resident back into the
// canvas and walks grounded castaways standing on water to the nearest dry
// cell (plane distance, ties break row-major top-left → deterministic).
//
// Centered coordinates: the canvas runs −half … +half on both axes (odd
// sizes only — the terrain plugin enforces this, see oddSize), so clamping
// bounds are ±(dim − 1) / 2.

import { grounded, planeDistance, position3 } from '@godspace/core';
import type { World } from '../engine/world';

/** What settlement did — id lists for the event log and tests. */
export type ResizeSettlement = {
    /** Resident ids pulled back inside the canvas bounds. */
    clamped: string[];
    /** Castaway ids walked to the nearest dry cell. */
    relocated: string[];
};

/** Local clamp — @presource/core has no numeric clamp utility. */
const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));

/**
 * Settles the whole coordinate space after a canvas resize:
 *   1. clamps every resident (castaway, bird, anything) into the new bounds
 *   2. relocates grounded castaways whose cell is gone or waterlogged to the
 *      nearest dry cell
 * Mutates the world in place; returns the report for the log/tests.
 */
export const settleAfterResize = (world: World): ResizeSettlement => {
    const canvas = world.canvas;
    // Centered bounds — odd dims make (dim − 1) / 2 exact
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    const clamped: string[] = [];
    const relocated: string[] = [];

    // Dry land, row-major from the top-left corner cell — the iteration
    // order makes distance-tie breaks deterministic (northernmost wins)
    const land = world.landCells();

    // 1. Clamp every coordinate-space resident into the new bounds. Castaways
    //    go through world.relocate (actor registry + coordinate record stay
    //    in sync); birds and any non-registry resident move in the spatial
    //    record directly.
    world.coordinates.all().forEach((entry) => {
        const x = clamp(entry.position.x, -halfX, halfX);
        const y = clamp(entry.position.y, -halfY, halfY);
        if (x !== entry.position.x || y !== entry.position.y) {
            clamped.push(entry.id);
            if (world.actors.has(entry.id)) {
                world.relocate(entry.id, position3(x, y, entry.position.z));
            } else {
                world.coordinates.move(entry.id, position3(x, y, entry.position.z));
            }
        }
    });

    // 2. Grounded castaways off dry land (out-of-bounds clamps or shrunken
    //    islands leave them on water) walk to the nearest dry cell — the
    //    same plane distance metric the behavior plugin navigates with
    world.actors.forEach((actor) => {
        const cell = world.cellAt(actor.position.x, actor.position.y);
        if (cell && cell.passable) {
            return;
        }
        let best = land[0];
        let bestDistance = Infinity;
        land.forEach((candidate) => {
            // Cells are plane footprints — compare at ground level
            const distance = planeDistance(actor.position, position3(candidate.x, candidate.y));
            if (distance < bestDistance) {
                best = candidate;
                bestDistance = distance;
            }
        });
        if (best) {
            // Castaways cannot fly or dig — the move lands grounded (z = 0)
            world.relocate(actor.id, grounded(position3(best.x, best.y)));
            relocated.push(actor.id);
        }
    });

    return { clamped, relocated };
};
