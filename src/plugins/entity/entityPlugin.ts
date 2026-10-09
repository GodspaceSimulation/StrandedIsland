// The entity environment plugin — the SPECIES REGISTRY that defines every
// entity the world can hold: its survival stats, its attributes, its
// abilities, its movement economics and its inventory size.
//
// ALL ENTITIES ARE DEFINED HERE. A castaway (human), a seabird, a shark, a
// wild boar — every living thing the plugins coin into the coordinate space
// carries a profile keyed by its TYPE (the 'which species/race' level of the
// two-level taxonomy, engine/types.ts ActorType). A profile defines:
//
//   stats      — Fullness / Hydration / Energy as decay rates per world
//                minute (PRESSURE semantics — 0 = fine, 100 = dying; the
//                needs plugin tracks them for EVERY entity, see
//                plugins/needs/needsPlugin.ts) plus the HEALTH drain rate
//                per world minute (0 = stable — health only moves when
//                something hurts the entity: starvation damage, a
//                predator's bite) and the starting values a fresh entity
//                wakes up with (health always starts 100 — full).
//   attributes — Strength / Stamina / Speed / Dexterity. Attributes
//                DETERMINE the consumption/adjustment of everything else
//                (see the movement derivation below): Speed 10 is TYPICAL —
//                the pace the canvas is balanced around.
//   abilities  — the open capability set: the MOVEMENT kinds (walk, run,
//                swim, fly) and the WORK kinds (mine, craft, …). Abilities
//                UNLOCK things: a human has 'mine' and can take stone/iron
//                off a tile (the inventory plugin's mine gate); a bird has
//                'fly' and can cross the Z axis; a shark only 'swim'.
//                Only things that can fly can fly — no profile, no ability,
//                no movement of that kind.
//   movement   — per movement kind: minutes per Scale-0 tile (the speed
//                adjustment) and energy per tile crossing (the burn). Both
//                are DERIVED from the attributes, not hand-pinned:
//                  minutesPerTile = BASE_MINUTES × TYPICAL_SPEED / speed
//                  energyPerTile  = BASE_ENERGY  × TYPICAL_STAMINA / stamina
//                Speed 10 → the typical pace (walk = 1 min/tile); a shark
//                (speed 14) swims a tile in 1 minute where a human swims
//                one in 2 — MUCH faster than walking, exactly the balance
//                the island asks for.
//   inventory  — the bag's SIZE in units. Size depends on what the entity
//                is: a bird carries 2–3 things, a shark swallows one, a
//                human shoulders eight. The inventory plugin clamps every
//                bag to its entity's size (plugins/inventory/inventoryPlugin.ts).
//
// The plugin itself is pure data + lookups (no tick, no world state): the
// needs, inventory, behavior and creature plugins read the profiles through
// the STRUCTURAL EntityProfiles interface, so any provider with the same
// shape can stand in (tests, other distributions).

import type { ActorKind } from '../../engine/types';
import type { WorldPlugin } from '@godspace/core';

// ── Movement vocabulary ──────────────────────────────────────────────────────

/** The movement kinds — each is an ABILITY as well as a cost table key. */
export type MoveKind = 'walk' | 'run' | 'swim' | 'fly';

/** All movement kinds, in display order. */
export const MOVE_KINDS: readonly MoveKind[] = ['walk', 'run', 'swim', 'fly'];

/**
 * Abilities are an OPEN set — movement kinds (walk/run/swim/fly) plus work
 * kinds (mine/craft/…). A work ability unlocks an ACTION: 'mine' allows
 * taking the stone/iron deposits (the inventory plugin's mine gate);
 * 'craft' allows building things (the unlock point the building feature
 * reads). Unknown abilities are simply never granted.
 */
export type Ability = string;

// ── Attribute vocabulary ─────────────────────────────────────────────────────

/** The four attributes every profile carries. Open to more via overrides. */
export type EntityAttributes = {
    /** Raw power — lifting, hauling, the bite of a beast. */
    strength: number;
    /** Endurance — the lung behind every energy burn (see movement). */
    stamina: number;
    /** Locomotion pace — Speed 10 is TYPICAL (see TYPICAL_SPEED). */
    speed: number;
    /** Finesse — task work, tool handling. */
    dexterity: number;
};

// ── Stats vocabulary ─────────────────────────────────────────────────────────

