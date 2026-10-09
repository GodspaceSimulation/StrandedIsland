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
 *
 * COMPLETED STRUCTURES BLOCK TOO (plugins/construction): a footprint that
 * finished building walls its cells off — the fine spot of a built site
 * refuses destination steps (the site's walkable GATE cell excepted, the
 * plugin's doorway rule). Planned (staged/building) footprints do NOT
 * block: their clearance is checked at placement (dry land, nobody
 * standing in the cells), and a body standing where a wall later rises
 * can always step OFF (only destinations are validated). The hook reads
 * the world's `structures` blocker — null without the construction
 * plugin, the pre-construction behavior.
 */
export const fineSpotTaken = (
    world: World,
    selfId: string,
    tileX: number,
    tileY: number,
    sx: number,
    sy: number,
): boolean => {
    if (world.structures?.blocksFineSpot(tileX, tileY, sx, sy)) {
        return true;
    }
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
 * One STRICT fine step from the actor toward the target TILE (tx, ty): the
 * preferred directions only, validated against the CURRENT occupancy — NO
 * mill fallback. `null` when none of the direct steps is possible right now.
 *
 * Where `greedyFineStep` serves the ground walkers' treks (a blocked walker
 * mills toward the tile edge until the block clears), the strict variant
 * serves rungs whose target may be UNREACHABLE for the mover's realm: a
 * water-locked body would mill inside its tile forever (a busy body every
 * minute — the busy gate of its own movement plugin would never re-open).
 * Declining instead leaves the body idle: its realm script (the birds
 * plugin's hops, the sharks plugin's swim) moves it, and the next minute
 * re-plans. Used by the roost behaviour (plugins/behavior — the bird's safe
 * sleep trek toward the trees).
 */
export const strictFineStep = (
    world: World,
    mover: FineMover,
    tx: number,
    ty: number,
): [number, number] | null => {
    const dx = Math.sign(tx - mover.position.x);
    const dy = Math.sign(ty - mover.position.y);

    // Preferred step directions, most direct first (the greedy walker's
    // ladder minus the any-direction fallback)
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
    return step;
};

/**
 * THE TILE HOP (the peninsula livelock fix) — the NEXT tile on a
 * breadth-first walk over the PASSABLE tile grid from the mover's tile to
 * the target tile. The greedy walkers step toward the TARGET TILE, and a
 * tile ringed by water on the target side (the seed-7 hauler frozen at
 * (-3,-3) facing the shelter at (-4,-1): the west and north neighbours are
 * sea, the walker ping-pongs one fine row forever) has no direct step —
 * the fallback mills, never COMMITS around the bay. The hop re-points the
 * greedy ladder at the first tile of a real route, so the body walks the
 * route instead of the straight line. Null when already on the target
 * tile, when the target tile is unreachable (water-locked or impassable —
 * the caller keeps its old greedy behaviour), or off-canvas.
 *
 * 4-neighbour hops only: a diagonal tile crossing wraps two boundaries and
 * fineStep validates only the corner cell, so the route stays orthogonal
 * (a hair longer, never corner-cutting through wet).
 */
export const tilePathHop = (
    world: World,
    from: { x: number; y: number },
    to: { x: number; y: number },
): { x: number; y: number } | null => {
    if (from.x === to.x && from.y === to.y) {
        return null;
    }
    const key = (x: number, y: number): string => `${x},${y}`;
    // BFS with a came-from trail over the passable tile grid (the island
    // canvas is small — a full sweep is cheap, no bound needed)
    const cameFrom = new Map<string, string>();
    const queue: Array<{ x: number; y: number }> = [from];
    cameFrom.set(key(from.x, from.y), '');
    let head = 0;
    let found = false;
    while (head < queue.length) {
        const current = queue[head];
        head = head + 1;
        if (current.x === to.x && current.y === to.y) {
            found = true;
            break;
        }
        for (const [ox, oy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]) {
            const nx = current.x + ox;
            const ny = current.y + oy;
            if (cameFrom.has(key(nx, ny))) {
                continue;
            }
            const cell = world.cellAt(nx, ny);
            if (!cell || !cell.passable) {
                continue;
            }
            cameFrom.set(key(nx, ny), key(current.x, current.y));
            queue.push({ x: nx, y: ny });
        }
    }
    if (!found) {
        return null;
    }
    // Walk the trail BACK from the target until the node whose parent is
    // the start — that node is the first hop of the route
    let cursor = key(to.x, to.y);
    let hop = to;
    const startKey = key(from.x, from.y);
    while (cameFrom.get(cursor) !== undefined && cameFrom.get(cursor) !== startKey) {
        const [px, py] = (cameFrom.get(cursor) as string).split(',').map(Number);
        cursor = key(px, py);
        hop = { x: px, y: py };
    }
    return hop;
};

/**
 * One greedy fine step from the actor toward the target TILE (tx, ty):
 * preferred steps dx→0 then dy→0, diagonal fallback, then any valid fine
 * direction — chosen deterministically against the CURRENT occupancy.
 * Null when the actor cannot fine-step at all.
 *
 * HOP-BOOKED: when the mover's tile differs from the target tile, the
 * greedy ladder aims at tilePathHop's first route tile instead of the
 * straight-line target (the peninsula fix above); on the target tile the
 * direct greedy stands (the fine milling to the exact spot is local).
 */
export const greedyFineStep = (
    world: World,
    mover: FineMover,
    tx: number,
    ty: number,
): [number, number] | null => {
    const hop = tilePathHop(world, mover.position, { x: tx, y: ty });
    const aimX = hop ? hop.x : tx;
    const aimY = hop ? hop.y : ty;
    const dx = Math.sign(aimX - mover.position.x);
    const dy = Math.sign(aimY - mover.position.y);

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

/**
 * ONE FINE-CELL TARGET — the exact spot the construction workers stand on
 * (a site's walkable GATE cell, plugins/construction). The island's fine
 * coordinates are CONTIGUOUS across tiles: tile tx's sub-grid runs
 * tx·width − half … tx·width + half, so tile (tx) cell (fx) reads as the
 * global fine coordinate tx·width + fx and the whole ground is one plane.
 */
export const fineSpotAddress = (
    tileX: number,
    tileY: number,
    x: number,
    y: number,
    grid: { width: number; height: number },
): { x: number; y: number } => ({
    x: tileX * grid.width + x,
    y: tileY * grid.height + y,
});

/**
 * One greedy fine step toward an EXACT FINE CELL (a tile plus the subtile
 * inside it) — the fine-grained twin of greedyFineStep. Preferred
 * directions first (toward the target on each axis, then the diagonal),
 * validated against the CURRENT occupancy and structure walls; a blocked
 * approach falls back to any valid fine direction (the mover mills toward
 * the target until the block clears). Null when the mover cannot step at
 * all. Used by the construction behaviours (deliver/build) whose work
 * happens ON the gate cell — the tile-level trek would stop a whole tile
 * short of the spot the staging actually happens on.
 */
export const fineTargetStep = (
    world: World,
    mover: FineMover,
    targetTile: { x: number; y: number },
    targetFine: { x: number; y: number },
): [number, number] | null => {
    const sub = world.subOf(mover.id);
    if (!sub) {
        return null;
    }
    // HOP-BOOKED like greedyFineStep: OFF the target tile the ladder aims
    // at the first tile of the BFS route (the peninsula livelock fix - the
    // straight-line fine aim walks the body into a water-locked edge and
    // mills it there forever); once ON the target tile the exact fine spot
    // is the aim (the local approach to the gate cell)
    const hop = tilePathHop(world, mover.position, targetTile);
    let dx: number;
    let dy: number;
    if (hop) {
        dx = Math.sign(hop.x - mover.position.x);
        dy = Math.sign(hop.y - mover.position.y);
    } else {
        const here = fineSpotAddress(mover.position.x, mover.position.y, sub.x, sub.y, world.canvas);
        const there = fineSpotAddress(targetTile.x, targetTile.y, targetFine.x, targetFine.y, world.canvas);
        dx = Math.sign(there.x - here.x);
        dy = Math.sign(there.y - here.y);
    }

    // Preferred steps, most direct first (the greedy walker's ladder)
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
    // Blocked toward the target — mill toward it along any open direction
    // (deterministic NEIGHBOR_OFFSETS order)
    if (!step) {
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            if (!step && fineStep(world, mover, offset.dx, offset.dy)) {
                step = [offset.dx, offset.dy];
            }
        });
    }
    return step;
};
