// Tests for the needs display adapter (features/needsDisplay.ts).

import { describe, it, expect } from 'vitest';
import { needsDisplay, displayConditionOf } from './needsDisplay';

describe('needsDisplay', () => {
    it('inverts hunger/thirst pressure into wellbeing; energy and health pass through', () => {
        // Starting state: a little hungry (20 pressure) → 80 fullness.
        // Health is a reservoir (100 = healthy) — no inversion, like energy
        expect(needsDisplay({ hunger: 20, thirst: 20, energy: 100, health: 100 })).toEqual({
            fullness: 80,
            hydration: 80,
            energy: 100,
            health: 100,
        });
    });

    it('a starving, dehydrated, wounded actor shows empty bars', () => {
        expect(needsDisplay({ hunger: 100, thirst: 100, energy: 0, health: 0 })).toEqual({
            fullness: 0,
            hydration: 0,
            energy: 0,
            health: 0,
        });
    });

    it('a perfectly fed, unharmed actor shows full bars', () => {
        expect(needsDisplay({ hunger: 0, thirst: 0, energy: 100, health: 100 })).toEqual({
            fullness: 100,
            hydration: 100,
            energy: 100,
            health: 100,
        });
    });

    it('fractional pressure inverts exactly', () => {
        // After three 10-min default ticks: hunger 23, thirst 24.5, energy 98.2
        expect(needsDisplay({ hunger: 23, thirst: 24.5, energy: 98.20000000000002, health: 99.4 })).toEqual({
            fullness: 77,
            hydration: 75.5,
            energy: 98.20000000000002,
            health: 99.4,
        });
    });

    it('displayConditionOf reads the same condition ladder off the wellbeing values', () => {
        // The thresholds mirror needsPlugin conditionOf, inverted:
        // pressure ≥ 90 ↔ fullness/hydration ≤ 10; ≥ 70 ↔ ≤ 30; health
        // reads its own reservoir line (≤ 25 critical, ≤ 50 weak)
        expect(displayConditionOf({ fullness: 100, hydration: 100, energy: 100, health: 100 })).toBe('well');
        expect(displayConditionOf({ fullness: 30, hydration: 100, energy: 100, health: 100 })).toBe('weak');
        expect(displayConditionOf({ fullness: 10, hydration: 100, energy: 100, health: 100 })).toBe('critical');
        expect(displayConditionOf({ fullness: 100, hydration: 30, energy: 100, health: 100 })).toBe('weak');
        expect(displayConditionOf({ fullness: 100, hydration: 100, energy: 25, health: 100 })).toBe('weak');
        expect(displayConditionOf({ fullness: 100, hydration: 100, energy: 10, health: 100 })).toBe('critical');
        // The health thresholds — a wounded body reads weak, a mauled one
        // critical, whatever the belly says
        expect(displayConditionOf({ fullness: 100, hydration: 100, energy: 100, health: 50 })).toBe('weak');
        expect(displayConditionOf({ fullness: 100, hydration: 100, energy: 100, health: 25 })).toBe('critical');
    });

    it('a creature roster row derives its condition dot from the displayed stats', () => {
        // A fresh bird (starting values): fullness 90 / hydration 90 / energy 100
        expect(displayConditionOf(needsDisplay({ hunger: 10, thirst: 10, energy: 100, health: 100 }))).toBe('well');
        // A starving bird: pressure 95 → fullness 5 → critical
        expect(displayConditionOf(needsDisplay({ hunger: 95, thirst: 10, energy: 100, health: 100 }))).toBe('critical');
        // A wounded bird: the reservoir at the weak line
        expect(displayConditionOf(needsDisplay({ hunger: 10, thirst: 10, energy: 100, health: 45 }))).toBe('weak');
    });
});