/**
 * The survival stats in PRESSURE semantics (plugins/needs needsPlugin.ts):
 * hunger/thirst count UP (0 = fine, 100 = dying), energy counts DOWN
 * (100 = rested, 0 = collapsing). Decay rates are per world minute.
 *
 * `health` rides the same record twice over (the existing one-vocabulary
 * pattern — the keys mean decay in `stats`, starting values in `start`):
 *   stats.health   — the passive health DRAIN per world minute. 0 for every
 *                    stock species: health is a RESERVOIR, not a pressure —
 *                    it only moves when something hurts the entity (the
 *                    needs plugin's starvation damage while hunger/thirst
 *                    sit at the line, a predator's bite through
 *                    needs.satisfy). At health 0 the entity dies — every
 *                    entity, creature or castaway (plugins/needs).
 *   start.health   — the starting reservoir: always full (100).
 */
export type EntityStats = {
    hunger: number;
    thirst: number;
    energy: number;
    health: number;
};

// ── Movement economics ───────────────────────────────────────────────────────

/** One movement kind's economics across the canvas. */
export type EntityMove = {
    /** World minutes to cross ONE Scale-0 tile (the speed adjustment). */
    minutesPerTile: number;
    /** Energy burned per tile crossing (the consumption). */
    energyPerTile: number;
};

/**
 * TYPICAL SPEED — the attribute value the canvas pacing is balanced
 * around: a Speed-10 walker crosses a tile in BASE walk minutes.
 */
export const TYPICAL_SPEED = 10;

/**
 * TYPICAL STAMINA — the attribute value the energy economics are balanced
 * around: a Stamina-10 mover burns BASE energy per tile crossing.
 */
export const TYPICAL_STAMINA = 10;

/** Base minutes per tile at typical speed. Swimming is SLOWER than walking
 * (2× the minutes for a typical swimmer); running matches walking pace but
 * burns threefold; flying covers ground at the walking pace while aloft. */
const BASE_MOVE_MINUTES: Record<MoveKind, number> = { walk: 1, run: 1, swim: 2, fly: 1 };

/** Base energy per tile crossing at typical stamina. Running burns 3×,
 * swimming and flying 2× the plain walk's single point. */
const BASE_MOVE_ENERGY: Record<MoveKind, number> = { walk: 1, run: 3, swim: 2, fly: 2 };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Derives a profile's movement table from its attributes and abilities —
 * attributes DETERMINE the economics (the core rule of this module). Only
 * the kinds the entity has the ability for get entries: no 'fly' ability,
 * no fly movement, no flying — only things that can fly can fly.
 */
export const deriveMovement = (
    attributes: EntityAttributes,
    abilities: readonly Ability[],
): Partial<Record<MoveKind, EntityMove>> => {
    const movement: Partial<Record<MoveKind, EntityMove>> = {};
    MOVE_KINDS.forEach((kind) => {
        if (!abilities.includes(kind)) {
            return;
        }
        movement[kind] = {
            // The speed adjustment: faster than typical → fewer minutes
            // (clamped up at 1 — a task ledger minute is the smallest unit)
            minutesPerTile: Math.max(1, Math.round((BASE_MOVE_MINUTES[kind] * TYPICAL_SPEED) / attributes.speed)),
            // The stamina adjustment: hardier than typical → cheaper burn
            energyPerTile: round2((BASE_MOVE_ENERGY[kind] * TYPICAL_STAMINA) / attributes.stamina),
        };
    });
    return movement;
};

// ── Profiles ─────────────────────────────────────────────────────────────────

/** One species' full definition — everything the world needs to run it. */
export type EntityProfile = {
    /** WHICH the entity is — the profile's key ('human', 'bird', …). */
    type: string;
    /** WHAT the entity is ('creature' | 'sentient', engine/types ActorKind). */
    kind: ActorKind;
    /** Human readable species label for inspectors and rosters. */
    label: string;
    /** Stat decay per world minute (pressure semantics). */
    stats: EntityStats;
    /** Starting stat values a fresh entity wakes up with. */
    start: EntityStats;
    /** The attribute block (see EntityAttributes). */
    attributes: EntityAttributes;
    /** The ability set (see Ability) — what this species may ever do. */
    abilities: Ability[];
    /** The movement economics, derived from attributes + abilities. */
    movement: Partial<Record<MoveKind, EntityMove>>;
    /**
     * R5 — the bag's carry capacity in WEIGHT (not item count): the load a
     * carrier may bear is `Σ count × itemWeight` and must stay ≤ this budget
     * (see the inventory plugin's capacity gate + items.ts ITEM_WEIGHTS). A
     * person shoulders 200 (ten 20-weight logs); a creature's beak/gullet/jaws
     * carry proportionally less.
     */
    inventorySize: number;
};

