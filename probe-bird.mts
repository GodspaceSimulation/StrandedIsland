import { position3 } from '@godspace/core';
import { createWorld } from './src/engine/world';
import { islandTerrainPlugin } from './src/plugins/terrain/islandTerrain';
import { inventoryPlugin } from './src/plugins/inventory/inventoryPlugin';
import { needsPlugin } from './src/plugins/needs/needsPlugin';
import { relationshipPlugin } from './src/plugins/relationship/relationshipPlugin';
import { tasksPlugin } from './src/plugins/tasks/tasksPlugin';
import { behaviorPlugin } from './src/plugins/behavior/behaviorPlugin';
const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
const needs = needsPlugin({ thirstPerMinute: 0, energyPerMinute: 0, hungerPerMinute: 0 });
const relationship = relationshipPlugin();
const tasks = tasksPlugin();
const behavior = behaviorPlugin({ inventory, needs, relationship, tasks });
const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), inventory, needs, relationship, tasks, behavior] });
world.coordinates.place({ id: 'bird-1', position: position3(6, 2), kind: 'creature', type: 'bird', name: 'Kiki', marker: 'K', state: 'perched' });
needs.satisfy('bird-1', { hunger: 45 }); // 65 = 60 — forage
world.step();
console.log('m1', JSON.stringify(tasks.taskOf('bird-1')));
for (let index = 0; index < 10; index++) { world.step(); }
console.log('m11 bag', JSON.stringify(inventory.of('bird-1')), 'task', JSON.stringify(tasks.taskOf('bird-1')), 'hunger', needs.of('bird-1').hunger);
for (let index = 0; index < 2; index++) { world.step(); }
console.log('m13 bag', JSON.stringify(inventory.of('bird-1')), 'hunger', needs.of('bird-1').hunger, 'task', JSON.stringify(tasks.taskOf('bird-1')));
console.log('stock after', JSON.stringify(inventory.cellStock(6, 2)));
