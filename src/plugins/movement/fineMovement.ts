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
//   WATER (R2) — NO GROUND BODY EVER ENTERS WATER. Every landing is resolved
//           at the FINE scale (the tile's zoomed interior — shore waterlines
//           and river channels are real water even when the parent tile is
//           dry ground), INCLUDING steps that stay inside the parent tile;
//           a diagonal step additionally refuses to cut a water corner (both
//           fine cells sharing the corner must be dry). The water vocabulary
//           is engine/types isWalkableCell — passable AND not a water biome —
//           so a river (still flagged passable for resource compatibility)
//           blocks exactly like the sea and the basins. ESCAPE IS ALLOWED:
//           only the DESTINATION is validated, so a body stranded on an
//           invalid (wet) cell can always step OUT onto dry ground.
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
import { isWalkableCell, type TerrainCell } from '../../engine/types';
import type { World } from '../../engine/world';
import type { TaskSpec } from '../tasks/taskLedger';
import type { IslandTerrainPlugin } from '../terrain/islandTerrain';

/**
 * The terrain plugin's fine-cell surface (plugins/terrain/islandTerrain.ts):
 * `cellFor([{tile},{fine}])` resolves one cell of a tile's zoomed interior and
 * `depth()` says whether any sub-grid level exists at all. Read off the
 * world's plugin roster (the construction plugin's pattern) instead of a new
 * world hook — movement needs the SAME resolver the builders site against.
 */
type FineTerrainHandle = Pick<IslandTerrainPlugin, 'cellFor' | 'depth'>;

/**
 * The world's fine terrain resolver, or null when the world has no terrain
 * plugin / a depth-0 ladder (no interiors to resolve). Re-read per call: the
 * terrain plugin may be removed or re-installed at runtime, and the roster
 * lookup is a scan of a handful of entries.
 */
export const fineTerrainOf = (world: World): FineTerrainHandle | null => {
    const plugin = world.plugins.get('island-terrain') as FineTerrainHandle | undefined;
    if (!plugin || plugin.depth() <= 0) {
        return null;
    }
    return plugin;
};

/**
 * GLOBAL FINE ADDRESS — the island's fine coordinates are CONTIGUOUS across
 * tiles (see fineSpotAddress below): tile tx's sub-grid runs tx·width − half
 * … tx·width + half, so the whole ground is one plane and a step can be
 * validated in a single coordinate space instead of per-tile special cases.
 */
export const fineGlobalAddress = (
    tileX: number,
    tileY: number,
    fx: number,
    fy: number,
    grid: { width: number; height: number },
): { x: number; y: number } => ({
    x: tileX * grid.width + fx,
    y: tileY * grid.height + fy,
});

/**
 * Decomposes one GLOBAL fine coordinate back into its tile + fine address —
 * the inverse of fineGlobalAddress (floor division by the axis span). The
 * water read and the fine route planner both need this split.
 */
export const fineAddressOf = (
    grid: { width: number; height: number },
    gx: number,
    gy: number,
): { tileX: number; tileY: number; fx: number; fy: number } => {
    const halfX = (grid.width - 1) / 2;
    const halfY = (grid.height - 1) / 2;
    const tileX = Math.floor((gx + halfX) / grid.width);
    const tileY = Math.floor((gy + halfY) / grid.height);
    return {
        tileX,
        tileY,
        fx: gx - tileX * grid.width,
        fy: gy - tileY * grid.height,
    };
};

/**
 * The TERRAIN at one global fine coordinate — the R2 water rule's single
 * read. The tile is recovered by the inverse of fineGlobalAddress (floor
 * division by the axis span), then its interior cell is resolved through the
 * terrain plugin. Without a terrain plugin (or at depth 0) the tile ITSELF is
 * the cell — the pre-fine behavior, where a tile has no interior water.
 * Undefined off-canvas (the rim is open sea — never a landing).
 */
export const fineCellAt = (world: World, gx: number, gy: number): TerrainCell | undefined => {
    const grid = world.canvas;
    if (grid.width === 0 || grid.height === 0) {
        return undefined;
    }
    const { tileX, tileY, fx, fy } = fineAddressOf(grid, gx, gy);
    const tile = world.cellAt(tileX, tileY);
    if (!tile) {
        return undefined;
    }
    const fine = fineTerrainOf(world);
    if (!fine) {
        return tile;
    }
    // A sub-grid the terrain refuses to resolve falls back to the coarse
    // tile — never a veto on ignorance (the fineSiting rule)
    return fine.cellFor([{ x: tileX, y: tileY }, { x: fx, y: fy }]) ?? tile;
};

/**
 * Whether a GROUND BODY may stand on the global fine coordinate — the R2 dry
 * rule (engine/types isWalkableCell: passable AND not a water biome) applied
 * to the RESOLVED terrain, so a river cell (raw `passable: true`, biome
 * 'river') and a tile's fine waterline refuse exactly like open sea.
 */