/**
 * Builds a profile's movement table unless the override pinned one — an
 * override's movement wins verbatim (a designer can hand-tune a species).
 */
const movementOf = (
    attributes: EntityAttributes,
    abilities: Ability[],
    override?: Partial<Record<MoveKind, EntityMove>>,
): Partial<Record<MoveKind, EntityMove>> => override ?? deriveMovement(attributes, abilities);

/** The stock species of the island — every entity type the plugins coin. */
const STOCK_PROFILES: Record<string, EntityProfile> = {
    human: {
        type: 'human',
        kind: 'sentient',
        label: 'Human',
        // The castaway pacing the island is balanced around (needs plugin's
        // legacy defaults — identical values, one vocabulary now). health 0
        // drain: the reservoir only moves when something hurts the entity
        stats: { hunger: 0.1, thirst: 0.15, energy: 0.06, health: 0 },
        start: { hunger: 20, thirst: 20, energy: 100, health: 100 },
        attributes: { strength: 8, stamina: 10, speed: 10, dexterity: 10 },
        // People walk, run, swim (slower than they walk), mine stone/iron,
        // fell trees ('chop' — the lumber/fell work gate), forage the
        // cell's renewables ('forage' — the shared tile-gather work gate,
        // plugins/tasks/gatherWork) and may one day craft — but they
        // cannot fly
        abilities: ['walk', 'run', 'swim', 'mine', 'chop', 'forage', 'craft'],
        movement: undefined as unknown as Partial<Record<MoveKind, EntityMove>>,
        // R5 — 200 weight on the back (ten 20-weight logs fill a person)
        inventorySize: 200,
    },
    bird: {
        type: 'bird',
        kind: 'creature',
        label: 'Seabird',
        // Birds run a slow metabolism — the gull's decay is a fraction of
        // a castaway's
        stats: { hunger: 0.02, thirst: 0.03, energy: 0.05, health: 0 },
        start: { hunger: 10, thirst: 10, energy: 100, health: 100 },
        attributes: { strength: 2, stamina: 8, speed: 10, dexterity: 6 },
        // Flight AND a ground hop — the only flyers of the island. The
        // gull also forages: the hunger rung's underfoot gather is gated
        // on 'forage' (the tile-gather work skill)
        abilities: ['fly', 'walk', 'forage'],
        movement: undefined as unknown as Partial<Record<MoveKind, EntityMove>>,
        // A bird can carry 2–3 light things in its beak and talons
        inventorySize: 75,
    },
    shark: {
        type: 'shark',
        kind: 'creature',
        label: 'Shark',
        // A shark lives IN its drink — thirst never presses it
        stats: { hunger: 0.03, thirst: 0, energy: 0.04, health: 0 },
        start: { hunger: 10, thirst: 0, energy: 100, health: 100 },
        attributes: { strength: 14, stamina: 12, speed: 14, dexterity: 4 },
        // Built for the water and nothing else — but it forages the shoal
        // underfoot (the hunger rung's gather gate, 'forage')
        abilities: ['swim', 'forage'],
        movement: undefined as unknown as Partial<Record<MoveKind, EntityMove>>,
        // A gullet, not a bag — one swallowed thing (25 weight)
        inventorySize: 25,
    },
    boar: {
        type: 'boar',
        kind: 'creature',
        label: 'Wild Boar',
        stats: { hunger: 0.05, thirst: 0.05, energy: 0.04, health: 0 },
        start: { hunger: 30, thirst: 20, energy: 100, health: 100 },
        // Speed 6 — the lumbering gait: walk = 2 minutes a tile (the
        // predators plugin derives its roam pace from exactly this)
        attributes: { strength: 10, stamina: 12, speed: 6, dexterity: 4 },
        // Ground legs only, sprint when pressed; an omnivore forages the
        // cell it stands on (the hunger rung's gather gate, 'forage')
        abilities: ['walk', 'run', 'forage'],
        movement: undefined as unknown as Partial<Record<MoveKind, EntityMove>>,
        // Jaws can drag a couple of things (50 weight)
        inventorySize: 50,
    },
};

// The movement tables derive at module load — the placeholder `undefined`s
// above exist only because the literal needs the attributes first
STOCK_PROFILES.human.movement = deriveMovement(STOCK_PROFILES.human.attributes, STOCK_PROFILES.human.abilities);
STOCK_PROFILES.bird.movement = deriveMovement(STOCK_PROFILES.bird.attributes, STOCK_PROFILES.bird.abilities);
STOCK_PROFILES.shark.movement = deriveMovement(STOCK_PROFILES.shark.attributes, STOCK_PROFILES.shark.abilities);
STOCK_PROFILES.boar.movement = deriveMovement(STOCK_PROFILES.boar.attributes, STOCK_PROFILES.boar.abilities);

