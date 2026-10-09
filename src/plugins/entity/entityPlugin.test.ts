// Tests for the entity profiles plugin (plugins/entity/entityPlugin.ts) —
// the species registry that defines every living thing: stats, attributes,
// abilities, movement economics and inventory sizes.
//
// The movement tables are DERIVED from the attributes (the core rule of the
// module — attributes determine the consumption/adjustment of everything
// else), so the expected values below are the arithmetic, pinned exactly:
//
//   minutesPerTile = max(1, round(BASE_MINUTES × TYPICAL_SPEED(10) / speed))
//   energyPerTile  = round2(BASE_ENERGY × TYPICAL_STAMINA(10) / stamina)

import { describe, it, expect } from 'vitest';
import {
    entityPlugin,
    deriveMovement,
    TYPICAL_SPEED,
    TYPICAL_STAMINA,
} from './entityPlugin';

describe('entityPlugin — the stock species', () => {
    it('lists every species the island coins, alphabetical', () => {
        const entity = entityPlugin();
        expect(entity.types()).toEqual(['bird', 'boar', 'human', 'shark']);
    });

    it('defines the human: people walk, run, swim, mine, chop, forage, craft — and never fly', () => {
        const entity = entityPlugin();
        const human = entity.profileOf('human');
        expect(human).toEqual({
            type: 'human',
            kind: 'sentient',
            label: 'Human',
            stats: { hunger: 0.1, thirst: 0.15, energy: 0.06, health: 0 },
            start: { hunger: 20, thirst: 20, energy: 100, health: 100 },
            attributes: { strength: 8, stamina: 10, speed: 10, dexterity: 10 },
            abilities: ['walk', 'run', 'swim', 'mine', 'chop', 'forage', 'craft'],
            // Speed 10 / stamina 10 = the TYPICAL baseline: walk 1 min + 1
            // energy per tile, run 1 min but 3 energy, swim 2 min (slower
            // than walking) at 2 energy — no fly row at all
            movement: {
                walk: { minutesPerTile: 1, energyPerTile: 1 },
                run: { minutesPerTile: 1, energyPerTile: 3 },
                swim: { minutesPerTile: 2, energyPerTile: 2 },
            },
            inventorySize: 200,
        });
    });

    it('defines the bird: the only flyer, with a small beak-bag', () => {
        const entity = entityPlugin();
        const bird = entity.profileOf('bird');
        expect(bird).toEqual({
            type: 'bird',
            kind: 'creature',
            label: 'Seabird',
            stats: { hunger: 0.02, thirst: 0.03, energy: 0.05, health: 0 },
            start: { hunger: 10, thirst: 10, energy: 100, health: 100 },
            attributes: { strength: 2, stamina: 8, speed: 10, dexterity: 6 },
            abilities: ['fly', 'walk', 'forage'],
            // Stamina 8 (below the typical 10) makes flight dear: 2 × 10/8
            // = 2.5 energy a tile; the ground hop burns 1.25
            movement: {
                fly: { minutesPerTile: 1, energyPerTile: 2.5 },
                walk: { minutesPerTile: 1, energyPerTile: 1.25 },
            },
            inventorySize: 75,
        });
    });

    it('defines the shark: swimming much faster than a human swims', () => {
        const entity = entityPlugin();
        const shark = entity.profileOf('shark');
        expect(shark).toEqual({
            type: 'shark',
            kind: 'creature',
            label: 'Shark',
            stats: { hunger: 0.03, thirst: 0, energy: 0.04, health: 0 },
            start: { hunger: 10, thirst: 0, energy: 100, health: 100 },
            attributes: { strength: 14, stamina: 12, speed: 14, dexterity: 4 },
            abilities: ['swim', 'forage'],
            // Speed 14 → 2 × 10/14 rounds to 1 minute a tile (a human swims
            // it in 2 — MUCH slower); stamina 12 → 2 × 10/12 = 1.67 energy
            movement: {
                swim: { minutesPerTile: 1, energyPerTile: 1.67 },
            },
            inventorySize: 25,
        });
    });

    it('defines the boar: the Speed attribute IS the lumbering gait', () => {
        const entity = entityPlugin();
        const boar = entity.profileOf('boar');
        expect(boar).toEqual({
            type: 'boar',
            kind: 'creature',
            label: 'Wild Boar',
            stats: { hunger: 0.05, thirst: 0.05, energy: 0.04, health: 0 },
            start: { hunger: 30, thirst: 20, energy: 100, health: 100 },
            attributes: { strength: 10, stamina: 12, speed: 6, dexterity: 4 },
            abilities: ['walk', 'run', 'forage'],
            // Speed 6 → 1 × 10/6 rounds to 2 minutes a tile — exactly the
            // roam pace the predators plugin has always run
            movement: {
                walk: { minutesPerTile: 2, energyPerTile: 0.83 },
                run: { minutesPerTile: 2, energyPerTile: 2.5 },
            },
            inventorySize: 50,
        });
    });
});