export const fineCellWalkable = (world: World, gx: number, gy: number): boolean =>
    isWalkableCell(fineCellAt(world, gx, gy));

/**
 * The nearest DRY fine spot inside the mover's CURRENT tile, as a fine delta
 * from where it stands — or null when the tile has no dry fine cell at all.
 * Deterministic: the offsets are tried in Chebyshev-ring order (ring 0 first,
 * then each ring clockwise from the north-west corner), so the same tile and
 * the same wet spot always resolve to the same dry spot.
 *
 * Used at SPAWN: the engine derives an entity's fine spot from the world seed
 * (engine/world.ts deriveFine), which can land on a tile's fine WATER — a
 * shore waterline, a river channel. A body must never START in water (R2), so
 * the spawn applies this delta through relocateFine (which keeps the parent
 * tile: the delta is a pure interior step).
 */
export const dryFineSpotDelta = (world: World, mover: FineMover): [number, number] | null => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub) {
        return null;
    }
    // Already dry — no relocation needed
    const here = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    if (fineCellWalkable(world, here.x, here.y)) {
        return [0, 0];
    }
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    const maxRing = Math.max(halfX, halfY);
    for (let ring = 1; ring <= maxRing; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
                // Only the ring's perimeter — the interior was covered
                if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) {
                    continue;
                }
                const fx = sub.x + dx;
                const fy = sub.y + dy;
                if (fx < -halfX || fx > halfX || fy < -halfY || fy > halfY) {
                    continue;
                }
                const spot = fineGlobalAddress(mover.position.x, mover.position.y, fx, fy, canvas);
                if (fineCellWalkable(world, spot.x, spot.y)) {
                    return [dx, dy];
                }
            }
        }
    }
    return null;
};

/**
 * Makes a freshly spawned body stand on DRY fine ground: when its derived
 * fine spot is wet, one interior fine step relocates it to the nearest dry
 * cell of the same tile (dryFineSpotDelta). A tile with no dry fine cell at
 * all is left as-is — the caller chose a dry TILE (world.landCells), so this
 * is the degenerate all-water interior of a shore tile; the body can still
 * walk OUT (fineStep validates only destinations). Returns whether the spot
 * ended dry.
 */
export const settleDryFineSpot = (world: World, mover: FineMover): boolean => {
    const delta = dryFineSpotDelta(world, mover);
    if (!delta) {
        return false;
    }
    if (delta[0] !== 0 || delta[1] !== 0) {
        world.relocateFine(mover.id, delta[0], delta[1]);
    }
    return true;
};

/**
 * Whether a body stands on DRY GROUND right now — resolved at the FINE scale
 * (the cell inside its tile), not the coarse tile: a river tile's dry BANK is
 * walkable ground the body may stand and plan from, while the same tile's
 * channel water is not. A missing fine spot reads as not-dry (fail closed).
 *
 * The travel rungs read this (the behavior plugin's onDryGround), so a body
 * that stepped onto a river bank keeps its ground vocabulary while a shark in
 * the sea or a gull afloat does not.
 */
export const moverStandsOnDryGround = (world: World, mover: FineMover): boolean => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub) {
        return false;
    }
    const here = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    return fineCellWalkable(world, here.x, here.y);
};

/**
 * THE INVALID-SPOT RECOVERY — whether a body's fine spot is invalid (wet) and
 * therefore needs settling, plus the DRY destination to settle it on.
 *
 * R2 removed the walk-through-water escape: a ground body must never ENTER
 * water, and an escape route that crosses a channel to reach the shore is
 * indistinguishable from entering one. What remains is the narrow, safe case:
 * a body whose DERIVED fine spot landed in water (the engine derives a spot
 * from the world seed on every coarse relocation — engine/world.ts
 * deriveFine) is moved ONCE, directly, to the nearest dry cell of the same
 * tile. That is a bookkeeping correction of an invalid state, not a move: it
 * can never be used to walk INTO water (it requires the source to be wet and
 * the destination to be dry).
 *
 * Returns null when the body already stands on dry ground (nothing to
 * recover) or when the tile has no dry cell at all (nothing to settle to).
 * Deterministic: the Chebyshev-ring scan from dryFineSpotDelta.
 */
