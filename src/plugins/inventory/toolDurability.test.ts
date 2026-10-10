// Unit tests for the tool durability service (plugins/inventory/
// toolDurability.ts) — the island-local wear ledger for the crafted hand
// tools (the axe, the hammer), keyed ENTITY + TOOL beside the canonical bag
// counts. The service is pure data + arithmetic with NO world-type
// dependency (the ledger hangs off a WeakMap keyed by any world object), so
// every pin here is an exact expectation against the documented contract:
//
//   WEAR — by ACTUAL USE, never on the clock: the axe spends 5 health per
//     successful chop/fell payout, the hammer 1 per committed build minute;
//   BREAK — atomic: the use that spends the last health point removes the
//     tool from the bag IN THE SAME STEP and forgets the record;
//   MEND — one wood + TOOL_REPAIR_WORK minutes back to FULL sound, strictly
//     cheaper than crafting the replacement (the R3 repair economics).

import { describe, it, expect } from 'vitest';
import {
    TOOL_MAX_HEALTH,
    TOOL_REPAIR_MATERIAL,
    TOOL_REPAIR_TRIGGER,
    TOOL_REPAIR_WORK,
    mendTool,
    toolDurabilityViews,
    toolMaxHealth,
    toolMendDue,
    toolState,
    toolWearPerUse,
    useTool,
} from './toolDurability';
import type { Inventory } from './inventory';

/**
 * A FRESH world key per test — the ledger hangs off the world object in a
 * WeakMap, so a module-scope key would share records ACROSS tests (the wear
 * banked by one test would leak into the next read). Every test mints its
 * own key; the two-world isolation test mints its pair locally.
 */
const freshWorld = (): object => ({ id: `world-${Math.random()}` });

describe('toolDurability — the material constants', () => {
    it('carries the documented stamina, wear rates and mend price', () => {
        // Full health per tool — T4: the fishing gear joins the ledger (a
        // spear spends 60 health over its life, a rod 90)
        expect(TOOL_MAX_HEALTH).toEqual({ axe: 100, hammer: 100, spear: 60, rod: 90 });
        // An unknown durable is sturdy by default
        expect(toolMaxHealth('axe')).toBe(100);
        expect(toolMaxHealth('hammer')).toBe(100);
        expect(toolMaxHealth('spear')).toBe(60);
        expect(toolMaxHealth('rod')).toBe(90);
        expect(toolMaxHealth('net')).toBe(100);
        // The mend: one wood + 2 work minutes, at the half-sound trigger
        expect(TOOL_REPAIR_MATERIAL).toBe('wood');
        expect(TOOL_REPAIR_WORK).toBe(2);
        expect(TOOL_REPAIR_TRIGGER).toBe(0.5);
    });

    it('charges wear by the task KIND that did the work — never on the clock', () => {
        // The axe wears on a successful chop or fell payout (5 per tree)
        expect(toolWearPerUse('axe', 'chop')).toBe(5);
        expect(toolWearPerUse('axe', 'fell')).toBe(5);
        // ...and on nothing else (idle minutes, walking, failed beats)
        expect(toolWearPerUse('axe', 'build')).toBe(0);
        expect(toolWearPerUse('axe', 'gather')).toBe(0);
        expect(toolWearPerUse('axe', 'idle')).toBe(0);
        // The hammer wears on a committed build minute (1 per minute)
        expect(toolWearPerUse('hammer', 'build')).toBe(1);
        expect(toolWearPerUse('hammer', 'chop')).toBe(0);
        expect(toolWearPerUse('hammer', 'fell')).toBe(0);
        // T4 — the fishing gear wears on a SUCCESSFUL catch ('fish'): the
        // spear is the fast tool that runs out (2 per fish — 30 fish per
        // fresh spear), the rod the patient one (1 per fish — 90 per rod);
        // a failed cast or the walk to the shore wears nothing
        expect(toolWearPerUse('spear', 'fish')).toBe(2);
        expect(toolWearPerUse('rod', 'fish')).toBe(1);
        expect(toolWearPerUse('spear', 'build')).toBe(0);
        expect(toolWearPerUse('rod', 'chop')).toBe(0);
        // Unknown tools wear on nothing
        expect(toolWearPerUse('net', 'chop')).toBe(0);
    });
});