describe('entityPlugin — the profile lookups', () => {
    it('hasAbility answers the unlock check; unknown species hold nothing', () => {
        const entity = entityPlugin();
        // The mining unlock — humans mine, a bird hopping onto a highland
        // picks up nothing
        expect(entity.hasAbility('human', 'mine')).toBe(true);
        expect(entity.hasAbility('human', 'fly')).toBe(false);
        expect(entity.hasAbility('bird', 'fly')).toBe(true);
        expect(entity.hasAbility('bird', 'mine')).toBe(false);
        expect(entity.hasAbility('shark', 'swim')).toBe(true);
        expect(entity.hasAbility('shark', 'walk')).toBe(false);
        expect(entity.hasAbility('boar', 'run')).toBe(true);
        // THE FORAGE UNLOCK (R6) — every stock species gathers the cell it
        // stands on (the tile-gather work gate, plugins/tasks/gatherWork);
        // an unknown species holds nothing
        expect(entity.hasAbility('human', 'forage')).toBe(true);
        expect(entity.hasAbility('bird', 'forage')).toBe(true);
        expect(entity.hasAbility('shark', 'forage')).toBe(true);
        expect(entity.hasAbility('boar', 'forage')).toBe(true);
        expect(entity.hasAbility('dog', 'forage')).toBe(false);
        // Unknown species: no abilities, no profile, no movement
        expect(entity.hasAbility('dog', 'walk')).toBe(false);
        expect(entity.profileOf('dog')).toBeUndefined();
        expect(entity.moveMinutesOf('dog', 'walk')).toBeUndefined();
        expect(entity.inventorySizeOf('dog')).toBeUndefined();
    });

    it('move lookups resolve per kind; an absent ability has no row', () => {
        const entity = entityPlugin();
        expect(entity.moveMinutesOf('human', 'walk')).toBe(1);
        expect(entity.moveEnergyOf('human', 'walk')).toBe(1);
        expect(entity.moveMinutesOf('human', 'swim')).toBe(2);
        expect(entity.moveEnergyOf('human', 'run')).toBe(3);
        // Humans cannot fly — no fly movement exists to resolve
        expect(entity.moveMinutesOf('human', 'fly')).toBeUndefined();
        expect(entity.moveEnergyOf('human', 'fly')).toBeUndefined();
        expect(entity.moveMinutesOf('bird', 'fly')).toBe(1);
        expect(entity.moveEnergyOf('bird', 'fly')).toBe(2.5);
        expect(entity.attributesOf('shark')).toEqual({
            strength: 14, stamina: 12, speed: 14, dexterity: 4,
        });
        expect(entity.abilitiesOf('boar')).toEqual(['walk', 'run', 'forage']);
        expect(entity.movementOf('bird')).toEqual({
            fly: { minutesPerTile: 1, energyPerTile: 2.5 },
            walk: { minutesPerTile: 1, energyPerTile: 1.25 },
        });
    });
});

