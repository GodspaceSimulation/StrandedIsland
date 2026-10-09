// T6 scratch probe — exact float capture for the R4-decay-only pins and the
// movement-free quota fixture. Deleted after use; not part of the distribution.
import { position3 } from '@godspace/core';
import { createWorld } from './src/engine/world';
import { islandTerrainPlugin } from './src/plugins/terrain/islandTerrain';
import { needsPlugin } from './src/plugins/needs/needsPlugin';
import { entityPlugin } from './src/plugins/entity/entityPlugin';
import { inventoryPlugin } from './src/plugins/inventory/inventoryPlugin';
import { relationshipPlugin } from './src/plugins/relationship/relationshipPlugin';
import { tasksPlugin } from './src/plugins/tasks/tasksPlugin';
import { behaviorPlugin } from './src/plugins/behavior/behaviorPlugin';
import { sleepPlugin } from './src/plugins/sleep/sleepPlugin';
import { birdsPlugin } from './src/plugins/birds/birdsPlugin';
import { predatorsPlugin } from './src/plugins/predators/predatorsPlugin';
import { sharksPlugin } from './src/plugins/sharks/sharksPlugin';
import type { EntityProfile, EntityProfiles } from './src/plugins/entity/entityPlugin';
import type { Actor } from './src/engine/types';

const show = (label: string, value: number) => {
    console.log(label, value, JSON.stringify(value));
};

// ── 1. birds perched hop: minutes 1-3 ────────────────────────────────────────
{
    const profiles = entityPlugin();
    const needs = needsPlugin({ profiles });
    const birds = birdsPlugin({ needs, profiles, landChancePerMinute: 1, takeoffChancePerMinute: 0 });
    const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), needs, birds] });
    birds.release();
    needs.satisfy('bird-1', { energy: -80 });
    world.step();
    show('birds perched m1', needs.of('bird-1').energy);
    world.step();
    show('birds perched m2', needs.of('bird-1').energy);
    world.step();
    show('birds perched m3', needs.of('bird-1').energy);
}

// ── 2. birds spent gull: gate + takeoff ──────────────────────────────────────
{
    const profiles = entityPlugin();
    const needs = needsPlugin({ profiles });
    const birds = birdsPlugin({ needs, profiles, landChancePerMinute: 1, takeoffChancePerMinute: 1 });
    const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), needs, birds] });
    birds.release();
    needs.satisfy('bird-1', { energy: -85 });
    world.step();
    for (let index = 0; index < 3; index++) {
        world.step();
    }
    show('birds spent m4', needs.of('bird-1').energy);
    needs.satisfy('bird-1', { energy: 30 });
    world.step();
    console.log('birds spent state', birds.birdOf('bird-1')?.state, 'pos', JSON.stringify(birds.birdOf('bird-1')?.position));
    show('birds spent takeoff', needs.of('bird-1').energy);
}

// ── 3. predators exhausted boar: hold + god-route resume ────────────────────
{
    const profiles = entityPlugin();
    const needs = needsPlugin({ profiles });
    const predators = predatorsPlugin({ biteChancePerMinute: 1, needs, profiles });
    const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), needs, predators] });
    predators.release();
    needs.satisfy('boar-1', { energy: -81 });
    world.step();
    show('boar hold m1', needs.of('boar-1').energy);
    world.step();
    show('boar hold m2', needs.of('boar-1').energy);
    world.step();
    show('boar hold m3', needs.of('boar-1').energy);
    needs.satisfy('boar-1', { energy: 30 });
    world.step();
    console.log('boar resume pos', JSON.stringify(predators.predatorOf('boar-1')));
    show('boar resume E', needs.of('boar-1').energy);
}

// ── 4. sharks spent hold + god-route resume ──────────────────────────────────
{
    const profiles = entityPlugin();
    const needs = needsPlugin({ profiles });
    const sharks = sharksPlugin({ needs, profiles, arriveChancePerMinute: 0, leaveChancePerMinute: 0 });
    const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), needs, sharks] });
    sharks.release();
    needs.satisfy('shark-1', { energy: -81 });
    world.step();
    show('shark hold m1', needs.of('shark-1').energy);
    world.step();
    show('shark hold m2', needs.of('shark-1').energy);
    needs.satisfy('shark-1', { energy: 30 });
    world.step();
    console.log('shark resume pos', JSON.stringify(sharks.sharkOf('shark-1')?.position));
    show('shark resume E', needs.of('shark-1').energy);
}

// ── 5. the movement-free profile double ──────────────────────────────────────
const movementFreeProfiles = (): EntityProfiles => {
    const profile: EntityProfile = {
        type: 'any',
        kind: 'creature',
        label: 'movement-free double',
        stats: { hunger: 0, thirst: 0, energy: 0.06, health: 0 },
        start: { hunger: 20, thirst: 20, energy: 100, health: 100 },
        attributes: { strength: 5, stamina: 10, speed: 10, dexterity: 5 },
        abilities: [],
        movement: {},
        inventorySize: 200,
    };
    return {
        profileOf: () => profile,
        hasAbility: () => false,
        moveMinutesOf: () => undefined,
        moveEnergyOf: () => 0,
        inventorySizeOf: () => undefined,
    };
};

// ── 6. quota fixture with the double: full-energy window walk ────────────────
{
    const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
    const tasks = tasksPlugin();
    const needs = needsPlugin({ hungerPerMinute: 0, thirstPerMinute: 0, tasks, profiles: movementFreeProfiles() });
    const relationship = relationshipPlugin();
    const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
    const sleep = sleepPlugin({ needs, tasks });
    const world = createWorld({
        seed: 7,
        tickSize: 1,
        plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior, sleep],
    });
    const actor: Actor = { id: 'a', name: 'Ael', kind: 'sentient', type: 'human', position: position3(8, 2), marker: 'A', condition: 'well', profile: { sex: 'male' } };
    world.spawn(actor);
    for (let index = 0; index < 719; index++) {
        world.step();
    }
    show('quota m719 E', needs.of('a').energy);
    const task720 = ((): string => {
        world.step();
        const task = tasks.taskOf('a');
        return `kind=${task?.kind} minutes=${task?.minutes} remaining=${task?.remaining} id=${task?.id}`;
    })();
    console.log('quota m720 task', task720);
    // interrupted-slumber variant: cancel BEFORE the step
    for (let index = 0; index < 479; index++) {
        if (tasks.taskOf('a')?.kind === 'sleep') {
            tasks.cancel('a');
        }
        world.step();
    }
    // minute 1200 runs as the last loop step below
    if (tasks.taskOf('a')?.kind === 'sleep') {
        tasks.cancel('a');
    }
    world.step();
    console.log('quota rollover account', JSON.stringify(sleep.accountOf('a')));
    show('quota m1200 E', needs.of('a').energy);
    world.step();
    const catchUp = tasks.taskOf('a');
    console.log('quota catchup task', `kind=${catchUp?.kind} minutes=${catchUp?.minutes} remaining=${catchUp?.remaining}`);
    world.step();
    world.step();
    console.log('quota catchup account', JSON.stringify(sleep.accountOf('a')), 'remaining', tasks.taskOf('a')?.remaining);
}