export const invalidSpotRecovery = (
    world: World,
    mover: FineMover,
): { delta: [number, number]; destination: { x: number; y: number } } | null => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub) {
        return null;
    }
    const here = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    // A dry body has nothing to recover — the recovery is wet-source only,
    // which is what makes it structurally incapable of entering water
    if (fineCellWalkable(world, here.x, here.y)) {
        return null;
    }
    const delta = dryFineSpotDelta(world, mover);
    if (!delta || (delta[0] === 0 && delta[1] === 0)) {
        return null;
    }
    return { delta, destination: { x: here.x + delta[0], y: here.y + delta[1] } };
};

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
 *
 * R2 WATER RULE — the landing is validated on the RESOLVED FINE TERRAIN of
 * the DESTINATION, whether the step stays inside the parent tile or wraps
 * (fineCellWalkable): a shore waterline or a river channel inside an
 * otherwise dry tile is water all the same, and a river tile's raw
 * `passable: true` is not a permission. A DIAGONAL step also refuses to cut
 * a water corner: the two orthogonal cells sharing the corner must be dry
 * too, so a body never slips between two water cells. ESCAPE IS ALWAYS
 * ALLOWED — only the destination is checked, so a body standing on an
 * invalid (wet) cell can step OUT onto dry ground.
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
    // The destination as ONE global fine coordinate (the contiguous ground
    // plane — fineGlobalAddress) so the water read needs no per-tile branch
    const from = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    const toX = from.x + dx;
    const toY = from.y + dy;
    if (!fineCellWalkable(world, toX, toY)) {
        return undefined;
    }
    // NO CORNER-CUTTING: a diagonal step must keep both orthogonal
    // neighbours dry (the corner it squeezes through)
    if (dx !== 0 && dy !== 0) {
        if (!fineCellWalkable(world, toX, from.y) || !fineCellWalkable(world, from.x, toY)) {
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
 * THE FINE ROUTE (R2 — the real detour) — the FIRST step of a breadth-first
 * walk over the GLOBAL FINE PLANE to `goal` (a global fine coordinate), or
 * null when no route is found inside the node budget.
 *
 * Why a fine BFS on top of tilePathHop: the tile hop routes AROUND wet
 * TILES, but a tile's zoomed interior carries its own water — the shore
 * waterline of a beach tile, a river's fine channel — and the greedy ladder
 * is a straight line. A body facing a fine channel had no choice but to mill
 * until its one-minute task expired (the "stuck rejection" the R2 brief
 * forbids). This walk lets it step AROUND the channel: the visited set is the
 * walkable fine cells (isWalkableCell — the same dry rule fineStep applies),
 * the diagonal corner rule matches fineStep, and the START is enqueued
 * unconditionally so an invalid (wet) source can still route OUT.
 *
 * The goal is the exact destination (never a "closest cell" heuristic): a
 * heuristic re-aims at whatever is nearest each minute, which oscillates the
 * body between two banks instead of committing around the water. The caller
 * passes the FIXED destination tile (not the body's next coarse hop — that
 * hop flips whenever a detour crosses a tile boundary, which oscillates), so
 * the fine route keeps one global direction.
 *
 * `budget` bounds the node visits. It is deliberately small: the greedy ladder
 * re-plans EVERY minute, so a short hop around the obstacle is enough (the
 * body re-routes from its new spot) and a wide sweep would burn the whole
 * island's worth of terrain resolution per actor per minute. Out of budget
 * reads as "no route" and the caller falls back to the mill ladder.
 * 8-neighbour order is the engine's NEIGHBOR_OFFSETS (clockwise from north —
 * deterministic ties).
 */
export const fineRouteStep = (
    world: World,
    mover: FineMover,
    goal: { x: number; y: number },
    budget = 512,
): [number, number] | null => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub || canvas.width === 0 || canvas.height === 0) {
        return null;
    }
    const from = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    if (from.x === goal.x && from.y === goal.y) {
        return null;
    }
    const key = (x: number, y: number): string => `${x},${y}`;
    // The parent trail per visited node — the first hop comes from walking
    // it back to the start
    const cameFrom = new Map<string, { x: number; y: number }>();
    const queue: Array<{ x: number; y: number }> = [from];
    cameFrom.set(key(from.x, from.y), from);
    let head = 0;
    while (head < queue.length && head < budget) {
        const current = queue[head];
        head = head + 1;
        if (current.x === goal.x && current.y === goal.y) {
            let cursor = current;
            let first = current;
            const startKey = key(from.x, from.y);
            while (key(cursor.x, cursor.y) !== startKey) {
                first = cursor;
                const parent = cameFrom.get(key(cursor.x, cursor.y));
                if (!parent) {
                    return null;
                }
                cursor = parent;
            }
            return [first.x - from.x, first.y - from.y];
        }
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            const nx = current.x + offset.dx;
            const ny = current.y + offset.dy;
            if (cameFrom.has(key(nx, ny))) {
                return;
            }
            if (!fineCellWalkable(world, nx, ny)) {
                return;
            }
            // The corner rule (fineStep's): a diagonal never squeezes
            // between two wet cells
            if (
                offset.dx !== 0 &&
                offset.dy !== 0 &&
                (!fineCellWalkable(world, nx, current.y) ||
                    !fineCellWalkable(world, current.x, ny))
            ) {
                return;
            }
            cameFrom.set(key(nx, ny), { x: current.x, y: current.y });
            queue.push({ x: nx, y: ny });
        });
    }
    return null;
};

