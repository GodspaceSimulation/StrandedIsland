// The forest ecology plugin — the island's woods as a LIVING SYSTEM.
//
// TREES GROW WOOD. The persistent fine-scale stands (plugins/terrain
// ForestStand — the terrain plugin owns the registry, this plugin the
// biology) carry one record per standing tree; each tree's wood pool grows
// with its age and yields wood one unit per chop (the lumber behaviour's
// chop → inventory.harvest → this plugin's chop). A tree stands while wood
// remains; chopped to 0 it is felled away — and the woods replenish:
//
//   GROWTH     — a tree's wood pool grows toward the mature cap. Sapling
//                wood 1 (a NEW tree gives 1 wood), an OLD tree gives more;
//                a mature PARTIALLY harvested tree regrows from its last
//                baseline — never permanently dead-ended at
//                cap-minus-harvest. Integer units + a fractional carry
//                (the growth accumulator) keep every step deterministic.
//   RECRUITMENT — a forest VOXEL recruits a new sapling into a free fine
//                cell on its own rhythm, EVEN clearcut (the forest floor's
//                seed bank stands in for the felled mother trees —
//                documented assumption below).
//   SPREAD     — a forest tile with a LIVING MATURE tree advances its edge:
//                an adjacent GRASS tile (biome 'meadow') converts into
//                woods (forest voxel stacked, biome re-skinned, one sapling
//                seeded). Never sand, stone or water — trees cannot grow
//                there regardless of the soil underlayer ("it cannot spread
//                to tiles that are not grass/forest").
//
// ── Research-backed pacing (representative fast pioneer, DEFAULT real) ─────
//
// The defaults model a fast-growing pioneer stand at REAL-WORLD pace — one
// world minute = 1/1440 day, one year = 365 days = 525,600 world minutes:
//
//   maturity   — 8 years (UNL extension: fig/stone-fruit maturation ~6 yr;
//                MSU extension: pulpwood rotations < 10 yr; FAO: fast
//                tropical rotations 5–21 yr — the 6–12 band's middle):
//                https://extensionpubs.unl.edu/publication/ec3076
//                https://extension.msstate.edu/publications/forest-growth-and-yield
//                https://www.fao.org/4/ac121e/ac121e04.htm
//   recruitment — 2 years (UNL: germination ~2 yr; UF/IFAS: seed crops
//                begin 1–5 yr; USU: seedling establishment runs 1–3 yr):
//                https://extensionpubs.unl.edu/publication/ec3076
//                https://ufdcimages.uflib.ufl.edu/IR/00/00/18/15/00001/FR02400.pdf
//                https://extension.usu.edu/forestry/publications/utah-forest-facts/040-tree-seedling-planting-guide
//   spread     — 3 years (UNL: natural spread is limited; a mature edge
//                stands converts one meadow tile per cycle):
//                https://extensionpubs.unl.edu/publication/ec3076
//
// MODELLING ASSUMPTIONS (documented, honest edges):
//   • Seed bank — a clearcut forest voxel still recruits (real forests
//     resprout from seed banks and stump coppice; FAO documents 5–10 yr
//     coppice rotations for fast tropical species).
//   • A day IS a day — no "one day = one year" fast-forward unless the
//     configuration says so: growthRateMultiplier speeds the BIOLOGY only
//     (the clock, needs and tasks keep their own pace).
//   • Density — stands seed at 90% (FOREST_COVERAGE, plugins/terrain) and
//     recruitment may carry an uncut stand to the full 100% of its fine
//     cells over the years; every felled spot refills by recruitment.
//   • Wood yield — the mature cap (WOOD_CAP, 8 units) stands in for a
//     pulpwood-rotation harvest (MSU: < 10 yr to pulpwood size).
//
// ── Fast-forwarding without millions of ticks ───────────────────────────────
//
// `fastForward(minutes)` runs ONLY the ecology schedule across a span of
// world minutes — per tile it applies the exact DUE schedule minutes
// (the same minutes per-minute stepping would act on, same seeded streams),
// so a decade of ecology costs decades/every applications, not decades ×
// 425 tile checks per simulated minute. Tests pin exact growth with the
// direct minute overrides (maturityMinutes/recruitMinutes/spreadMinutes)
// instead of running real-year horizons.

