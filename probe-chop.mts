// TEMP probe: find a rock-decorated tile (live stone stock) on seed 7
import { createIslandWorld } from './src/scenario/island';
const h = createIslandWorld({ seed: 7 });
for (const cell of h.world.canvas.cells) {
    const stock = h.inventory.cellStock(cell.x, cell.y);
    if ((stock.stone ?? 0) > 0) {
        console.log('rock tile', cell.x, cell.y, JSON.stringify(stock));
    }
}
// also: who chops at minute 1 with farming OFF?
const g = createIslandWorld({ seed: 7, plugins: { farming: false } });
g.world.step();
for (const actor of g.world.actors.values()) {
    const task = g.tasks.taskOf(actor.id);
    if (task) console.log('nofarm', actor.id, JSON.stringify(actor.position), task.kind, task.label);
}