/**
 * THE REGION ROUTE — the first step of a bounded BFS to ANY walkable fine cell
 * inside `tile` (the coarse hop), or null when no such cell is reachable in
 * the budget.
 *
 * This is the ANTI-OSCILLATION mill. The old fallback ranked the eight
 * neighbours by distance to a "nearest cell of the aim tile" that was itself
 * recomputed from the body's position — a moving aim, so two cells at equal
 * distance made the walker step one way and then straight back (the T4
 * oscillation: (-4,-1) fine (-4,-8) ↔ (-4,-7), 600 steps, never arriving).
 * A region BFS has a FIXED goal set: its first hop is a genuine route step,
 * so once a hop tile is reachable the body keeps making progress, and the
 * search is bounded by construction (the hop tile is adjacent — at most one
 * sub-grid away).
 */
export const fineRouteInto = (
    world: World,
    mover: FineMover,
    tile: { x: number; y: number },
    budget = 2048,
): [number, number] | null => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub || canvas.width === 0 || canvas.height === 0) {
        return null;
    }
    const from = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    const halfX = (canvas.width - 1) / 2;
    const halfY = (canvas.height - 1) / 2;
    // The hop tile's global fine box — the goal REGION
    const lowX = tile.x * canvas.width - halfX;
    const highX = tile.x * canvas.width + halfX;
    const lowY = tile.y * canvas.height - halfY;
    const highY = tile.y * canvas.height + halfY;
    const inside = (x: number, y: number): boolean =>
        x >= lowX && x <= highX && y >= lowY && y <= highY;
    // Already inside the hop tile — the direct ladder owns the interior
    if (inside(from.x, from.y)) {
        return null;
    }
    const key = (x: number, y: number): string => `${x},${y}`;
    const cameFrom = new Map<string, { x: number; y: number }>();
    const queue: Array<{ x: number; y: number }> = [from];
    cameFrom.set(key(from.x, from.y), from);
    let head = 0;
    let answer: [number, number] | null = null;
    while (head < queue.length && head < budget && !answer) {
        const current = queue[head];
        head = head + 1;
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            if (answer) {
                return;
            }
            const nx = current.x + offset.dx;
            const ny = current.y + offset.dy;
            if (cameFrom.has(key(nx, ny))) {
                return;
            }
            // Only DRY cells are walked (R2) — the region route never enters
            // water, and off-canvas resolves to undefined (never walkable)
            if (!fineCellWalkable(world, nx, ny)) {
                return;
            }
            // The corner rule (fineStep's)
            if (
                offset.dx !== 0 &&
                offset.dy !== 0 &&
                (!fineCellWalkable(world, nx, current.y) ||
                    !fineCellWalkable(world, current.x, ny))
            ) {
                return;
            }
            cameFrom.set(key(nx, ny), { x: current.x, y: current.y });
            if (!inside(nx, ny)) {
                queue.push({ x: nx, y: ny });
                return;
            }
            // Reached the hop tile: trail back to the start for the first hop
            let cursor = { x: nx, y: ny };
            let first = cursor;
            const startKey = key(from.x, from.y);
            while (key(cursor.x, cursor.y) !== startKey) {
                first = cursor;
                const parent = cameFrom.get(key(cursor.x, cursor.y));
                if (!parent) {
                    return;
                }
                cursor = parent;
            }
            answer = [first.x - from.x, first.y - from.y];
        });
    }
    return answer;
};

/**
 * THE POCKET EXIT — the first fine step of a bounded dry BFS from a body whose
 * OWN tile is unwalkable (a river tile's dry bank) to ANY dry cell of a
 * coarse-WALKABLE tile other than that tile. Null when no such cell is
 * reachable inside the budget.
 *
 * This is the T10 fix. `tilePathHop`'s first hop is meaningless on a bank: the
 * coarse BFS starts on a node outside the walkable tile graph, so every
 * walkable neighbour is an equally valid "first hop" and the neighbour order
 * decides. In the T10 pocket (tile (0,-4), fine (-12,-8)) the chosen hop
 * (0,-3) sits behind the river — the dry walk needs more than 32768 nodes to
 * reach it — while real ground is THREE dry steps away across the diagonal
 * (tile (-1,-5)). Filtering the four cardinal neighbours is not enough
 * either: three of the four are river tiles whose interiors are dry banks
 * (legal ground under R2) and the fourth is the unreachable hop, so the
 * candidate list collapsed to the one tile that cannot be reached. A region
 * goal that is "dry ground of a WALKABLE tile, any direction" is reachable in
 * 25 nodes here and 500 in the worst measured bank case.
 *
 * Only dry cells are enqueued (isWalkableCell on the resolved fine terrain),
 * so this can never route INTO water — the exit is a genuine dry walk off the
 * bank, one step per minute. The search is bounded by `budget` node visits and
 * deterministic (engine NEIGHBOR_OFFSETS order, BFS depth = shortest dry path).
 */
