// THE TOOL DURABILITY SERVICE (T5 R3) — the island-local wear ledger for the
// crafted hand tools (the axe, the hammer), keyed ENTITY + TOOL beside the
// canonical bag counts.
//
// WHY ISLAND-LOCAL — the shared @godspace/material catalog owns item IDENTITY
// only (name/kind — never forked here). How long an island axe lasts is the
// island's own material vocabulary, exactly like the built structures'
// section anatomy (plugins/construction/structureModel.ts): the service is
// pure data + arithmetic with NO world-type dependency (keyed by any world
// object through a WeakMap, so two worlds never share wear records and the
// records die with the world — no leaks, no dispose hook needed).
//
// THE CANONICAL BAG RULE — the bag count stays the single source of truth
// for "does this body hold the tool": every read takes the CURRENT bag
// count, every wear use takes the live bag record, and a break removes
// exactly one unit from it. The service never invents a tool the bag does
// not hold and never leaves a record for a tool the bag lost:
//   acquisition — a tool the bag holds with no wear record yet (freshly
//     crafted, gifted, traded in) enters at FULL health;
//   loss — a bag that no longer holds the tool (broken, traded away, the
//     holder despawned) forgets its record on the next read; a tool that
//     comes back later starts fresh (bag counts carry no instance identity —
//     wear does not survive a trip through another bag, the documented
//     simplification).
//
// THE WEAR RULE (R3) — tools wear at ACTUAL USE, never on the clock: an axe
// loses health on a SUCCESSFUL chop payout (a tree actually felled — the
// lumber plugin's 'chop' claim and the construction plugin's 'fell' claim,
// both feeding the same shared tile job), the hammer on a SUCCESSFUL build
// stage (a construction minute actually committed to a site). Idle minutes,
// walking, failed beats — nothing. Conservative rates: one axe spends 5
// health per felled tree (20 trees per fresh axe), one hammer 1 health per
// build minute (100 build minutes — the 4320-minute house outlives several
// hammers, the replacement loop the once-gate reopens).
//
// THE BREAK RULE (R3) — atomic: the use that spends the last health point
// removes the tool from the bag IN THE SAME SYNCHRONOUS STEP (no half-broken
// state a reader could observe) and forgets the record. The crew's
// once-per-tool craft gate (plugins/construction crewHasTool) re-reads the
// bags, sees no tool, and re-ows the recipe — the replacement becomes
// craftable naturally, no special-casing.
//
// THE REPAIR RULE (R3) — a mend is one unit of the tool's raw material
// (wood) plus a short deterministic work task, STRICTLY CHEAPER than
// crafting the replacement in both weight and work-minutes:
//   axe  craft = wood 1 + stone 1 (weight 20+40=60) + 5 min;
//   axe  mend  = wood 1 (weight 20) + 2 min — cheaper on both axes;
//   hammer craft = wood 2 (weight 40) + 5 min;
//   hammer mend = wood 1 (weight 20) + 2 min — cheaper on both axes.
// The crew's 'mend' rung (plugins/construction, priority 14) opens the mend
// autonomously once the tool wears past TOOL_REPAIR_TRIGGER of its health —
// before break — whenever the bag holds the wood.

import { inventoryRemove, type Inventory } from './inventory';

/** Full health per tool — the crafted equipment's material stamina.
 * T4 — the FISHING GEAR joins the ledger: a spear (a flint-tipped shaft)
 * spends 60 health over its life, a rod (a stick with a line) 90. The
 * canonical bag rule, the wear-at-use rule and the atomic break below are
 * exactly the axe/hammer contract — the fishing catch charges the SAME
 * service through `useTool(world, holder, tool, 'fish', bag)`. */
export const TOOL_MAX_HEALTH: Record<string, number> = {
    axe: 100,
    hammer: 100,
    spear: 60,
    rod: 90,
};

/** The default stamina of an unlisted tool (an unknown durable is sturdy). */
const DEFAULT_TOOL_HEALTH = 100;