describe('deriveMovement — attributes determine the economics', () => {
    it('speed 10 is the typical pace: the baseline walks a tile in 1 minute', () => {
        expect(TYPICAL_SPEED).toBe(10);
        expect(TYPICAL_STAMINA).toBe(10);
        const movement = deriveMovement(
            { strength: 5, stamina: 10, speed: 10, dexterity: 5 },
            ['walk'],
        );
        expect(movement).toEqual({ walk: { minutesPerTile: 1, energyPerTile: 1 } });
    });

    it('a slower walker takes longer minutes; a hardier mover burns less', () => {
        // Speed 5 → 1 × 10/5 = 2 minutes a tile; stamina 20 → half the burn
        const movement = deriveMovement(
            { strength: 5, stamina: 20, speed: 5, dexterity: 5 },
            ['walk'],
        );
        expect(movement).toEqual({ walk: { minutesPerTile: 2, energyPerTile: 0.5 } });
    });

    it('a faster swimmer rounds down to the ledger minute; minutes never drop below 1', () => {
        // Speed 30 → 2 × 10/30 = 0.67 → rounds to 1 (the smallest unit)
        const movement = deriveMovement(
            { strength: 5, stamina: 10, speed: 30, dexterity: 5 },
            ['swim'],
        );
        expect(movement).toEqual({ swim: { minutesPerTile: 1, energyPerTile: 2 } });
    });

    it('only the kinds the entity has abilities for get movement rows', () => {
        // Fly ability without walk: the movement table carries ONLY fly —
        // only things that can fly can fly, and nothing else moves
        const movement = deriveMovement(
            { strength: 5, stamina: 10, speed: 10, dexterity: 5 },
            ['fly'],
        );
        expect(movement).toEqual({ fly: { minutesPerTile: 1, energyPerTile: 2 } });
    });
});

describe('entityPlugin — profile overrides', () => {
    it('an override merges over the stock profile and re-derives movement', () => {
        const entity = entityPlugin({
            profiles: {
                // A hardier human: stamina 20 → the walk burn halves
                human: {
                    attributes: { strength: 8, stamina: 20, speed: 10, dexterity: 10 },
                },
            },
        });
        const human = entity.profileOf('human');
        expect(human?.attributes).toEqual({ strength: 8, stamina: 20, speed: 10, dexterity: 10 });
        expect(human?.movement).toEqual({
            walk: { minutesPerTile: 1, energyPerTile: 0.5 },
            run: { minutesPerTile: 1, energyPerTile: 1.5 },
            swim: { minutesPerTile: 2, energyPerTile: 1 },
        });
        // Everything untouched keeps the stock shape
        expect(human?.inventorySize).toBe(200);
        expect(human?.abilities).toEqual(['walk', 'run', 'swim', 'mine', 'chop', 'forage', 'craft']);
        expect(human?.stats).toEqual({ hunger: 0.1, thirst: 0.15, energy: 0.06, health: 0 });
    });

    it('an override may pin the movement table, skipping the derivation', () => {
        const entity = entityPlugin({
            profiles: {
                human: {
                    movement: { walk: { minutesPerTile: 3, energyPerTile: 9 } },
                },
            },
        });
        expect(entity.moveMinutesOf('human', 'walk')).toBe(3);
        expect(entity.moveEnergyOf('human', 'walk')).toBe(9);
        // The pinned table REPLACES the whole movement record — the rows it
        // omits do not exist (a designer hands the full table or none of it)
        expect(entity.moveEnergyOf('human', 'run')).toBeUndefined();
    });

    it('an unknown type override coins a brand-new species', () => {
        const entity = entityPlugin({
            profiles: {
                orc: {
                    type: 'orc',
                    kind: 'sentient',
                    label: 'Orc',
                    stats: { hunger: 0.2, thirst: 0.2, energy: 0.1 },
                    start: { hunger: 0, thirst: 0, energy: 100 },
                    attributes: { strength: 16, stamina: 14, speed: 8, dexterity: 6 },
                    abilities: ['walk', 'mine'],
                    inventorySize: 10,
                },
            },
        });
        expect(entity.types()).toEqual(['bird', 'boar', 'human', 'orc', 'shark']);
        const orc = entity.profileOf('orc');
        expect(orc?.movement).toEqual({
            // Speed 8 → 1 × 10/8 rounds to 1; stamina 14 → 10/14 = 0.71
            walk: { minutesPerTile: 1, energyPerTile: 0.71 },
        });
        expect(entity.hasAbility('orc', 'mine')).toBe(true);
        expect(entity.inventorySizeOf('orc')).toBe(10);
    });
});