export const fineRouteOut = (
    world: World,
    mover: FineMover,
    budget = 1024,
): [number, number] | null => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub || canvas.width === 0 || canvas.height === 0) {
        return null;
    }
    const from = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    // Only a body standing on an UNWALKABLE tile needs this route: on dry
    // ground the coarse hop is a real route hop and fineRouteInto serves it
    if (isWalkableCell(world.cellAt(mover.position.x, mover.position.y))) {
        return null;
    }
    const own = { x: mover.position.x, y: mover.position.y };
    const key = (x: number, y: number): string => `${x},${y}`;
    const cameFrom = new Map<string, { x: number; y: number }>();
    const queue: Array<{ x: number; y: number }> = [from];
    cameFrom.set(key(from.x, from.y), from);
    let head = 0;
    while (head < queue.length && head < budget) {
        const current = queue[head];
        head = head + 1;
        let answer: [number, number] | null = null;
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            if (answer) {
                return;
            }
            const nx = current.x + offset.dx;
            const ny = current.y + offset.dy;
            if (cameFrom.has(key(nx, ny))) {
                return;
            }
            if (!fineCellWalkable(world, nx, ny)) {
                return;
            }
            // The corner rule (fineStep's): never squeeze between two wet cells
            if (
                offset.dx !== 0 &&
                offset.dy !== 0 &&
                (!fineCellWalkable(world, nx, current.y) ||
                    !fineCellWalkable(world, current.x, ny))
            ) {
                return;
            }
            cameFrom.set(key(nx, ny), { x: current.x, y: current.y });
            queue.push({ x: nx, y: ny });
            // The goal REGION: dry ground of a walkable tile, outside the pocket
            const spot = fineAddressOf(canvas, nx, ny);
            if (spot.tileX === own.x && spot.tileY === own.y) {
                return;
            }
            if (!isWalkableCell(world.cellAt(spot.tileX, spot.tileY))) {
                return;
            }
            // Trail back to the start for the first hop
            let cursor = { x: nx, y: ny };
            let first = cursor;
            const startKey = key(from.x, from.y);
            while (key(cursor.x, cursor.y) !== startKey) {
                first = cursor;
                const parent = cameFrom.get(key(cursor.x, cursor.y));
                if (!parent) {
                    return;
                }
                cursor = parent;
            }
            answer = [first.x - from.x, first.y - from.y];
        });
        if (answer) {
            return answer;
        }
    }
    return null;
};

/**
 * THE REACHABLE HOP STEP — the first fine step of a bounded region route into
 * the coarse hop tile, or — when the body stands on a bank whose coarse hop is
 * unreachable — the first step of the dry route OFF that bank.
 *
 * Two modes, decided by the body's OWN tile:
 *   WALKABLE — the coarse hop is a genuine route hop, so this is exactly
 *   `fineRouteInto(hop)`. Ordinary walks are untouched (the T4 12/12 paths).
 *   UNWALKABLE — the coarse hop is arbitrary (see fineRouteOut), so the pocket
 *   exit is tried FIRST (it is the cheap search: 25 nodes in the T10 case, and
 *   it moves the body onto real ground where normal routing resumes), and the
 *   hop region is kept only as a fallback.
 *
 * Both branches only ever walk dry fine cells, so this can never route INTO
 * water. Bounded by `budget` node visits per search (at most two searches).
 */
export const fineRouteExit = (
    world: World,
    mover: FineMover,
    hop: { x: number; y: number },
    target: { x: number; y: number },
    budget = 1024,
): [number, number] | null => {
    if (isWalkableCell(world.cellAt(mover.position.x, mover.position.y))) {
        return fineRouteInto(world, mover, hop, budget);
    }
    // A bank body: leave the bank for real ground, and only if that is
    // impossible try the coarse hop's region. `target` is unused by the pocket
    // exit (the goal region is "any walkable tile"), so the nearest dry exit
    // wins and the next minute re-plans from real ground.
    return fineRouteOut(world, mover, budget) ?? fineRouteInto(world, mover, hop, budget);
};

/**
 * The global fine coordinate of the WALKABLE cell inside tile (tileX, tileY)
 * that sits CLOSEST to the global fine coordinate (gx, gy) — the route goal
 * for a TILE aim (fineRouteStep wants one walkable coordinate, and a tile is
 * a block of cells of which the edges may be water: a river channel, a shore
 * waterline). Ties keep the row-major order (deterministic). Null when the
 * tile has no walkable interior at all (a pure water tile — no route can end
 * there).
 *
 * `gx, gy` is the FINAL target's fine address (not the mover's): aiming at
 * the cell of the hop tile that is furthest along the way keeps the body
 * committing ACROSS the hop tile, which is what makes the detour a route
 * instead of a shuffle around the nearest bank.
 */
