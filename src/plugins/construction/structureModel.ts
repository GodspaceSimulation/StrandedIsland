// THE STRUCTURE MODEL — the island-local material anatomy of a BUILT
// structure (T3 R3/R4): sections with tiers, wear over time, the upgrade
// ladder and the repair pricing.
//
// WHY ISLAND-LOCAL — the shared @godspace/blueprint site registry owns the
// build lifecycle (staged → building → built) and stays generic for every
// distribution. The SECTION layer (what a finished structure is MADE of and
// how it wears) is the island's own material vocabulary: wood, stone, brick
// and thatch sections, a real furnace gate for brick, and resource-consuming
// crew repairs. It rides beside the site records, keyed by site id, inside
// the construction plugin — this module is the pure data half (no world
// access, fully unit-testable).
//
// THE WEAR RULE (R4, T5 R3 re-rate) — a built structure is DEAD material:
// it never heals on its own (the living woods regrow wood biologically
// through plugins/forest; a wall does not). Time wears it: every world
// minute adds one worn minute to every section, and health drops one point
// per WEAR_MINUTES_PER_HEALTH worn minutes. The rate is the CONSERVATIVE
// weathering base — ONE health point per world DAY (1440 minutes), so a
// thatch roof stands ~60 days unbuilt-over, a wood frame ~100, stone ~200
// and brick ~300: maintenance is a real stewardship rhythm, not a constant
// panic. Health floors at 0 — a worn section stands ruined until the crew
// repairs it (the maintenance orders).
//
// THE UPGRADE LADDER (R3) — a section's tier advances one rung at a time,
// wood → stone → brick, each rung a material-defined rebuild of that
// section (stone costs mined stone, brick costs BRICKS — and bricks only
// come from a real fired kiln: the brick recipe is gated on a BUILT furnace
// by the construction plugin, never here).
//
// THE REPAIR PRICING (R4) — a repair restages raw material onto the section
// and works it back: one repair unit per REPAIR_UNITS_PER_HEALTH missing
// health points, REPAIR_WORK_PER_UNIT work-minutes per unit, and the
// section's own tier material consumed (a wood frame mends with wood, a
// brick wall with brick).

// ── Tiers and sections ───────────────────────────────────────────────────────

/** The material tiers a section can stand in, coarse → strong. */
export type SectionTier = 'wood' | 'thatch' | 'stone' | 'brick';

/** One section of a built structure — a material standing at a site. */
export type StructureSection = {
    /** Stable per-structure id ("sec-1", … in definition order). */
    id: string;
    /** The material tier the section stands in. */
    tier: SectionTier;
    /** World-minutes of wear banked since the section was last sound. */
    wornMinutes: number;
};

/** Full health per tier — the tougher the material, the longer it stands. */
export const SECTION_MAX_HEALTH: Record<SectionTier, number> = {
    wood: 100,
    thatch: 60,
    stone: 200,
    brick: 300,
};

/**
 * World-minutes of wear that cost one health point — the CONSERVATIVE
 * weathering base: one health point per world DAY (1440 world minutes,
 * the distribution's day — scenario/island.ts pacing). At this rate the
 * weakest material (thatch, 60 health) stands ~60 days of unbuilt weather;
 * a wood frame ~100, stone ~200, brick ~300.
 */
export const WEAR_MINUTES_PER_HEALTH = 1440;

/**
 * The live health of a section — full at zero wear, dropping one point per
 * WEAR_MINUTES_PER_HEALTH worn minutes, floored at 0 (a ruined section).
 * Integer math: the wear clock and the health read never carry float drift.
 */
export const sectionHealth = (section: StructureSection): number =>
    Math.max(
        0,
        SECTION_MAX_HEALTH[section.tier] - Math.floor(section.wornMinutes / WEAR_MINUTES_PER_HEALTH),
    );

/**
 * The material anatomy of each island blueprint (R3) — the sections a BUILT
 * structure stands with, in definition order. The layout mirrors what the
 * blueprint is made of: a shelter is a wood frame under a thatch roof, the
 * fort is four stone walls, the furnace is stone-built (it holds the fire).
 */
export const BLUEPRINT_SECTIONS: Record<string, SectionTier[]> = {
    shelter: ['wood', 'thatch'],
    house: ['wood', 'wood', 'wood', 'thatch'],
    fort: ['stone', 'stone', 'stone', 'stone'],
    raft: ['wood', 'wood'],
    boat: ['wood', 'wood', 'wood'],
    quarry: ['wood', 'stone'],
    furnace: ['stone', 'stone'],
};

/** Fresh sections for a just-built site (zero wear, full health). */
export const createSections = (blueprintId: string): StructureSection[] =>
    (BLUEPRINT_SECTIONS[blueprintId] ?? []).map((tier, index) => ({
        id: `sec-${index + 1}`,
        tier,
        wornMinutes: 0,
    }));

// ── The upgrade ladder (R3) ──────────────────────────────────────────────────

/** The next tier up for each rung of the ladder (brick is the top). */
export const UPGRADE_LADDER: Partial<Record<SectionTier, SectionTier>> = {
    wood: 'stone',
    stone: 'brick',
};

/** What one tier-to-tier upgrade consumes: the staged material + the work. */
export type UpgradeCost = { item: string; count: number; work: number };

/**
 * The upgrade price per rung — a section rebuilt one tier up. The brick
 * rung consumes BRICKS (the furnace-fired part); the stone rung mined stone.
 * Undefined at the top of the ladder (brick never upgrades further).
 */
export const upgradeCost = (tier: SectionTier): UpgradeCost | undefined => {
    if (tier === 'wood') {
        return { item: 'stone', count: 10, work: 100 };
    }
    if (tier === 'stone') {
        return { item: 'brick', count: 10, work: 100 };
    }
    return undefined;
};

// ── The repair pricing (R4) ──────────────────────────────────────────────────

/** The material a tier mends with — the section's own stuff. */
export const REPAIR_MATERIAL: Record<SectionTier, string> = {
    wood: 'wood',
    thatch: 'thatch',
    stone: 'stone',
    brick: 'brick',
};

/** Missing health points one repair unit covers. */
export const REPAIR_UNITS_PER_HEALTH = 10;

/** Work-minutes one repair unit costs the crew. */
export const REPAIR_WORK_PER_UNIT = 5;

/** What one repair consumes: the staged material units + the work. */
export type RepairPrice = { item: string; units: number; work: number };

/**
 * The price of restoring a section to full health RIGHT NOW — ceil keeps a
 * sliver of damage a whole unit (never a zero-unit order), and the work
 * scales with the units so a big repair is proportionally more labor.
 */
export const repairPrice = (section: StructureSection): RepairPrice => {
    const missing = SECTION_MAX_HEALTH[section.tier] - sectionHealth(section);
    const units = Math.max(1, Math.ceil(missing / REPAIR_UNITS_PER_HEALTH));
    return { item: REPAIR_MATERIAL[section.tier], units, work: units * REPAIR_WORK_PER_UNIT };
};

/**
 * The auto-repair trigger — the crew opens a repair order on its own once a
 * section wears to this fraction of its full health (the god can order a
 * repair any time; this is the autonomous floor). 0.5: a structure kept
 * half-sound by its users.
 */
export const REPAIR_TRIGGER = 0.5;