/** Deep-ish merge of one profile override over a stock profile. */
const mergeProfile = (stock: EntityProfile, override: Partial<EntityProfile>): EntityProfile => ({
    ...stock,
    ...override,
    // The movement table derives from the (possibly overridden) attributes
    // and abilities unless the override pinned one explicitly
    movement: movementOf(
        override.attributes ?? stock.attributes,
        override.abilities ?? stock.abilities,
        override.movement,
    ),
});

// ── The structural interface every consumer reads ────────────────────────────

/**
 * The profile lookups the needs/inventory/behavior/creature plugins read.
 * STRUCTURAL on purpose — the entity plugin satisfies it, and so can any
 * test double or alternative registry with the same shape.
 */
export type EntityProfiles = {
    /** The full profile of a species, or undefined when unknown. */
    profileOf(type: string): EntityProfile | undefined;
    /** Whether a species holds an ability — the unlock check. */
    hasAbility(type: string, ability: string): boolean;
    /** Minutes to cross one Scale-0 tile with a movement kind. */
    moveMinutesOf(type: string, moveKind: MoveKind): number | undefined;
    /** Energy burned per tile crossing with a movement kind. */
    moveEnergyOf(type: string, moveKind: MoveKind): number | undefined;
    /** The species' bag size in units. */
    inventorySizeOf(type: string): number | undefined;
};

export type EntityPluginOptions = {
    /**
     * Per-type profile overrides, merged over the stock profiles. An
     * override may replace any field; the movement table re-derives from
     * the resulting attributes + abilities unless the override pins its own.
     */
    profiles?: Record<string, Partial<EntityProfile>>;
};

export type EntityPlugin = WorldPlugin & EntityProfiles & {
    /** All known species types, alphabetical (deterministic display). */
    types(): string[];
    /** A species' attribute block, or undefined when unknown. */
    attributesOf(type: string): EntityAttributes | undefined;
    /** A species' ability list, or undefined when unknown. */
    abilitiesOf(type: string): Ability[] | undefined;
    /** A species' movement table, or undefined when unknown. */
    movementOf(type: string): Partial<Record<MoveKind, EntityMove>> | undefined;
};

export const entityPlugin = (options: EntityPluginOptions = {}): EntityPlugin => {
    // The live registry: stock profiles with the overrides merged in at
    // construction. Immutable afterwards — a species definition is stable
    // world data, not simulation state.
    const profiles = new Map<string, EntityProfile>();
    Object.keys(STOCK_PROFILES).forEach((type) => {
        const override = options.profiles?.[type];
        profiles.set(type, override ? mergeProfile(STOCK_PROFILES[type], override) : STOCK_PROFILES[type]);
    });
    // Overrides for UNKNOWN types coin brand-new species on the spot. A
    // coined species must declare at least its attributes + abilities —
    // anything missing falls back to the typical baseline so the derived
    // movement table always has numbers to work with.
    Object.keys(options.profiles ?? {}).forEach((type) => {
        if (profiles.has(type)) {
            return;
        }
        const override = options.profiles?.[type] as EntityProfile;
        const attributes = override.attributes ?? { strength: 5, stamina: TYPICAL_STAMINA, speed: TYPICAL_SPEED, dexterity: 5 };
        const abilities = override.abilities ?? [];
        profiles.set(type, {
            ...override,
            attributes,
            abilities,
            // Coin new species from their declared attributes + abilities;
            // an un-derived movement table derives here too
            movement: movementOf(attributes, abilities, override.movement),
        });
    });

    return {
        id: 'entity',
        label: 'Entity Profiles',

        profileOf: (type) => profiles.get(type),

        hasAbility: (type, ability) => profiles.get(type)?.abilities.includes(ability) ?? false,

        moveMinutesOf: (type, moveKind) => profiles.get(type)?.movement[moveKind]?.minutesPerTile,

        moveEnergyOf: (type, moveKind) => profiles.get(type)?.movement[moveKind]?.energyPerTile,

        inventorySizeOf: (type) => profiles.get(type)?.inventorySize,

        types: () => Array.from(profiles.keys()).sort(),

        attributesOf: (type) => profiles.get(type)?.attributes,

        abilitiesOf: (type) => profiles.get(type)?.abilities,

        movementOf: (type) => profiles.get(type)?.movement,
    };
};