import { arrayEach } from '@presource/core';
import { NEIGHBOR_OFFSETS, randomKeyed, type PluginContext, type WorldPlugin } from '@godspace/core';
import type { World } from '../../engine/world';
import type { ForestTreeRecord, IslandTerrainPlugin } from '../terrain/islandTerrain';
import type { ForestEcology, InventoryPlugin } from '../inventory/inventoryPlugin';

/** World minutes in one island day (the ticker's calendar, temporal.ts). */
const DAY_MINUTES = 1440;
/** World minutes in one (common) year — the biology's time unit. */
const YEAR_MINUTES = DAY_MINUTES * 365;

/** Default maturity — full wood pool (see the research block above). */
const MATURITY_YEARS = 8;
/** Default recruitment cadence — one new sapling per forest tile. */
const RECRUIT_YEARS = 2;
/** Default spread cadence — one meadow conversion per mature forest tile. */
const SPREAD_YEARS = 3;
/** Default mature wood pool — the pulpwood-rotation yield (MSU, < 10 yr). */
const WOOD_CAP = 8;

/**
 * The forest PACING options — the biology's rates (the scenario passes
 * these through IslandOptions.forest; tests override for accelerated
 * deterministic runs).
 */
export type ForestPacingOptions = {
    /**
     * Speeds the BIOLOGY relative to real time: maturity/recruitment/
     * spread years divide by it. 1 = the documented real-world pace; 1000
     * matures a stand in ~70 world hours. Non-finite/≤ 0 falls back to 1
     * (invalid config never NaNs the pools).
     */
    growthRateMultiplier?: number;
    /** Years to full wood pool. Default 8 (the research band's middle). */
    maturityYears?: number;
    /** Years between a forest tile's recruitments. Default 2. */
    recruitYears?: number;
    /** Years between a forest tile's spread attempts. Default 3. */
    spreadYears?: number;
    /** A mature tree's wood pool. Default 8. */
    woodCap?: number;
    /**
     * DIRECT world-minute overrides — win over the year math when finite
     * and positive (accelerated deterministic tests pin exact ticks without
     * running real-year horizons).
     */
    maturityMinutes?: number;
    recruitMinutes?: number;
    spreadMinutes?: number;
};

export type ForestPluginOptions = ForestPacingOptions & {
    /** The terrain plugin — owns the persistent fine-scale stands. */
    terrain: IslandTerrainPlugin;
    /** The inventory plugin — the stock mirrors + the harvest entry point. */
    inventory: InventoryPlugin;
};

/** Whether a number is a usable pacing value (finite and strictly positive). */
const finitePositive = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0;

/** One tile's stand summary — the Tile Inspector's forest stats. */
export type ForestSummary = {
    /** Standing trees on the tile. */
    trees: number;
    /** Total standing wood across them. */
    wood: number;
};

/** One tree's inspection card — the selectable tree stats. */
export type ForestTreeInfo = {
    /** Current wood pool. */
    wood: number;
    /** Age in world minutes (the ecology clock). */
    ageMinutes: number;
    /** Whether the pool has reached the mature cap. */
    mature: boolean;
};