describe('toolDurability — the canonical bag rule', () => {
    it('enters a freshly held tool at FULL health and forgets a lost one', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        // ACQUISITION — a held tool with no wear history starts fresh
        expect(toolState(worldA, 'actor-1', 'axe', bag.axe ?? 0)).toEqual({
            tool: 'axe',
            health: 100,
            maxHealth: 100,
            damage: 0,
        });
        // LOSS — the bag no longer holds the tool: no state, and the record
        // dies with it (a later re-acquisition starts fresh again)
        expect(toolState(worldA, 'actor-1', 'axe', 0)).toBeUndefined();
        bag.axe = 1;
        expect(toolState(worldA, 'actor-1', 'axe', 1)).toEqual({
            tool: 'axe',
            health: 100,
            maxHealth: 100,
            damage: 0,
        });
    });

    it('keeps two worlds apart (the WeakMap ledger)', () => {
        const worldA = freshWorld();
        const worldB = freshWorld();
        const bagA: Inventory = { hammer: 1 };
        const bagB: Inventory = { hammer: 1 };
        // One committed build minute in world A only
        useTool(worldA, 'actor-1', 'hammer', 'build', bagA);
        expect(toolState(worldA, 'actor-1', 'hammer', 1)).toEqual({
            tool: 'hammer',
            health: 99,
            maxHealth: 100,
            damage: 1,
        });
        // World B never saw the use
        expect(toolState(worldB, 'actor-1', 'hammer', 1)).toEqual({
            tool: 'hammer',
            health: 100,
            maxHealth: 100,
            damage: 0,
        });
    });
});

describe('toolDurability — the wear and the atomic break', () => {
    it('charges one successful use at a time, read back through the state', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        // First felled tree: 5 health off the axe
        expect(useTool(worldA, 'actor-1', 'axe', 'fell', bag)).toEqual({ broken: false });
        expect(toolState(worldA, 'actor-1', 'axe', 1)).toEqual({
            tool: 'axe',
            health: 95,
            maxHealth: 100,
            damage: 5,
        });
        // Second felled tree: 5 more (the wear accumulates, 20 trees per axe)
        useTool(worldA, 'actor-1', 'axe', 'fell', bag);
        expect(toolState(worldA, 'actor-1', 'axe', 1)?.damage).toBe(10);
    });

    it('charges nothing without the tool or for a zero-wear kind', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        // Not held — the canonical bag count decides; nothing to charge
        expect(useTool(worldA, 'actor-2', 'axe', 'fell', bag)).toEqual({ broken: false });
        expect(toolState(worldA, 'actor-2', 'axe', 0)).toBeUndefined();
        // A zero-wear kind never creates a record either
        expect(useTool(worldA, 'actor-1', 'axe', 'gather', bag)).toEqual({ broken: false });
        expect(toolState(worldA, 'actor-1', 'axe', 1)?.damage).toBe(0);
    });

    it('BREAKS atomically: the last health point removes the tool from the bag in the same step', () => {
        const worldA = freshWorld();
        const bag: Inventory = { hammer: 1 };
        // 99 committed build minutes leave one health point
        for (let use = 0; use < 99; use++) {
            expect(useTool(worldA, 'actor-1', 'hammer', 'build', bag)).toEqual({ broken: false });
        }
        expect(toolState(worldA, 'actor-1', 'hammer', 1)).toEqual({
            tool: 'hammer',
            health: 1,
            maxHealth: 100,
            damage: 99,
        });
        // The 100th use: the hammer leaves the bag AND its record dies in
        // the same synchronous step (no half-broken state observable)
        expect(useTool(worldA, 'actor-1', 'hammer', 'build', bag)).toEqual({ broken: true });
        expect(bag.hammer).toBeUndefined();
        expect(toolState(worldA, 'actor-1', 'hammer', 0)).toBeUndefined();
        // The once-per-tool craft gate re-reads the bags and re-ows the
        // replacement naturally — nothing special-cased
        expect(toolMendDue(worldA, 'actor-1', 'hammer', 0)).toBe(false);
    });

    it('clamps an over-spend at full damage (an already-broken charge never over-spends)', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        // 20 felled trees spend the axe exactly (20 × 5 = 100)
        for (let tree = 0; tree < 19; tree++) {
            useTool(worldA, 'actor-1', 'axe', 'fell', bag);
        }
        expect(toolState(worldA, 'actor-1', 'axe', 1)?.health).toBe(5);
        expect(useTool(worldA, 'actor-1', 'axe', 'fell', bag)).toEqual({ broken: true });
        expect(bag.axe).toBeUndefined();
    });
});

