// Ownership-migration actor integration tests — prove the island's actor
// vocabulary IS the canonical @userfiction/core domain (R2/R3): the
// engine/types re-exports carry the exact canonical values, and the island
// Actor is the canonical record plus the engine-local position — nothing
// else was forked.
import { SEX_BADGES as CORE_SEX_BADGES, type Actor as CoreActor } from '@userfiction/core';
import type { EngineEntity } from '@godspace/core';
import { SEX_BADGES, type Actor, type ActorKind } from './types';

describe('StrandedIsland actor domain delegates to @userfiction/core', () => {
    test('SEX_BADGES is the canonical badge map, not a local copy', () => {
        expect(SEX_BADGES).toBe(CORE_SEX_BADGES);
        expect(SEX_BADGES).toEqual({ male: '♂', female: '♀' });
    });

    test('the island Actor is the canonical Actor plus the engine-local position', () => {
        const actor: Actor = {
            id: 'ael-1',
            name: 'Ael',
            kind: 'sentient',
            type: 'human',
            position: { x: 0, y: 0, z: 0 },
            marker: 'A',
            condition: 'well',
            profile: { sex: 'female' },
        };
        // The canonical half round-trips unchanged into a CoreActor — the
        // island adds ONLY position (R1: spatial state stays engine-local)
        const { position, ...identity } = actor;
        const canonical: CoreActor = identity as CoreActor;
        expect(canonical).toEqual({
            id: 'ael-1',
            name: 'Ael',
            kind: 'sentient',
            type: 'human',
            marker: 'A',
            condition: 'well',
            profile: { sex: 'female' },
        });
        expect(position).toEqual({ x: 0, y: 0, z: 0 });
    });

    test('the island Actor satisfies the @godspace/core EngineEntity contract', () => {
        // Compile-time integration evidence: createWorld<Actor> in
        // engine/world.ts demands Actor extends EngineEntity — this
        // assignment proves the canonical taxonomy lines up with the
        // engine's entity record without any island-side shim
        const actor: Actor = {
            id: 'bird-1',
            name: 'Caw',
            kind: 'creature',
            type: 'bird',
            position: { x: 1, y: 2, z: 3 },
            marker: 'B',
            condition: 'weak',
            profile: { sex: 'male' },
        };
        const entity: EngineEntity = actor;
        expect([entity.id, entity.kind, entity.type, entity.marker]).toEqual(['bird-1', 'creature', 'bird', 'B']);
    });

    test('the taxonomy stays open — coined kinds and species assign cleanly', () => {
        // ActorKind is the canonical extensible union: coined kinds are legal
        const coined: ActorKind = 'construct';
        const actor: Actor = {
            id: 'golem-1',
            name: 'Golem',
            kind: coined,
            type: 'golem',
            position: { x: 0, y: 0, z: 0 },
            marker: 'G',
            condition: 'well',
            profile: { sex: 'male' },
        };
        expect(actor.kind).toBe('construct');
    });
});
