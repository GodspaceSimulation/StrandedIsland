// TEMP integration probe — re-derives the forest spread capture on the new
// (river-era) seed-7 island. Mirrors forestPlugin.test.ts buildEcology +
// the spread test exactly. Delete before final delivery.
import { createWorld } from './src/engine/world';
import { islandTerrainPlugin } from './src/plugins/terrain/islandTerrain';
import { inventoryPlugin } from './src/plugins/inventory/inventoryPlugin';
import { forestPlugin } from './src/plugins/forest/forestPlugin';

const terrain = islandTerrainPlugin({ width: 25, height: 17 });
const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
const ecology = forestPlugin({ terrain, inventory }, { maturityMinutes: 1, spreadMinutes: 10 });
const world = createWorld({ seed: 7, plugins: [terrain, inventory, ecology] });

const meadowSet = world.canvas.cells
    .filter((cell) => cell.biome === 'meadow')
    .map((cell) => `${cell.x},${cell.y}`);
console.log('MEADOW_BEFORE=' + meadowSet.length);
ecology.fastForward(10);
const converted = world.canvas.cells.filter(
    (cell) => cell.biome === 'forest' && meadowSet.includes(`${cell.x},${cell.y}`),
);
console.log('CONVERTED=' + converted.map((cell) => `${cell.x},${cell.y}:${cell.resources.tree}`).join(','));
console.log('MEADOW_AFTER=' + world.canvas.cells.filter((cell) => cell.biome === 'meadow').length);
console.log('BEACH_-8_1=' + world.cellAt(-8, 1)?.biome + ' FORESTOF=' + terrain.forestOf(-8, 1));
const first = converted[0];
console.log('FIRST=' + first.x + ',' + first.y + ' STOCK_TREE=' + inventory.cellStock(first.x, first.y).tree);
const sub = terrain.canvasFor([{ x: first.x, y: first.y }]);
console.log('SUB_TREECELLS=' + sub?.cells.filter((cell) => (cell.resources.tree ?? 0) === 1).length);
// the converted wood's inventory coherence line (berries persist beside it)
console.log('FIRST_STOCK=' + JSON.stringify(inventory.cellStock(first.x, first.y)));
