// Scratch probe: passable dry cells near (0,3) for the safe-water test.
import { createIslandWorld } from './src/scenario/island';
const h = createIslandWorld({ seed: 7 });
for (const [x, y] of [[0,3],[1,3],[2,3],[3,3],[0,4],[0,5],[1,5],[2,5],[4,3],[5,3]]) {
    const c = h.world.cellAt(x, y);
    console.log(x, y, 'passable=', c?.passable, 'biome=', c?.biome);
}
