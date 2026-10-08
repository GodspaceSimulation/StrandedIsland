// DEDICATED REGRESSION — the fatal boar chase (seed-7 campaign, minutes
// 8323–8341): the boar Tusk shared victim Ael's tile at (4,4) and mauled
// it to death while survival:flees re-planned every single minute and the
// victim NEVER left the tile. The mechanism: the threat scan is TILE-level
// (Chebyshev over the 8 neighbours + own tile), so as long as the beast
// stands anywhere on the actor's 25×17-subtile tile the flee keeps
// re-planning — and the old blind flight drew ANY valid fine step at
// random. A directionless random walk on that grid needs hundreds of
// minutes to reach an edge; the boar needs ~1 bite per minute to kill.
//
// THE FIX (committed exit): when the beast shares the tile and no away
// step exists, the flee deterministically marches the NEAREST DRY TILE
// EDGE (fewest fine steps to wrap into the neighbour) and crosses out.
// This test pins the whole escape timeline against the real plugin stack
// (behavior's move effect + predators' bite included). All outcomes were
// captured from reference runs — the loop is fully deterministic.

import { describe, it, expect } from 'vitest';
import { position3 } from '@godspace/core';
import { createWorld } from '../../engine/world';
import { islandTerrainPlugin } from '../terrain/islandTerrain';
import { inventoryPlugin } from '../inventory/inventoryPlugin';
import { needsPlugin } from '../needs/needsPlugin';
import { relationshipPlugin } from '../relationship/relationshipPlugin';
import { tasksPlugin } from '../tasks/tasksPlugin';
import { behaviorPlugin } from '../behavior/behaviorPlugin';
import { survivalPlugin } from './survivalPlugin';
import { predatorsPlugin } from '../predators/predatorsPlugin';
import type { Actor } from '../../engine/types';

// The full campaign stack (scenario/island.ts order, minus the unrelated
// story/birds/sharks/lumber/construction rungs) with needs frozen — the
// ONLY harm in this scenario is the boar's bite
const buildChaseStack = () => {
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, energyPerMinute: 0 });
    const relationship = relationshipPlugin();
    const tasks = tasksPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const survival = survivalPlugin({ tasks });
    const predators = predatorsPlugin({ needs, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, survival, predators],
    });
    return { world, needs, tasks, predators };
};

describe('survival flee — the fatal-chase regression', () => {
    it('a boar starting on the victim tile cannot maul it to death — the committed exit walks off within 4 minutes', () => {
        const { world, needs, tasks, predators } = buildChaseStack();
        // The campaign geometry: Ael at (4,4), the boar ON the same tile
        const actor: Actor = { id: 'actor-1', name: 'Ael', kind: 'sentient', type: 'human', position: position3(4, 4), marker: 'A', condition: 'well', profile: { sex: 'male' } };
        world.spawn(actor);
        predators.release('Tusk');
        world.coordinates.move('boar-1', position3(4, 4));

        // Minute 1 — the committed exit (stream-free pick): the +y edge is
        // the nearest dry neighbor → the RUNNING STRIDE commits north
        world.step();
        expect(tasks.taskOf('actor-1')).toMatchObject({
            behaviour: 'survival',
            kind: 'move',
            label: 'flees',
            payload: { tx: 4, ty: 5, flee: true },
        });
        world.step();
        // Minute 2 — the stride lands Ael a FULL tile off the threatened
        // tile (the run row: one tile a minute). Under the old fine-step
        // flee this is where the victim would still be milling inside the
        // boar's tile.
        expect(world.actors.get('actor-1')!.position).toEqual(position3(4, 5));

        // Minutes 3–30 — the victim stays alive and OFF the boar's tile
        // every single minute: the running stride (1 tile/min) outruns the
        // boar's two-minutes-a-tile lumbering gait, so the away rung keeps
        // the gap open and the beast's random wander never re-pins it
        for (let minute = 3; minute <= 30; minute++) {
            world.step();
            const ael = world.actors.get('actor-1');
            expect(ael, `Ael died at minute ${minute}`).toBeDefined();
            const boar = world.coordinates.positionOf('boar-1');
            expect(
                ael!.position.x === boar!.x && ael!.position.y === boar!.y,
                `the boar re-pinned Ael's tile at minute ${minute}`,
            ).toBe(false);
        }

        // The escape was not free — the boar landed its bites while Ael
        // crossed (pinned from the reference run) — but the victim walks
        // away alive and healing
        expect(needs.of('actor-1').health).toBeCloseTo(85.8, 6);
        expect(world.events.log().filter((event) => event.kind === 'attack').length).toBe(1);
    });
});