/** Full health of one tool id. */
export const toolMaxHealth = (toolId: string): number => TOOL_MAX_HEALTH[toolId] ?? DEFAULT_TOOL_HEALTH;

/**
 * Health one SUCCESSFUL use costs — the wear is charged by the task KIND
 * that did the work (the completion effect knows its own kind):
 *   axe  — 'chop' (the lumber rung) and 'fell' (the construction rung) both
 *          finish a shared tile chop job and pay wood: 5 health per tree;
 *   hammer — 'build' (the construction rung commits one site work-minute):
 *          1 health per build minute;
 *   spear — 'fish' (the inventory plugin's shore catch, a successful
 *          landing): 2 health per fish — 30 fish wear a fresh spear out
 *          (60/2), so the spear is the cheap fast tool that runs out;
 *   rod   — 'fish' (the same catch): 1 health per fish — 90 fish per rod,
 *          the patient tool that outlasts the spear;
 *   anything else (including idle and non-tool wear kinds) costs nothing —
 *   tools never wear on the clock.
 */
export const toolWearPerUse = (toolId: string, taskKind: string): number => {
    if (toolId === 'axe' && (taskKind === 'chop' || taskKind === 'fell')) {
        return 5;
    }
    if (toolId === 'hammer' && taskKind === 'build') {
        return 1;
    }
    // T4 — the fishing gear wears on the SUCCESSFUL catch (a fish actually
    // landed), never on the failed cast or the walk to the shore
    if (toolId === 'spear' && taskKind === 'fish') {
        return 2;
    }
    if (toolId === 'rod' && taskKind === 'fish') {
        return 1;
    }
    return 0;
};

/** The autonomous mend trigger — the rung acts at half sound (0.5), the
 * same stewardship floor the built structures' repair order uses. */
export const TOOL_REPAIR_TRIGGER = 0.5;

/** The item one mend consumes — the tool's haft material (both tools are
 * hafted wood; the axe's stone EDGE is only bought by a fresh craft). */
export const TOOL_REPAIR_MATERIAL = 'wood';

/** Work-minutes one mend task costs the holder (strictly below the 5-minute
 * craft of either tool — a mend is always the cheaper use of the hands). */
export const TOOL_REPAIR_WORK = 2;

/** One stored wear record — the MUTABLE object the ledger holds (the wear
 * charges and mends mutate it in place; see recordOf's live-reference rule). */
type ToolRecord = { damage: number };

/** The wear ledger, keyed by world → holder id → tool id → damage record. */
const ledgers = new WeakMap<object, Map<string, Map<string, ToolRecord>>>();

/** The world's ledger, created on first use (the WeakMap keeps worlds apart). */
const ledgerOf = (world: object): Map<string, Map<string, ToolRecord>> => {
    let ledger = ledgers.get(world);
    if (!ledger) {
        ledger = new Map();
        ledgers.set(world, ledger);
    }
    return ledger;
};

/** The live damage record of one held tool — creating it at zero damage for
 * a tool the bag holds with no history yet (the acquisition path), and
 * FORGETTING the record of a tool the bag no longer holds (the loss path).
 * THE LIVE REFERENCE — the returned object IS the ledger's stored record
 * (the Map holds record objects, not bare numbers), so a caller's mutation
 * (useTool's wear charge, mendTool's reset) lands on the ledger itself; a
 * returned copy would discard every charge and the wear would never bank. */
const recordOf = (
    world: object,
    actorId: string,
    toolId: string,
    heldCount: number,
): ToolRecord | undefined => {
    const holders = ledgerOf(world);
    let tools = holders.get(actorId);
    if (!tools) {
        if (heldCount <= 0) {
            return undefined;
        }
        tools = new Map();
        holders.set(actorId, tools);
    }
    let record = tools.get(toolId);
    if (heldCount <= 0) {
        // LOSS — the bag no longer holds the tool: the record dies with it
        tools.delete(toolId);
        return undefined;
    }
    if (!record) {
        // ACQUISITION — a held tool with no wear history starts fresh; the
        // record object itself is stored (the caller mutates this reference)
        record = { damage: 0 };
        tools.set(toolId, record);
        return record;
    }
    return record;
};