export type ForestPlugin = WorldPlugin<World> & {
    /** The wood pool of a tree record at the ecology clock (lazy growth). */
    poolOf(record: ForestTreeRecord): number;
    /** The tree's age in world minutes. */
    ageOf(record: ForestTreeRecord): number;
    /** Whether the tree's pool has reached the mature cap. */
    matureOf(record: ForestTreeRecord): boolean;
    /**
     * Cuts ONE wood off a tile's stand — the exact fine spot's tree first,
     * else the deterministic nearest standing tree inside the same tile
     * (grid metric, ties break to insertion order). Folds the tree's lazy
     * growth into its baseline first (the fractional accumulator), then
     * subtracts the wood; a pool of 0 fells the tree (record removed).
     * Returns whether the source tree died; null when the tile holds no
     * standing tree at all.
     */
    chop(parent: { x: number; y: number }, fine?: { x: number; y: number }): { felled: boolean } | null;
    /** A tile's stand summary (undefined when the tile holds no forest). */
    standOf(parent: { x: number; y: number }): ForestSummary | undefined;
    /** One tree's inspection card at an exact fine spot (undefined: bare). */
    treeAt(parent: { x: number; y: number }, fine: { x: number; y: number }): ForestTreeInfo | undefined;
    /**
     * Runs ONLY the ecology schedule across `minutes` world minutes — per
     * forest tile the exact due recruit/spread minutes (the same minutes,
     * streams and effects per-minute stepping would produce), then advances
     * the clock. Needs/tasks/other plugins do not run: the ecology is
     * independent.
     */
    fastForward(minutes: number): void;
    /** The resolved pacing (world minutes) — god-side and test reads. */
    pacing(): { maturityMinutes: number; recruitMinutes: number; spreadMinutes: number; woodCap: number };
};