export const nearestWalkableFineInTile = (
    world: World,
    tileX: number,
    tileY: number,
    gx: number,
    gy: number,
    preferTile?: { x: number; y: number },
): { x: number; y: number } | null => {
    const grid = world.canvas;
    const halfX = (grid.width - 1) / 2;
    const halfY = (grid.height - 1) / 2;
    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    let bestPreference = Infinity;
    for (let fy = -halfY; fy <= halfY; fy++) {
        for (let fx = -halfX; fx <= halfX; fx++) {
            const spot = fineGlobalAddress(tileX, tileY, fx, fy, grid);
            if (!fineCellWalkable(world, spot.x, spot.y)) {
                continue;
            }
            const distance = Math.max(Math.abs(spot.x - gx), Math.abs(spot.y - gy));
            // Distance to the mover decides; the optional preference tile only
            // separates cells at the SAME distance (row-major order remains the
            // final tie-break)
            const preference = preferTile
                ? Math.max(
                      Math.abs(preferTile.x * grid.width - spot.x),
                      Math.abs(preferTile.y * grid.height - spot.y),
                  )
                : 0;
            if (distance < bestDistance || (distance === bestDistance && preference < bestPreference)) {
                best = spot;
                bestDistance = distance;
                bestPreference = preference;
            }
        }
    }
    return best;
};

/**
 * The fine route step toward a TILE aim — HIERARCHICAL, and bounded by
 * construction: the coarse hop picks WHICH tile to walk into, the fine BFS only
 * solves the LOCAL approach into it.
 *
 * `tilePathHop` already returns the next walkable TILE of the coarse route
 * (4-neighbour BFS over the walkable tile grid), so the fine goal must be a
 * cell of THAT tile, and it must be the one NEAREST the mover — a neighbouring
 * sub-grid's far corner is 25+ fine cells away (the T4 probes: 60-190 for the
 * final tile), which no bounded BFS can reach, so the route returned null and
 * the caller milled (0/12 arrivals). Aiming at the ADJACENT cell makes every
 * search terminate in a handful of nodes, while the coarse hop keeps the
 * global direction — the hierarchy does the routing, the fine walk does the
 * last few steps around whatever water sits on the tile boundary.
 *
 * `targetTile` only breaks ties when the hop tile has several equally near
 * cells: the one closer to the FINAL tile wins, so crossing the hop tile
 * makes progress instead of settling on the near bank.
 *
 * Null when the mover has no fine spot, the hop tile has no dry interior, the
 * mover already stands on the goal cell, or no route is found (the caller's
 * mill fallback).
 */
export const fineRouteTowardTile = (
    world: World,
    mover: FineMover,
    hopTile: { x: number; y: number },
    targetTile: { x: number; y: number } = hopTile,
): [number, number] | null => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub) {
        return null;
    }
    const from = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    // The aim is the hop tile's cell NEAREST the mover (bounded distance); the
    // final tile is only the tie-break preference among equally near cells
    const goal =
        nearestWalkableFineInTile(world, hopTile.x, hopTile.y, from.x, from.y, targetTile) ??
        null;
    if (!goal) {
        return null;
    }
    // Already standing on the goal — no route needed (the caller's direct
    // ladder / mill handles the local approach)
    if (goal.x === from.x && goal.y === from.y) {
        return null;
    }
    return fineRouteStep(world, mover, goal);
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
 * breadth-first walk over the TRAVERSABLE tile grid from the mover's tile to
 * the target tile. The greedy walkers step toward the TARGET TILE, and a
 * tile ringed by water on the target side (the seed-7 hauler frozen at
 * (-3,-3) facing the shelter at (-4,-1): the west and north neighbours are
 * sea, the walker ping-pongs one fine row forever) has no direct step —
 * the fallback mills, never COMMITS around the bay. The hop re-points the
 * greedy ladder at the first tile of a real route, so the body walks the
 * route instead of the straight line. Null when already on the target
 * tile, when the target tile is unreachable, or off-canvas.
 *
 * R2 — WHAT COUNTS AS TRAVERSABLE: WALKABLE ground (isWalkableCell: passable
 * AND not a water biome). A river tile is WATER for routing, so the coarse
 * route goes AROUND the course exactly like it goes around the sea and the
 * basins — the river's dry fine banks are only a fine-scale detail (a body
 * may stand on one, and fineStep lets it leave), never a coarse crossing.
 * Without this a route would keep aiming THROUGH a river tile whose fine
 * channel spans the tile, and the body would mill against the bank forever
 * (the "stuck rejection" the R2 brief forbids).
 *
 * The START is enqueued unconditionally, so a body stranded on an invalid
 * (wet) tile can still route OUT of it — escape, never entry.
 *
 * The GOAL must be walkable too (a WATER goal has no route at all: never
 * plan a trek that ends in water).
 *
 * 4-neighbour hops only: a diagonal tile crossing wraps two boundaries and
 * its corner is validated only by fineStep, so the route stays orthogonal
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
    // A WATER goal has no route: never plan a trek that ends in water
    if (!isWalkableCell(world.cellAt(to.x, to.y))) {
        return null;
    }
    const key = (x: number, y: number): string => `${x},${y}`;
    // BFS with a came-from trail over the walkable tile grid (the island
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
            // The R2 dry rule — a river tile is WATER for routing even
            // though its raw `passable` flag survives for resources
            if (!isWalkableCell(world.cellAt(nx, ny))) {
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
 * Whether a fine step is blocked by WATER (as opposed to occupancy/structure
 * walls) — the R2 detour trigger. Reuses the exact destination + corner rules
 * fineStep applies, so the route search only runs when a route can help: an
 * occupancy block is a waiting problem, not a routing one.
 */
const stepBlockedByWater = (world: World, mover: FineMover, dx: number, dy: number): boolean => {
    const canvas = world.canvas;
    const sub = world.subOf(mover.id);
    if (!sub) {
        return false;
    }
    const from = fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas);
    const toX = from.x + dx;
    const toY = from.y + dy;
    if (!fineCellWalkable(world, toX, toY)) {
        return true;
    }
    return (
        dx !== 0 &&
        dy !== 0 &&
        (!fineCellWalkable(world, toX, from.y) || !fineCellWalkable(world, from.x, toY))
    );
};

