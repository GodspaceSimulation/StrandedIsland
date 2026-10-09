// Unit tests for the PURE section model (plugins/construction/
// structureModel.ts) — the R3/R4 vocabulary the construction plugin folds
// over: the wear clock and its health bounds, the blueprint anatomy, the
// upgrade ladder and its costs, and the repair pricing. Every function here
// is a pure fold over the section record — no world, no scheduler — so the
// exact numbers are pinned straight from the model contract. The RUNTIME
// half (orders, the maintain rung, the kiln gate) is covered in
// constructionPlugin.test.ts.

import { describe, it, expect } from 'vitest';
import {
    BLUEPRINT_SECTIONS,
    REPAIR_MATERIAL,
    REPAIR_TRIGGER,
    REPAIR_UNITS_PER_HEALTH,
    REPAIR_WORK_PER_UNIT,
    SECTION_MAX_HEALTH,
    UPGRADE_LADDER,
    WEAR_MINUTES_PER_HEALTH,
    createSections,
    repairPrice,
    sectionHealth,
    upgradeCost,
    type SectionTier,
    type StructureSection,
} from './structureModel';

/** A section standing at a given tier and wear bank. */
const section = (tier: SectionTier, wornMinutes: number): StructureSection => ({
    id: 'sec-1',
    tier,
    wornMinutes,
});

describe('structureModel — the wear clock and health bounds', () => {
    it('carries the documented full health per tier and wear rate', () => {
        // The tougher the material, the longer it stands
        expect(SECTION_MAX_HEALTH).toEqual({ wood: 100, thatch: 60, stone: 200, brick: 300 });
        // ONE health point per world DAY (1440 world minutes — the
        // distribution's day, scenario/island.ts pacing): the conservative
        // weathering base T5 re-rated the old 100-minute panic clock to
        expect(WEAR_MINUTES_PER_HEALTH).toBe(1440);
    });

    it('derives health from the wear bank with exact integer math', () => {
        // Full at zero wear; the 1439th minute has not yet cost a point
        expect(sectionHealth(section('wood', 0))).toBe(100);
        expect(sectionHealth(section('wood', 1439))).toBe(100);
        // The 1440th minute (the first full world day) costs the first point
        expect(sectionHealth(section('wood', 1440))).toBe(99);
        // Ten world days: exactly ten points off every tier
        expect(sectionHealth(section('wood', 14400))).toBe(90); // 100 - 10
        expect(sectionHealth(section('stone', 14400))).toBe(190); // 200 - 10
        // FLOORED at zero — a ruined section never reads negative health
        // (a thatch roof spends its 60 health across exactly 60 world days)
        expect(sectionHealth(section('thatch', 86400))).toBe(0); // 60 days spent exactly
        expect(sectionHealth(section('thatch', 86401))).toBe(0);
        expect(sectionHealth(section('thatch', 864000))).toBe(0);
    });
});

describe('structureModel — the blueprint anatomy', () => {
    it('mirrors what each island blueprint is made of', () => {
        expect(BLUEPRINT_SECTIONS).toEqual({
            shelter: ['wood', 'thatch'],
            house: ['wood', 'wood', 'wood', 'thatch'],
            fort: ['stone', 'stone', 'stone', 'stone'],
            raft: ['wood', 'wood'],
            boat: ['wood', 'wood', 'wood'],
            quarry: ['wood', 'stone'],
            furnace: ['stone', 'stone'],
        });
    });

    it('creates fresh sections in definition order at zero wear', () => {
        expect(createSections('shelter')).toEqual([
            { id: 'sec-1', tier: 'wood', wornMinutes: 0 },
            { id: 'sec-2', tier: 'thatch', wornMinutes: 0 },
        ]);
        expect(createSections('fort').map((entry) => entry.tier)).toEqual([
            'stone',
            'stone',
            'stone',
            'stone',
        ]);
        // An unknown blueprint stands with no sections — never a throw
        expect(createSections('sandcastle')).toEqual([]);
    });
});

describe('structureModel — the upgrade ladder', () => {
    it('walks wood to stone to brick and stops at the top', () => {
        expect(UPGRADE_LADDER).toEqual({ wood: 'stone', stone: 'brick' });
        // thatch and brick have no rung above them
        expect(UPGRADE_LADDER.thatch).toBeUndefined();
        expect(UPGRADE_LADDER.brick).toBeUndefined();
    });

    it('prices each rung with its real material and work', () => {
        // The stone rung is mined stone; the brick rung is KILN-FIRED brick
        expect(upgradeCost('wood')).toEqual({ item: 'stone', count: 10, work: 100 });
        expect(upgradeCost('stone')).toEqual({ item: 'brick', count: 10, work: 100 });
        // No rung above brick — and thatch never upgrades at all
        expect(upgradeCost('brick')).toBeUndefined();
        expect(upgradeCost('thatch')).toBeUndefined();
    });
});

describe('structureModel — the repair pricing', () => {
    it('mends every tier with its own material', () => {
        expect(REPAIR_MATERIAL).toEqual({
            wood: 'wood',
            thatch: 'thatch',
            stone: 'stone',
            brick: 'brick',
        });
        expect(REPAIR_UNITS_PER_HEALTH).toBe(10);
        expect(REPAIR_WORK_PER_UNIT).toBe(5);
        // The autonomous floor: the crew acts at half sound
        expect(REPAIR_TRIGGER).toBe(0.5);
    });

    it('prices a repair as ceil(missing / 10) units at 5 work each', () => {
        // A FULL section still costs one whole unit — never a zero-unit
        // order the scheduler could commit for free
        expect(repairPrice(section('wood', 0))).toEqual({ item: 'wood', units: 1, work: 5 });
        // missing 1 (one worn world day) → ceil(1/10) = 1 unit
        expect(repairPrice(section('wood', 1440))).toEqual({ item: 'wood', units: 1, work: 5 });
        // missing 25 (25 worn days) → ceil(25/10) = 3 units, 15 work
        expect(repairPrice(section('wood', 36000))).toEqual({ item: 'wood', units: 3, work: 15 });
        // a RUINED thatch (all 60 gone — 60 worn days) → 6 units, 30 work
        expect(repairPrice(section('thatch', 86400))).toEqual({ item: 'thatch', units: 6, work: 30 });
        // a ruined stone keeps the same math off its own max (200 gone → 20 units)
        expect(repairPrice(section('stone', 288000))).toEqual({ item: 'stone', units: 20, work: 100 });
    });

    it('the R3 economics floor: a fully ruined section mends for a FRACTION of its replacement material', () => {
        // The repair-cheaper rule at the section scale: restoring even a
        // TOTAL ruin costs ceil(fullHealth / 10) units of the section's own
        // material — for every tier strictly less than the 10×-per-unit
        // staging any real blueprint spends on its sections (a shelter's
        // wood frame alone stages 120 wood; a full ruin mends for 10)
        (['wood', 'thatch', 'stone'] as SectionTier[]).forEach((tier) => {
            const ruined = section(tier, Number.MAX_SAFE_INTEGER);
            const price = repairPrice(ruined);
            expect(price).toEqual({
                item: REPAIR_MATERIAL[tier],
                units: SECTION_MAX_HEALTH[tier] / REPAIR_UNITS_PER_HEALTH,
                work: (SECTION_MAX_HEALTH[tier] / REPAIR_UNITS_PER_HEALTH) * REPAIR_WORK_PER_UNIT,
            });
        });
    });
});