export const forestPlugin = (wiring: { terrain: IslandTerrainPlugin; inventory: InventoryPlugin }, pacing: ForestPacingOptions = {}): ForestPlugin => {
    const options = { ...wiring, ...pacing };
    // ── Resolved pacing ──────────────────────────────────────────────────────
    // Direct minute overrides win; the year math applies the multiplier;
    // every invalid value falls back to its documented default (zero/
    // negative/NaN/Infinity multiplier = the real pace, never a zero
    // denominator). Each year field validates against ITS OWN constant —
    // an invalid recruitYears falls back to RECRUIT_YEARS (2), an invalid
    // spreadYears to SPREAD_YEARS (3), an invalid maturityYears to
    // MATURITY_YEARS (8): a broken override never collapses its rhythm to
    // a 1-minute pulse (the review fix — `?? default` only caught
    // undefined, so 0/negative/NaN/Infinity years mapped to 0 → 1 minute).
    const multiplier = finitePositive(options.growthRateMultiplier) ? options.growthRateMultiplier : 1;
    const yearsToMinutes = (
        override: number | undefined,
        years: number | undefined,
        fallbackYears: number,
    ): number =>
        finitePositive(override)
            ? Math.floor(override)
            : Math.max(1, Math.round((finitePositive(years) ? years : fallbackYears) * YEAR_MINUTES / multiplier));
    const maturityMinutes = yearsToMinutes(options.maturityMinutes, options.maturityYears, MATURITY_YEARS);
    const recruitMinutes = yearsToMinutes(options.recruitMinutes, options.recruitYears, RECRUIT_YEARS);
    const spreadMinutes = yearsToMinutes(options.spreadMinutes, options.spreadYears, SPREAD_YEARS);
    const woodCap = Math.max(2, Math.round(finitePositive(options.woodCap) ? options.woodCap : WOOD_CAP));
    // The growth rate as an exact RATIONAL — rateNum wood per rateDen world
    // minutes (a tree grows woodCap − 1 units over its maturity). Integer
    // math only: floor growth + a carry numerator keep every read and fold
    // deterministic (the fractional growth accumulator).
    const rateNum = woodCap - 1;
    const rateDen = maturityMinutes;

    // The ecology's own fine clock — one world-minute per tick hook call
    // (the world sub-steps its steps), independent of every other plugin's
    // rhythm. fastForward advances it across a span.
    let minute = 0;
    // The world + resolved seed arrive with setup
    let world: World | null = null;
    let seed = 1;

    // The terrain + inventory handles — the coordination wiring (scenario/
    // island.ts): the terrain owns the stands, the inventory carries the
    // gatherable stock mirrors + the harvest entry point
    const terrain = options.terrain;
    const inventory = options.inventory;

    // Schedule offsets per tile — staggered so tiles do not all pulse on
    // the same minute; cached per (kind, tile) — `every` is fixed per kind
    const offsets = new Map<string, number>();
    const offsetOf = (kind: string, every: number, x: number, y: number): number => {
        const key = `${kind}:${x},${y}`;
        const cached = offsets.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const drawn = Math.floor(randomKeyed(seed, `forest-slot:${kind}:${x},${y}`)() * every);
        offsets.set(key, drawn);
        return drawn;
    };

    // ── The lazy wood-growth read ────────────────────────────────────────────
    // pool(at) = min(cap, base + floor(((at − baseMinute) × num + carry) / den)).
    // Seeded VIRGIN records (born 0 AND baseMinute 0 — the terrain seeds one
    // per stand position) age themselves once from their pre-drawn fraction:
    // born = −floor(seedAge × maturity) — the seeded woods stand at mixed
    // ages with wood already standing (1 + floor(seedAge × (cap − 1))).
    const ensureAged = (record: ForestTreeRecord): void => {
        if (record.born === 0 && record.baseMinute === 0) {
            const age = Math.floor((record.seedAge ?? 0) * maturityMinutes);
            record.born = -age;
            record.baseMinute = -age;
        }
    };

    const poolAt = (record: ForestTreeRecord, at: number): number => {
        ensureAged(record);
        return Math.min(
            woodCap,
            record.base + Math.floor(((at - record.baseMinute) * rateNum + record.carry) / rateDen),
        );
    };

    // Folds pending growth into the record at `at` — the growth
    // accumulator: the integer growth lands in `base`, the fractional
    // remainder stays in `carry`, the baseline moves to now. Called on
    // harvest so a partially cut tree regrows from its post-chop baseline
    // (never dead-ended at cap-minus-harvest).
    const foldAt = (record: ForestTreeRecord, at: number): number => {
        ensureAged(record);
        const grown = (at - record.baseMinute) * rateNum + record.carry;
        const carry = ((grown % rateDen) + rateDen) % rateDen;
        record.base = Math.min(woodCap, record.base + Math.floor(grown / rateDen));
        record.carry = carry;
        record.baseMinute = at;
        return record.base;
    };

    // ── The mirror sync — deposit count ↔ stand size ↔ gatherable stock ─────
    // The tile's `tree` deposit and the cell stock both read the stand's
    // size; a 0-size stand drops both. The tile's LOOK is untouched by the
    // mirror: tileSurfaceKey keeps a wood on its forest canopy (the forest
    // voxel stands — a clearcut never re-skins to its plain biome).
    const syncMirror = (x: number, y: number, stand: { trees: Map<string, ForestTreeRecord> }) => {
        if (!world) {
            return;
        }
        const cell = world.cellAt(x, y);
        const stock = inventory.cellStock(x, y);
        const size = stand.trees.size;
        if (cell) {
            if (size > 0) {
                cell.resources.tree = size;
            } else {
                delete cell.resources.tree;
            }
        }
        if (size > 0) {
            stock.tree = size;
        } else {
            delete stock.tree;
        }
    };

    // ── Recruitment — the seed bank ─────────────────────────────────────────
    // One sapling into a free fine cell of a forest tile, EVEN clearcut
    // (the forest voxel's seed bank stands in for the felled mothers).
    const applyRecruit = (x: number, y: number, at: number) => {
        if (!world) {
            return;
        }
        const cell = world.cellAt(x, y);
        // Only a forest VOXEL recruits — a converted or generated forest
        // tile. The grass/sand/stone/water tiles never do.
        if (!cell || cell.biome !== 'forest') {
            return;
        }
        const stand = terrain.forestOf(x, y);
        if (!stand) {
            return;
        }
        const canvas = world.canvas;
        const capacity = canvas.width * canvas.height;
        // The density cap: a stand may fill EVERY fine cell (the initial
        // 90% refills to 100% over the years — the documented cap)
        if (stand.trees.size >= capacity) {
            return;
        }
        // Deterministic free-spot probe: the seeded stream rolls fine
        // positions until one is bare (bounded by the grid's cell count)
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const stream = randomKeyed(seed, `forest-recruit:${x},${y}:${at}`);
        for (let attempt = 0; attempt < capacity; attempt++) {
            const fx = Math.floor(stream() * canvas.width) - halfX;
            const fy = Math.floor(stream() * canvas.height) - halfY;
            if (!stand.trees.has(`${fx},${fy}`)) {
                // A recruited sapling: born in-world at wood 1
                terrain.forestPlant(x, y, { x: fx, y: fy }, {
                    born: at,
                    base: 1,
                    baseMinute: at,
                    carry: 0,
                });
                syncMirror(x, y, stand);
                return;
            }
        }
        // The bounded FALLBACK — a near-full stand (one bare spot among
        // hundreds) can evade every random probe; one row-major scan finds
        // the first bare fine cell deterministically, so the documented
        // 100% density cap fills reliably (the probe's 63%-per-cycle hit
        // rate would leave the last percent to luck forever otherwise)
        for (let row = 0; row < canvas.height; row++) {
            for (let col = 0; col < canvas.width; col++) {
                const fx = col - halfX;
                const fy = row - halfY;
                if (!stand.trees.has(`${fx},${fy}`)) {
                    terrain.forestPlant(x, y, { x: fx, y: fy }, {
                        born: at,
                        base: 1,
                        baseMinute: at,
                        carry: 0,
                    });
                    syncMirror(x, y, stand);
                    return;
                }
            }
        }
    };

    // ── Spread — the woods advance over the grass ───────────────────────────
    // A forest tile holding at least one LIVING MATURE tree converts ONE
    // adjacent meadow (grass substrate — biome 'meadow') into woods: the
    // forest voxel stacks onto the grass, the biome re-skins, one sapling
    // seeds the new stand. Sand/stone/water tiles never convert — trees
    // cannot grow there regardless of the soil underlayer; already-forest
    // neighbours are skipped (they ARE the woods).
    const applySpread = (x: number, y: number, at: number) => {
        if (!world) {
            return;
        }
        const cell = world.cellAt(x, y);
        if (!cell || cell.biome !== 'forest') {
            return;
        }
        const stand = terrain.forestOf(x, y);
        if (!stand) {
            return;
        }
        // The expansion needs a living MATURE source tree (the pool at cap)
        let mature = false;
        stand.trees.forEach((record) => {
            if (!mature && poolAt(record, at) >= woodCap) {
                mature = true;
            }
        });
        if (!mature) {
            return;
        }
        // The first adjacent GRASS tile in the fixed NEIGHBOR_OFFSETS order
        // — the deterministic expansion edge
        let target: { x: number; y: number; cell: NonNullable<ReturnType<World['cellAt']>> } | undefined;
        arrayEach(NEIGHBOR_OFFSETS, ({ value: offset }) => {
            if (target) {
                return;
            }
            const candidate = world!.cellAt(x + offset.dx, y + offset.dy);
            if (candidate && candidate.passable && candidate.biome === 'meadow') {
                target = { x: x + offset.dx, y: y + offset.dy, cell: candidate };
            }
        });
        if (!target) {
            return;
        }
        // THE CONVERSION — grass substrate turns into woods: the canopy
        // voxel stacks on the grass (the grass stays — the substrate keeps
        // supplying), the biome follows (coherent render + inventory)
        target.cell.voxels.push('forest');
        target.cell.biome = 'forest';
        // One sapling seeds the new stand — recruitment fills it over the
        // years. Deterministic free-spot probe (a converted meadow holds no
        // stand yet — the first probe lands)
        const canvas = world.canvas;
        const halfX = (canvas.width - 1) / 2;
        const halfY = (canvas.height - 1) / 2;
        const stream = randomKeyed(seed, `forest-spread:${x},${y}:${at}`);
        for (let attempt = 0; attempt < canvas.width * canvas.height; attempt++) {
            const fx = Math.floor(stream() * canvas.width) - halfX;
            const fy = Math.floor(stream() * canvas.height) - halfY;
            const existing = terrain.forestOf(target.x, target.y);
            if (!existing || !existing.trees.has(`${fx},${fy}`)) {
                const fresh = terrain.forestPlant(target.x, target.y, { x: fx, y: fy }, {
                    born: at,
                    base: 1,
                    baseMinute: at,
                    carry: 0,
                });
                syncMirror(target.x, target.y, fresh);
                return;
            }
        }
    };

    const self: ForestPlugin = {
        id: 'forest',
        label: 'Forest Ecology',

        setup: (context: PluginContext<World>) => {
            world = context.world;
            seed = world.seed;
            // FOREST-AUTHORITATIVE RECONCILIATION — the mount sweep. While
            // this plugin is unmounted, the inventory's legacy whole-tree
            // harvest draws the standing-tree MIRRORS down (the gatherable
            // stock + the tile deposit) WITHOUT reaching the persistent
            // records — the legacy path has no stand access. The STAND is
            // the living woods' authoritative truth, so on EVERY mount the
            // mirrors re-read the standing count immediately: a tree felled
            // while unmounted was never removed from its stand (documented
            // assumption — restoration resurrects nothing; the record
            // legitimately still stands), and the wood cut during the
            // unmount stays in the bag that took it (the sweep moves no
            // wood — no duplication, no mismatch after remove/cut/remount).
            world.canvas.cells.forEach((cell) => {
                const stand = terrain.forestOf(cell.x, cell.y);
                if (stand) {
                    syncMirror(cell.x, cell.y, stand);
                }
            });
            // The harvest provider mounts into the inventory — the chop
            // cuts wood off the tree pools from now on
            inventory.mountForest(self);
        },

        dispose: () => {
            // The provider unmounts — the legacy whole-tree harvest path
            // resumes. The ecology's CLOCK STAYS MONOTONIC across the
            // remount: the stand records carry ABSOLUTE birth/baseline
            // minutes on this clock, so a reset would age recruited trees
            // backwards (their pools would collapse toward felled). The
            // mirrors heal at the next setup (the reconciliation sweep);
            // the schedule offsets redraw deterministically from the same
            // seeded streams.
            inventory.unmountForest();
            offsets.clear();
            world = null;
        },

        poolOf: (record) => poolAt(record, minute),
        ageOf: (record) => {
            ensureAged(record);
            return minute - record.born;
        },
        matureOf: (record) => poolAt(record, minute) >= woodCap,

        chop: (parent, fine) => {
            const stand = terrain.forestOf(parent.x, parent.y);
            if (!stand || stand.trees.size === 0) {
                // Nothing stands to cut — the harvest fails atomically
                return null;
            }
            // THE SOURCE TREE — the exact fine spot first (the actor's own
            // spot when one stands there), else the deterministic nearest
            // standing tree INSIDE the same tile (grid metric; ties break
            // to the stand's insertion order — fully deterministic)
            const sourceKey = fine ? `${fine.x},${fine.y}` : null;
            let targetKey = sourceKey && stand.trees.has(sourceKey) ? sourceKey : null;
            if (!targetKey) {
                const ox = fine ? fine.x : 0;
                const oy = fine ? fine.y : 0;
                let bestDistance = Infinity;
                stand.trees.forEach((record, key) => {
                    const [tx, ty] = key.split(',').map(Number);
                    const distance = Math.max(Math.abs(tx - ox), Math.abs(ty - oy));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        targetKey = key;
                    }
                });
            }
            if (!targetKey) {
                return null;
            }
            const record = stand.trees.get(targetKey);
            if (!record) {
                return null;
            }
            // Fold the pending growth into the baseline, then take ONE wood
            // — the tree stands while wood remains, a pool of 0 fells it
            const pool = foldAt(record, minute);
            record.base = pool - 1;
            if (record.base <= 0) {
                // FELLED COMPLETE — the record leaves the stand and the
                // standing-tree mirrors drop with it (the deposit count and
                // the gatherable stock read the stand). The ecology owns
                // the mirror sync — no ghosts, no stale deposits. The
                // tile's LOOK keeps its forest canopy: tileSurfaceKey reads
                // the standing forest voxel, so a clearcut wood never
                // re-skins to its plain biome (the voxel stands until the
                // substrate itself changes — which the woods never strip)
                stand.trees.delete(targetKey);
                syncMirror(parent.x, parent.y, stand);
            }
            return { felled: record.base <= 0 };
        },

        standOf: (parent) => {
            const stand = terrain.forestOf(parent.x, parent.y);
            if (!stand) {
                return undefined;
            }
            // The lazy read sums the pools — a stand holds at most one tree
            // per fine cell (425 tops), bounded per inspection
            let wood = 0;
            stand.trees.forEach((record) => {
                wood = wood + poolAt(record, minute);
            });
            return { trees: stand.trees.size, wood };
        },

        treeAt: (parent, fine) => {
            const stand = terrain.forestOf(parent.x, parent.y);
            const record = stand?.trees.get(`${fine.x},${fine.y}`);
            if (!record) {
                return undefined;
            }
            ensureAged(record);
            return {
                wood: poolAt(record, minute),
                ageMinutes: minute - record.born,
                mature: poolAt(record, minute) >= woodCap,
            };
        },

        fastForward: (minutes) => {
            if (minutes <= 0 || !Number.isFinite(minutes)) {
                // Invalid spans change nothing (and never hang the replay)
                return;
            }
            const end = minute + Math.floor(minutes);
            if (!world) {
                minute = end;
                return;
            }
            // EXACT COMPACT REPLAY — the schedule is event-driven: the clock
            // JUMPS to the next due slot and applies every event the
            // per-minute stepping would apply at it, in stepping's own order
            // (row-major tiles, recruitment before spread per tile). The
            // live forest set is re-read every slot, so a tile the spread
            // converted mid-span joins the schedule exactly when stepping
            // sees it. Cost: O(tiles) per EVENT, never per minute — a decade
            // of ecology with sparse rhythms costs the event count, not the
            // minute count.
            const nextDue = (offset: number, every: number, after: number): number =>
                after + 1 + ((((offset - (after + 1)) % every) + every) % every);
            for (;;) {
                // Pass 1 — the earliest due slot over the LIVE forest tiles
                let slot = Infinity;
                world.canvas.cells.forEach((cell) => {
                    if (cell.biome !== 'forest') {
                        return;
                    }
                    const due = Math.min(
                        nextDue(offsetOf('recruit', recruitMinutes, cell.x, cell.y), recruitMinutes, minute),
                        nextDue(offsetOf('spread', spreadMinutes, cell.x, cell.y), spreadMinutes, minute),
                    );
                    if (due < slot) {
                        slot = due;
                    }
                });
                if (slot > end) {
                    break;
                }
                // Pass 2 — every event at this slot, row-major, recruit
                // before spread (the tick's own order within a minute)
                world.canvas.cells.forEach((cell) => {
                    if (cell.biome !== 'forest') {
                        return;
                    }
                    if (
                        slot === nextDue(offsetOf('recruit', recruitMinutes, cell.x, cell.y), recruitMinutes, minute)
                    ) {
                        applyRecruit(cell.x, cell.y, slot);
                    }
                    if (
                        slot === nextDue(offsetOf('spread', spreadMinutes, cell.x, cell.y), spreadMinutes, minute)
                    ) {
                        applySpread(cell.x, cell.y, slot);
                    }
                });
                minute = slot;
            }
            minute = end;
        },

        pacing: () => ({ maturityMinutes, recruitMinutes, spreadMinutes, woodCap }),

        // One tick hook call = one world-minute — the ecology clock advances
        // and each tile acts on its own staggered schedule slot. The sweep
        // is BOUNDED: O(root tiles) modulo checks per minute; the wood
        // growth itself is lazy (no per-tree scans of the ~30k seeded trees)
        tick: () => {
            if (!world) {
                return;
            }
            minute = minute + 1;
            arrayEach(world.canvas.cells, ({ value: cell }) => {
                if (cell.biome !== 'forest') {
                    return;
                }
                if (minute % recruitMinutes === offsetOf('recruit', recruitMinutes, cell.x, cell.y)) {
                    applyRecruit(cell.x, cell.y, minute);
                }
                if (minute % spreadMinutes === offsetOf('spread', spreadMinutes, cell.x, cell.y)) {
                    applySpread(cell.x, cell.y, minute);
                }
            });
        },
    };

    return self;
};