/**
 * One greedy fine step from the actor toward the target TILE (tx, ty):
 * preferred steps dx→0 then dy→0, diagonal fallback, then — when the straight
 * ladder is blocked — a REAL DETOUR along the fine water (fineRouteStep), and
 * only then any valid fine direction (the mill). Chosen deterministically
 * against the CURRENT occupancy. Null when the actor cannot fine-step at all.
 *
 * HOP-BOOKED: when the mover's tile differs from the target tile, the
 * greedy ladder aims at tilePathHop's first route tile instead of the
 * straight-line target (the peninsula fix above); on the target tile the
 * direct greedy stands (the fine milling to the exact spot is local).
 *
 * R2 — the water order matters: fineStep already refuses wet destinations,
 * so the direct ladder declines at a fine shoreline; the ROUTE step then
 * walks around the water body instead of milling against it (the "detour,
 * not merely stuck rejection" rule). The mill stays last, for pure occupancy
 * blocks where no route is possible this minute.
 */
export const greedyFineStep = (
    world: World,
    mover: FineMover,
    tx: number,
    ty: number,
): [number, number] | null => {
    // BANK PRECEDENCE (T10): on an UNWALKABLE own tile — a river tile's dry
    // bank — the coarse hop is arbitrary (see fineRouteOut), so the ladder's
    // preferred steps are just legal in-tile moves that reverse each other:
    // the T10 pocket stepped -4 → -5 → -4 forever because the hop pointed
    // south, and the dry exit north was only consulted on the minutes the
    // southward step happened to be blocked. The real dry exit wins here,
    // BEFORE the ladder, so the body commits off the bank; once it stands on
    // walkable ground the ladder below resumes unchanged (the T4 12/12 paths).
    if (!isWalkableCell(world.cellAt(mover.position.x, mover.position.y))) {
        const escape = fineRouteOut(world, mover);
        if (escape && fineStep(world, mover, escape[0], escape[1])) {
            return escape;
        }
    }
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
    // Whether the ladder hit WATER before it found a step. A water block on
    // the most direct axis is a ROUTING problem (the fine channel of a river
    // or a shore waterline sits in the way), while an occupancy/structure
    // block is a WAITING problem — so only the water flag may trigger the
    // detour below.
    let waterBlocked = false;
    arrayEach(preferred, ({ value: candidate }) => {
        if (step) {
            return;
        }
        if (stepBlockedByWater(world, mover, candidate[0], candidate[1])) {
            waterBlocked = true;
            return;
        }
        if (fineStep(world, mover, candidate[0], candidate[1])) {
            step = candidate;
        }
    });
    // No direct step at all and water was in the way — ROUTE AROUND the fine
    // water rather than settling for the mill (the R2 "detour, not merely
    // stuck rejection" rule). The route's first hop is re-validated through
    // fineStep (it must be an actually-takeable step NOW — a route that
    // ignores occupancy would queue a move the completion effect then
    // refuses, minute after minute).
    //
    // HIERARCHICAL: the coarse hop (tilePathHop) chooses WHICH tile to enter
    // — it is the global route, 4-neighbour over walkable tiles — and the
    // fine BFS only solves the interior of that one tile. Routing the fine
    // search straight at the FINAL tile made every call a 60-190-cell sweep
    // that a bounded budget can never finish (T4: 0/40 routes), and routing
    // it at the body's own hop tile with the body's own position as the aim
    // let the aim flip across tile boundaries (the oscillation). The aim is
    // now the HOP tile's cell nearest the FINAL tile, so the search stays
    // local AND the direction stays global.
    //
    // A WATER goal has no route at all (tilePathHop refuses it and so does
    // this guard): a body never detours INTO water.
    if (!step && waterBlocked && isWalkableCell(world.cellAt(tx, ty))) {
        const aimTile = hop ?? { x: tx, y: ty };
        const route = fineRouteTowardTile(world, mover, aimTile, { x: tx, y: ty });
        if (route && fineStep(world, mover, route[0], route[1])) {
            step = route;
        }
    }
    // Still blocked — ROUTE INTO the coarse hop tile's region, and when that
    // hop is unreachable from this pocket, into the best REACHABLE neighbouring
    // hop instead (fineRouteExit). This is the anti-oscillation fallback: a
    // FIXED goal set, so the body keeps progressing instead of stepping toward
    // a moving "nearest cell" and straight back. It is also the cheapest
    // bounded search here — the hop tile is adjacent, so it terminates in a
    // few dozen nodes for an ordinary bank and a few hundred for a pocket.
    if (!step && hop) {
        const exit = fineRouteExit(world, mover, hop, { x: tx, y: ty });
        if (exit && fineStep(world, mover, exit[0], exit[1])) {
            step = exit;
        }
    }
    // Last resort — the plain mill in FINE progress order. The ranking must be
    // in fine coordinates: the coarse tile distance is identical for all eight
    // neighbours inside one tile, so it ranks nothing (that bug produced the
    // T4 oscillation). Ties keep the engine's NEIGHBOR_OFFSETS order.
    if (!step) {
        const sub = world.subOf(mover.id);
        const canvas = world.canvas;
        const aimFine = sub
            ? nearestWalkableFineInTile(world, aimX, aimY, mover.position.x * canvas.width, mover.position.y * canvas.height)
            : null;
        const here = sub ? fineGlobalAddress(mover.position.x, mover.position.y, sub.x, sub.y, canvas) : null;
        const ranked = NEIGHBOR_OFFSETS.map((offset, index) => ({
            offset,
            index,
            distance:
                aimFine && here
                    ? Math.max(
                          Math.abs(aimFine.x - (here.x + offset.dx)),
                          Math.abs(aimFine.y - (here.y + offset.dy)),
                      )
                    : index,
        })).sort((left, right) => left.distance - right.distance || left.index - right.index);
        arrayEach(ranked, ({ value: entry }) => {
            if (!step && fineStep(world, mover, entry.offset.dx, entry.offset.dy)) {
                step = [entry.offset.dx, entry.offset.dy];
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
    // Blocked toward the gate — ROUTE AROUND the fine water (R2) before the
    // mill. HIERARCHICAL like greedyFineStep: off the target tile the aim is
    // the coarse HOP tile's near region (fineRouteExit — a bounded, fixed-goal
    // search that falls back to the best reachable neighbouring hop when the
    // preferred one is cut off), so the approach never sweeps toward a distant
    // cell it cannot reach; on the target tile the exact gate cell is close
    // enough for the direct fine route.
    if (!step) {
        if (hop) {
            const exit = fineRouteExit(world, mover, hop, targetTile);
            if (exit && fineStep(world, mover, exit[0], exit[1])) {
                step = exit;
            }
        } else if (preferred.some((candidate) => stepBlockedByWater(world, mover, candidate[0], candidate[1]))) {
            const route = fineRouteStep(
                world,
                mover,
                fineSpotAddress(targetTile.x, targetTile.y, targetFine.x, targetFine.y, world.canvas),
            );
            if (route && fineStep(world, mover, route[0], route[1])) {
                step = route;
            }
        }
    }
    // Last resort — the mill, PROGRESS-FIRST in fine coordinates (the raw
    // NEIGHBOR_OFFSETS order starts due north, which oscillates a walker that
    // is being pushed back by the direct ladder — the T4 (-5,-1)↔(-5,-2)
    // livelock). Ties keep the offset order.
    if (!step) {
        const here = fineSpotAddress(mover.position.x, mover.position.y, sub.x, sub.y, world.canvas);
        const there = fineSpotAddress(targetTile.x, targetTile.y, targetFine.x, targetFine.y, world.canvas);
        const ranked = NEIGHBOR_OFFSETS.map((offset, index) => ({
            offset,
            index,
            distance: Math.max(
                Math.abs(there.x - (here.x + offset.dx)),
                Math.abs(there.y - (here.y + offset.dy)),
            ),
        })).sort((left, right) => left.distance - right.distance || left.index - right.index);
        arrayEach(ranked, ({ value: entry }) => {
            if (!step && fineStep(world, mover, entry.offset.dx, entry.offset.dy)) {
                step = [entry.offset.dx, entry.offset.dy];
            }
        });
    }
    return step;
};
