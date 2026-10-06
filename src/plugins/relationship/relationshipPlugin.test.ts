// Tests for the relationship environment plugin.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { relationshipPlugin } from './relationshipPlugin';

describe('relationshipPlugin', () => {
    it('unacquainted pairs read as neutral 0', () => {
        const relationship = relationshipPlugin();
        const world = createWorld({ seed: 1, plugins: [relationship] });
        expect(relationship.relation('a', 'b')).toBe(0);
        expect(relationship.level('a', 'b')).toBe('neutral');
        expect(relationship.pairs()).toEqual([]);
        void world;
    });

    it('relation is symmetric regardless of argument order', () => {
        const relationship = relationshipPlugin();
        const world = createWorld({ seed: 1, plugins: [relationship] });
        world.spawn({ id: 'b', name: 'Bram', kind: 'sentient', type: 'human', position: position3(0, 0), marker: 'B', condition: 'well', profile: { sex: 'male' } });
        world.spawn({ id: 'a', name: 'Ael', kind: 'sentient', type: 'human', position: position3(1, 0), marker: 'A', condition: 'well', profile: { sex: 'male' } });
        relationship.adjust('a', 'b', 30);
        expect(relationship.relation('b', 'a')).toBe(30);
        expect(relationship.relation('a', 'b')).toBe(30);
        // Pair key uses the sorted ids, so b|a and a|b are the same pair
        expect(relationship.pairs()).toEqual([{ a: 'a', b: 'b', value: 30 }]);
    });

    it('adjust clamps to ±100', () => {
        const relationship = relationshipPlugin();
        createWorld({ seed: 1, plugins: [relationship] });
        relationship.adjust('a', 'b', 250);
        expect(relationship.relation('a', 'b')).toBe(100);
        relationship.adjust('a', 'b', -400);
        expect(relationship.relation('a', 'b')).toBe(-100);
        expect(relationship.level('a', 'b')).toBe('hostile');
    });

    it('level ladder spans hostile → bonded', () => {
        const relationship = relationshipPlugin();
        createWorld({ seed: 1, plugins: [relationship] });
        relationship.adjust('a', 'b', -60);
        expect(relationship.level('a', 'b')).toBe('hostile');
        relationship.adjust('a', 'b', 35); // −25
        expect(relationship.level('a', 'b')).toBe('strained');
        relationship.adjust('a', 'b', 24); // −1
        expect(relationship.level('a', 'b')).toBe('neutral');
        relationship.adjust('a', 'b', 30); // 29
        expect(relationship.level('a', 'b')).toBe('friendly');
        relationship.adjust('a', 'b', 31); // 60
        expect(relationship.level('a', 'b')).toBe('bonded');
    });

    it('logs notable moves with the reason', () => {
        const relationship = relationshipPlugin();
        const world = createWorld({ seed: 1, plugins: [relationship] });
        world.spawn({ id: 'a', name: 'Ael', kind: 'sentient', type: 'human', position: position3(0, 0), marker: 'A', condition: 'well', profile: { sex: 'male' } });
        world.spawn({ id: 'b', name: 'Bram', kind: 'sentient', type: 'human', position: position3(1, 0), marker: 'B', condition: 'well', profile: { sex: 'male' } });
        relationship.adjust('a', 'b', 6, 'trading');
        relationship.adjust('b', 'a', -8, 'theft');
        // Small moves stay unlogged
        relationship.adjust('a', 'b', 2);
        expect(world.events.log().filter((event) => event.kind === 'relationship').map((event) => event.message)).toEqual([
            'Ael and Bram grow closer (trading).',
            'Bram and Ael fall out (theft).',
        ]);
        expect(relationship.relation('a', 'b')).toBe(0);
    });

    it('drifts toward neutral each minute and snaps small values to exactly 0', () => {
        // One-minute steps: one drift application per step, so the reference
        // floats below are single-subtraction chains
        const relationship = relationshipPlugin({ driftPerMinute: 0.2 });
        const world = createWorld({ seed: 1, tickSize: 1, plugins: [relationship] });
        relationship.adjust('a', 'b', 6);
        relationship.adjust('c', 'd', -1);
        world.step();
        expect(relationship.relation('a', 'b')).toBe(5.8);
        expect(relationship.relation('c', 'd')).toBe(-0.8);
        world.step();
        expect(relationship.relation('a', 'b')).toBe(5.6);
        expect(relationship.relation('c', 'd')).toBe(-0.6000000000000001);
        // Reference run: the feud decays −0.8 → −0.6 → −0.4 → −0.2 → snaps to 0
        world.step();
        world.step();
        world.step();
        expect(relationship.relation('c', 'd')).toBe(0);
        // The bond keeps drifting down slowly (5 steps total)
        expect(relationship.relation('a', 'b')).toBe(4.999999999999999);
    });

    it('dispose clears every pair', () => {
        const relationship = relationshipPlugin();
        const world = createWorld({ seed: 1, plugins: [relationship] });
        relationship.adjust('a', 'b', 50);
        world.plugins.remove('relationship');
        expect(relationship.relation('a', 'b')).toBe(0);
        expect(relationship.pairs()).toEqual([]);
    });
});