/** One held tool's live health view, or undefined when the bag holds none. */
export const toolState = (
    world: object,
    actorId: string,
    toolId: string,
    heldCount: number,
): { tool: string; health: number; maxHealth: number; damage: number } | undefined => {
    const record = recordOf(world, actorId, toolId, heldCount);
    if (!record) {
        return undefined;
    }
    const maxHealth = toolMaxHealth(toolId);
    return { tool: toolId, health: maxHealth - record.damage, maxHealth, damage: record.damage };
};

/** Whether the tool is worn past the mend trigger (and still unbroken) —
 * the 'mend' rung's gate, read off the live bag count. */
export const toolMendDue = (
    world: object,
    actorId: string,
    toolId: string,
    heldCount: number,
): boolean => {
    const state = toolState(world, actorId, toolId, heldCount);
    if (!state) {
        return false;
    }
    return state.damage > 0 && state.damage >= state.maxHealth * TOOL_REPAIR_TRIGGER;
};

/**
 * Charges one successful use's wear to a held tool. The bag record is the
 * canonical existence check: an actor without the tool never wears one (a
 * co-worker's tool is not charged for someone else's minute). The BREAK is
 * atomic — the last health point removes exactly one tool unit from the
 * bag IN THE SAME STEP and forgets the record, so the replacement craft
 * gate reopens the moment the effect returns.
 */
export const useTool = (
    world: object,
    actorId: string,
    toolId: string,
    taskKind: string,
    bag: Inventory,
): { broken: boolean } => {
    const wear = toolWearPerUse(toolId, taskKind);
    // No wear for this kind of work — a no-op by definition
    if (wear <= 0) {
        return { broken: false };
    }
    const held = bag[toolId] ?? 0;
    // Not held — the canonical bag count decides; nothing to charge
    if (held <= 0) {
        return { broken: false };
    }
    const record = recordOf(world, actorId, toolId, held);
    if (!record) {
        return { broken: false };
    }
    const maxHealth = toolMaxHealth(toolId);
    // Clamp at full damage — an already-broken charge can never over-spend
    record.damage = Math.min(maxHealth, record.damage + wear);
    const holders = ledgerOf(world);
    if (record.damage >= maxHealth) {
        // THE ATOMIC BREAK — the tool leaves the bag and its record dies in
        // the same synchronous step (no half-broken state observable)
        inventoryRemove(bag, toolId, 1);
        holders.get(actorId)?.delete(toolId);
        return { broken: true };
    }
    return { broken: false };
};

/**
 * Mends a held tool back to FULL health (the damage record resets — the
 * consumed material bought the wear back). The caller has already validated
 * the repair material and consumes it itself (the split keeps the service
 * free of pricing policy); a tool the bag no longer holds mends nothing.
 */
export const mendTool = (
    world: object,
    actorId: string,
    toolId: string,
    bag: Inventory,
): boolean => {
    const held = bag[toolId] ?? 0;
    if (held <= 0) {
        return false;
    }
    const record = recordOf(world, actorId, toolId, held);
    if (!record) {
        return false;
    }
    record.damage = 0;
    return true;
};

/**
 * The durability views of every held tool — the inspector/integration read:
 * one entry per tool the bag holds (health live, damage derived). The order
 * follows the caller's tool list (the construction plugin passes
 * TOOL_RECIPE_IDS — deterministic).
 */
export const toolDurabilityViews = (
    world: object,
    actorId: string,
    heldCountOf: (toolId: string) => number,
    toolIds: readonly string[],
): Array<{ tool: string; health: number; maxHealth: number; damage: number }> => {
    const views: Array<{ tool: string; health: number; maxHealth: number; damage: number }> = [];
    toolIds.forEach((toolId) => {
        const state = toolState(world, actorId, toolId, heldCountOf(toolId));
        if (state) {
            views.push(state);
        }
    });
    return views;
};
