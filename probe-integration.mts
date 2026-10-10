// TEMP integration probe — derives the new seed-7 terrain truths after the
// river generation (lake water cells, river census, cast spawn ring). Delete
// before final delivery.
import { createWorld } from './src/engine/world';
import { islandTerrainPlugin } from './src/plugins/terrain/islandTerrain';
import { inventoryPlugin } from './src/plugins/inventory/inventoryPlugin';

const inventory = inventoryPlugin({ rainChancePerMinute: 0 });
const world = createWorld({ seed: 7, tickSize: 1, plugins: [islandTerrainPlugin(), inventory] });

// Fresh-water basins and their stocked water (the behavior lake-basin test)
const basins = world.canvas.cells.filter((c) => c.biome === 'lake' || c.biome === 'pond');
for (const c of basins) {
    const s = inventory.cellStock(c.x, c.y);
    console.log('basin', c.biome, c.x, c.y, 'water=', s.water);
}

// River census (R4 visibility + the meadow-census drift)
const river = world.canvas.cells.filter((c) => c.biome === 'river');
console.log('river cells:', river.length, river.map((c) => `${c.x},${c.y}`).join(' '));
console.log('meadow census:', world.canvas.cells.filter((c) => c.biome === 'meadow').length);

// Cardinal connectivity of the river (the R4 "connected rivers" claim)
const set = new Set(river.map((c) => `${c.x},${c.y}`));
const seen = new Set<string>();
const stack = [river[0]];
while (stack.length) {
    const c = stack.pop()!;
    const k = `${c.x},${c.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = `${c.x + dx},${c.y + dy}`;
        if (set.has(n)) stack.push(world.canvas.cells.find((q) => `${q.x},${q.y}` === n)!);
    }
}
console.log('river cardinal-connected component:', seen.size, 'of', river.length);

// Unlimited takeFromCell water on a river cell (R4 public API) — the probe
// actor must exist for the bag; use the cell-stock read instead: the river
// branch never draws the stock down, so repeated takes keep succeeding
if (river[0]) {
    const r = river[0];
    console.log('river cell biome/passable:', r.biome, r.passable);
    console.log('river stock water:', inventory.cellStock(r.x, r.y).water);
}