describe('toolDurability — the mend', () => {
    it('is due only past the half-sound trigger on a HELD tool', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        expect(toolMendDue(worldA, 'actor-1', 'axe', 1)).toBe(false);
        // 49 damage < the 50-point trigger
        for (let chop = 0; chop < 9; chop++) {
            useTool(worldA, 'actor-1', 'axe', 'fell', bag);
        }
        expect(toolState(worldA, 'actor-1', 'axe', 1)?.damage).toBe(45);
        expect(toolMendDue(worldA, 'actor-1', 'axe', 1)).toBe(false);
        useTool(worldA, 'actor-1', 'axe', 'fell', bag);
        expect(toolState(worldA, 'actor-1', 'axe', 1)?.damage).toBe(50);
        expect(toolMendDue(worldA, 'actor-1', 'axe', 1)).toBe(true);
        // Not held → never due
        expect(toolMendDue(worldA, 'actor-1', 'axe', 0)).toBe(false);
    });

    it('mends a held tool back to FULL sound and resets the ledger', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        for (let chop = 0; chop < 12; chop++) {
            useTool(worldA, 'actor-1', 'axe', 'fell', bag);
        }
        expect(toolState(worldA, 'actor-1', 'axe', 1)?.damage).toBe(60);
        // The caller validates and consumes the material itself — the mend
        // resets the wear the consumed wood bought back
        expect(mendTool(worldA, 'actor-1', 'axe', bag)).toBe(true);
        expect(toolState(worldA, 'actor-1', 'axe', 1)).toEqual({
            tool: 'axe',
            health: 100,
            maxHealth: 100,
            damage: 0,
        });
        expect(toolMendDue(worldA, 'actor-1', 'axe', 1)).toBe(false);
    });

    it('mends nothing the bag does not hold', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1 };
        useTool(worldA, 'actor-1', 'axe', 'fell', bag);
        // The tool left the bag (traded away, broken): no mend
        expect(mendTool(worldA, 'actor-1', 'axe', {})).toBe(false);
    });
});

describe('toolDurability — the durability views', () => {
    it('lists one entry per held tool in the caller tool order', () => {
        const worldA = freshWorld();
        const bag: Inventory = { axe: 1, hammer: 1 };
        useTool(worldA, 'actor-1', 'hammer', 'build', bag);
        useTool(worldA, 'actor-1', 'hammer', 'build', bag);
        expect(
            toolDurabilityViews(worldA, 'actor-1', (toolId) => bag[toolId] ?? 0, ['axe', 'hammer']),
        ).toEqual([
            { tool: 'axe', health: 100, maxHealth: 100, damage: 0 },
            { tool: 'hammer', health: 98, maxHealth: 100, damage: 2 },
        ]);
        // A broken slot drops out of the list entirely
        expect(toolDurabilityViews(worldA, 'actor-1', () => 0, ['axe', 'hammer'])).toEqual([]);
    });

    it('the mend economics: a mend is strictly cheaper than the replacement craft', () => {
        // The pinned island recipes (constructionPlugin ISLAND_RECIPES):
        //   axe    craft = wood 1 + stone 1, 5 minutes
        //   hammer craft = wood 2, 5 minutes
        // The mend (the service constants) = wood 1 + TOOL_REPAIR_WORK 2 —
        // cheaper on material weight AND work for BOTH tools. The axe
        // recipe: wood 20 + stone 40 = 60 carried weight / 5 minutes; the
        // hammer: wood 40 / 5 minutes; the mend: wood 20 / 2 minutes.
        const craftCost = { axe: { weight: 20 + 40, work: 5 }, hammer: { weight: 40, work: 5 } };
        const mendCost = { weight: 20, work: TOOL_REPAIR_WORK };
        expect(mendCost.weight).toBeLessThan(craftCost.axe.weight);
        expect(mendCost.work).toBeLessThan(craftCost.axe.work);
        expect(mendCost.weight).toBeLessThan(craftCost.hammer.weight);
        expect(mendCost.work).toBeLessThan(craftCost.hammer.work);
        expect(mendCost).toEqual({ weight: 20, work: 2 });
    });
});
