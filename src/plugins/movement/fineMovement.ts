// Shared Scale-0 ground movement — the fine walk through the sub-grids.
//
// Extracted from the behavior plugin (plugins/behavior/behaviorPlugin.ts) so
// every task-queuing plugin plans and validates moves against the SAME
// rules. Every helper is a PURE read over the world — the caller applies the
// relocation (world.relocateFine) on task completion.
//
// The rules (the island engine's Scale-0 ground, scenario/island.ts):
//   SPACE — every move task walks the actor ONE SUBTILE CELL inside its
//           tile's sub-grid (world.relocateFine). A step that stays inside
//           the parent tile is free ground; a step off a tile edge WRAPS
//           into the neighbor tile (the @godspace/core subTile continuity
//           rule) and must find dry, unoccupied ground there.
//   OCCUPANCY — per Scale-0 tile: no two grounded entities stand on the same
//           subtile cell. Flyers (z > ground) never block — they are above
//           the Scale-0 ground.
//   TIME  — one Scale-0 tile move costs ONE world minute
//           (TRAVEL_MINUTES_PER_TILE, scenario/island.ts); the ledger only
//           counts the minutes down.

import { arrayEach } from '@presource/core';
import {
    GROUND_LEVEL,
    NEIGHBOR_OFFSETS,
    planeDistance,
    position3,
    subTileStep,
    type Position3D,
} from '@godspace/core';
import type { TerrainCell } from '../../engine/types';
import type { World } from '../../engine/world';
import type { TaskSpec } from '../tasks/taskLedger';

/**
 * The minimal mover shape the fine-step helpers read — an id (for occupancy
 * self-exclusion and the fine-spot derivation) and a position. EVERY living
 * thing fine-walks through these helpers: registry castaways satisfy it with
 * their full Actor record, and coordinate-space creatures (perched seabirds,
 * wild boars) planned through the task ledger pass as the same identity.
 */
export type FineMover = {
    id: string;
    position: Position3D;
};

/** Chebyshev distance — the grid step metric for "nearby" (plane only). */
export const chebyshev = (a: Position3D, b: Position3D): number => planeDistance(a, b);

/**
 * Nearest cell (from `candidates`) by Chebyshev distance.
 * Ties resolve to the earliest candidate — deterministic.
 */
export const nearestCell = (mover: FineMover, candidates: TerrainCell[]): TerrainCell | null => {
    let best: TerrainCell | null = null;
    let bestDistance = Infinity;
    arrayEach(candidates, ({ value: cell }) => {
        // Cells are plane footprints — compare at ground level (z = 0)
        const distance = chebyshev(mover.position, position3(cell.x, cell.y));
        if (distance < bestDistance) {
            best = cell;
            bestDistance = distance;
        }
    });
    return best;
};

/**
 * Whether another GROUNDED entity stands at (sx, sy) inside the tile at
 * (tileX, tileY) — the Scale-0 occupancy rule: no two entities stand on
 * the same subtile cell. The scan reads the whole coordinate space (the
 * single position registry), so registry actors AND coordinates-only
 * creatures (birds on the ground, wild beasts) block alike; flyers
 * (z > ground) never block — they are above the Scale-0 ground.
 */
export const fineSpotTaken = (
    world: World,
    selfId: string,
    tileX: number,
    tileY: number,
    sx: number,
    sy: number,
): boolean => {
    let taken = false;
    world.coordinates.all().forEach((other) => {
        if (
            other.id !== selfId &&
            other.position.x === tileX &&
            other.position.y === tileY &&
            other.position.z === GROUND_LEVEL
        ) {
            const otherSub = world.subOf(other.id);
            if (otherSub && otherSub.x === sx && otherSub.y === sy) {
                taken = true;
            }
        }
    });
    return taken;
};

/**
 * Whether the actor could fine-step (dx, dy) right now — a PURE read used
 * by both the planners and the completion effects (re-validation).
 * Resolves the actor's fine spot, runs the subTileStep wrap, and
 * validates the landing: interior steps need only a free fine spot;
 * wraps additionally need the crossed tile(s) dry. Returns the crossed
 * parent delta (the tile-crossing signal for the energy charge), or
 * undefined when the step is impossible.
 */
export const fineStep = (
    world: World,
    mover: FineMover,
    dx: number,
    dy: number,
): { parent: { dx: number; dy: number } } | undefined => {
    const canvas = world.canvas;
    if (canvas.width === 0 || canvas.height === 0) {
        return undefined;
    }
    const sub = world.subOf(mover.id);
    if (!sub) {
        return undefined;
    }
    // The continuity rule: the step wraps at the sub-grid edges and
    // reports the parent tile(s) it crossed
    const step = subTileStep(canvas.width, canvas.height, sub.x, sub.y, dx, dy);
    if (step.parent.dx !== 0 || step.parent.dy !== 0) {
        // The wrap crossed into neighbor tile(s) — they must be dry
        const crossed = world.cellAt(
            mover.position.x + step.parent.dx,
            mover.position.y + step.parent.dy,
        );
        if (!crossed || !crossed.passable) {
            return undefined;
        }
    }
    // The landing fine spot must be free of grounded actors (the tile
    // the step lands in: the current one, or the wrapped neighbor)
    const landingX = mover.position.x + step.parent.dx;
    const landingY = mover.position.y + step.parent.dy;
    if (fineSpotTaken(world, mover.id, landingX, landingY, step.x, step.y)) {
        return undefined;
    }
    return { parent: step.parent };
};

/**
 * One greedy fine step from the actor toward the target TILE (tx, ty):
 * preferred steps dx→0 then dy→0, diagonal fallback, then any valid fine
 * direction — chosen deterministically against the CURRENT occupancy.
 * Null when the actor cannot fine-step at all.
 */
export const greedyFineStep = (
    world: World,
    mover: FineMover,
    tx: number,
    ty: number,
): [number, number] | null => {
    const dx = Math.sign(tx - mover.position.x);
    const dy = Math.sign(ty - mover.position.y);

    // Preferred step directions, most direct first
    const preferred: Array<[number, number]> = [];
    if (dx !== 0) {
        preferred.push([dx, 0]);
    }
    if (dy !== 0) {
        preferred.push([0, dy]);
    }
    if (dx !== 0 && dy !== 0) {
        preferred.push([dx, dy]);
    }

    let step: [number, number] | null = null;
    arrayEach(preferred, ({ value: candidate }) => {
        if (!step && fineStep(world, mover, candidate[0], candidate[1])) {
            step = candidate;
        }
    });
    // Blocked toward the target — try any valid fine direction as
    // fallback (the mover mills toward the tile edge facing the target)
    if (!step) {
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            if (!step && fineStep(world, mover, offset.dx, offset.dy)) {
                step = [offset.dx, offset.dy];
            }
        });
    }
    return step;
};

/**
 * Travel spec toward a target tile: one fine step, `travel` world minutes
 * (the ledger counts them down — the distribution pins one Scale-0 tile
 * move per world minute). Undefined when no fine step toward the target
 * is currently possible.
 */
export const travelSpec = (
    world: World,
    mover: FineMover,
    label: string,
    target: TerrainCell,
    travel: number,
): TaskSpec | undefined => {
    const step = greedyFineStep(world, mover, target.x, target.y);
    if (!step) {
        return undefined;
    }
    return {
        kind: 'move',
        label,
        minutes: travel,
        payload: { dx: step[0], dy: step[1] },
    };
};
