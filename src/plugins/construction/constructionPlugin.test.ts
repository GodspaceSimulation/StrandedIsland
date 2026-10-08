// Tests for the construction plugin (plugins/construction/constructionPlugin.ts).
//
// Deterministic and exact: the plugin plans the island's build projects
// through the SHARED stack (@godspace/blueprint's blueprint + site
// registries, @godspace/material's crafting registry, @godspace/core's task
// scheduler + craft/build behaviour factories), so the assertions pin the
// island's wiring — the rung roster, the scale-0 placement, the progressive
// staging, the per-minute work stages, the completed-footprint blocking,
// the shelter's survival use and the vessel launch — against the
// deterministic seed-7 island (the same reference island the scenario tests
// read; see scenario/island.test.ts).

import { describe, it, expect } from 'vitest';
import { createIslandWorld, type IslandHandle } from '../../scenario/island';
import { fineStep } from '../../plugins/movement/fineMovement';
import { scaleView, tileSummary, structureLine } from '../../features/tileDetails';
import { position3 } from '@godspace/core';
import type { SiteRegistry } from '@godspace/blueprint';

/** The stock world at seed 7 — the whole environment mounted. */
const island = (options?: Parameters<typeof createIslandWorld>[0]): IslandHandle =>
    createIslandWorld({ seed: 7, ...options });

/** The mounted site registry (created at the terrain plugin's setup). */
const sites = (handle: IslandHandle): SiteRegistry => handle.construction.sites;

describe('constructionPlugin — the shared registries', () => {
    it('wires the stock blueprint registry and the island recipes', () => {
        const handle = island();
        // The five stock structural patterns the island builds through
        expect(handle.construction.blueprints.blueprints().map((blueprint) => blueprint.id)).toEqual([
            'shelter',
            'house',
            'fort',
            'raft',
            'boat',
        ]);
        // The island's own recipes — coined on @godspace/material's crafting
        // registry (stock: false — the stock recipes reference fiber/clay
        // items the island does not grow)
        expect(handle.construction.crafting.recipes().map((recipe) => recipe.id)).toEqual([
            'rope',
            'plank',
            'thatch',
            'cloth',
            // R4: the early tools — the axe (wood + stone) and the hammer
            // (wood), each crafted ONCE per castaway crew
            'axe',
            'hammer',
        ]);
        // The atomic craft over island materials: two vines twist into one rope
        expect(handle.construction.crafting.craft('rope', { vine: 2 })).toEqual({
            ok: true,
            recipe: {
                id: 'rope',
                label: 'Rope',
                kind: 'part',
                inputs: [{ item: 'vine', count: 2 }],
                outputs: [{ item: 'rope', count: 1 }],
                minutes: 5,
            },
            consumed: [{ item: 'vine', count: 2 }],
            produced: [{ item: 'rope', count: 1 }],
            stock: { rope: 1 },
        });
        // A short stock is refused whole — no ingredient loss
        expect(handle.construction.crafting.craft('rope', { vine: 1 })).toEqual({
            ok: false,
            reason: 'missing-inputs',
            recipeId: 'rope',
            missing: [{ item: 'vine', count: 2, have: 1 }],
        });
        // The recipe registry validates against the island's item catalog
        expect(handle.construction.crafting.craft('ghost-recipe', {})).toEqual({
            ok: false,
            reason: 'unknown-recipe',
            recipeId: 'ghost-recipe',
        });
    });

    it('registers the construction rungs between rest (25) and social (20), built from the shared factories', () => {
        const handle = island();
        // The planning order — the priority DESC walk the ledger plans
        // through. The craft and build rungs are composed FROM the core's
        // craftTaskBehaviour/buildTaskBehaviour factories (the rung
        // priorities ride the factory options); the island's deliver and
        // materials rungs fill the gaps between them.
        expect(handle.tasks.ledger.behaviours().map((module) => ({ id: module.id, priority: module.priority ?? 0 }))).toEqual([
            { id: 'survival', priority: 60 },
            { id: 'thirst', priority: 50 },
            { id: 'hunger', priority: 40 },
            { id: 'roost', priority: 33 },
            { id: 'sleep', priority: 30 },
            { id: 'rest', priority: 25 },
            { id: 'deliver', priority: 24 },
            { id: 'craft-rope', priority: 23 },
            { id: 'craft-plank', priority: 23 },
            { id: 'craft-thatch', priority: 23 },
            { id: 'craft-cloth', priority: 23 },
            // R4: the tool recipes + the once-crafted tool rungs (each at
            // CRAFT_PRIORITY, gated to craft once per crew)
            { id: 'craft-axe', priority: 23 },
            { id: 'craft-hammer', priority: 23 },
            { id: 'tool-axe', priority: 23 },
            { id: 'tool-hammer', priority: 23 },
            { id: 'fetch-vine', priority: 22 },
            { id: 'fetch-frond', priority: 22 },
            { id: 'fetch-stone', priority: 22 },
            { id: 'materials', priority: 22 },
            { id: 'build-shelter', priority: 21 },
            { id: 'build-house', priority: 21 },
            { id: 'build-fort', priority: 21 },
            { id: 'build-raft', priority: 21 },
            { id: 'build-boat', priority: 21 },
            { id: 'social', priority: 20 },
            { id: 'lumber', priority: 10 },
            { id: 'wander', priority: 0 },
        ]);
        // The tool rungs (23) sit BELOW the survival needs (survival 60,
        // thirst 50, hunger 40, rest 25) — an early tool-craft never
        // pre-empts a survival rung; the ledger's priority walk consults the
        // survival rungs first, so a castaway in need is never diverted
        // into tooling.
    });

    it('R4: the early tool-craft rung owes each tool ONCE per crew — one axe in any bag closes the gate', () => {
        const handle = island();
        // The roster's tool-axe module (the once-crafted axe's craft rung)
        const ael = handle.world.actors.get('actor-1')!;
        const subject = { id: ael.id, actor: ael };
        const toolAxe = handle.tasks.ledger.behaviours().find((module) => module.id === 'tool-axe');
        expect(toolAxe).toBeDefined();
        // actor-1 carries the axe's raw inputs (a log + a stone) and NO crew
        // member carries an axe yet — the rung owes the craft to this actor
        handle.inventory.spawnKit('actor-1', { wood: 1, stone: 1 });
        expect(toolAxe?.appliesTo?.(subject as never)).toBe(true);
        // THE ONCE-GATE: a DUREABLE concept — the moment any crew member
        // carries the axe the crew "has an axe" and the tool-craft rung stops
        // owing it (the build projects consume no tools, so this shared
        // gate is what ends the owed craft)
        handle.inventory.spawnKit('actor-2', { axe: 1 });
        expect(toolAxe?.appliesTo?.(subject as never)).toBe(false);
    });

    it('R4: the tool-lead hold releases the moment the crew holds the tool (the reserve dies with the debt)', () => {
        // THE HOLD'S OTHER HALF — owedToolInputsOf reserves the craft inputs
        // ONLY while the tool is UNMET. Once any bag carries the tool the
        // once-gate closes the owed craft, and the lead must go back to
        // hauling: the protected units of a CLOSED craft would otherwise
        // block its fetch/seek/fell/deliver forever on material the crew
        // now needs (the reserve outliving the debt).
        const handle = island();
        handle.world.step(); // the shelter project opens — staged, owes wood 2
        const site = handle.construction.activeSite();
        expect(site).toMatchObject({ blueprintId: 'shelter', state: 'staged' });
        const ael = handle.world.actors.get('actor-1')!;
        const subject = { id: ael.id, actor: ael } as never;
        const deliver = handle.tasks.ledger.behaviours().find((module) => module.id === 'deliver');
        expect(deliver).toBeDefined();
        // actor-1 is the AXE LEAD: its bag holds the axe's full input set
        // (wood 1 + stone 1) and the crew carries no axe. The deliver rung
        // declines its input-only load — the seed-7 starvation protection,
        // intact: the unit the 5-minute craft waits on stays in the bag
        handle.inventory.spawnKit('actor-1', { wood: 1, stone: 1 });
        expect(deliver?.appliesTo?.(subject)).toBe(false);
        // THE RELEASE — the axe lands in ANOTHER crew bag (the once-gate
        // closes; actor-1 never crafts it): the same wood unit is no longer
        // a protected input of an owed craft, and the shelter takes the haul
        handle.inventory.spawnKit('actor-2', { axe: 1 });
        expect(deliver?.appliesTo?.(subject)).toBe(true);
        // And the hammer lead releases the same way: actor-1 now holds the
        // hammer's full input set (wood 2) and leads it while the hammer is
        // unmet — held, then released by one hammer
        handle.inventory.spawnKit('actor-1', { wood: 1 }); // wood 2 total — the hammer's input
        const hammerLeadHolds = deliver?.appliesTo?.(subject); // wood 2 − hammer 2 = 0 → still held
        expect(hammerLeadHolds).toBe(false);
        handle.inventory.spawnKit('actor-2', { hammer: 1 });
        expect(deliver?.appliesTo?.(subject)).toBe(true);
    });

    it('R4: both early tools land in a crew bag in a NORMAL world — once each, inputs consumed', () => {
        // A FRESH registry handle proves the tools are CRAFTED (their raw
        // inputs are consumed, never spawned for free): the axe's log + stone
        // and the hammer's two logs come off the hand.
        const ledger = island();
        expect(ledger.construction.crafting.craft('axe', { wood: 1, stone: 1 })).toEqual({
            ok: true,
            recipe: {
                id: 'axe',
                label: 'Axe',
                kind: 'tool',
                inputs: [{ item: 'wood', count: 1 }, { item: 'stone', count: 1 }],
                outputs: [{ item: 'axe', count: 1 }],
                minutes: 5,
            },
            consumed: [{ item: 'wood', count: 1 }, { item: 'stone', count: 1 }],
            produced: [{ item: 'axe', count: 1 }],
            stock: { axe: 1 },
        });
        expect(
            ledger.construction.crafting.craft('hammer', { wood: 2 }).consumed,
        ).toEqual([{ item: 'wood', count: 2 }]);

        // THE NORMAL-WORLD CAMPAIGN — the seed-7 handle carries only the
        // STARTING_KIT (berry + flint), no injected tool inputs. The crew
        // must gather the axe's STONE itself (the demand the R4 fix folds
        // into the early fetches) and craft BOTH tools, each ONCE, well
        // inside 400 minutes. Pinned from the run: hammer@262, axe@375, and
        // each tool's crew total peaks at EXACTLY one (the once-gate plus
        // the deterministic lead gate end the craft after a single output).
        // The finite-stone shift moved the axe late in the window (stone
        // now stands only on the 9 highland rock sites — the crew treks to
        // them instead of gathering stone underfoot, and the stone/wood
        // combo must land in ONE bag for the 5-minute craft; the tool-lead
        // hold in the construction plugin keeps the lead actor's input bag
        // intact while the ladder commits it — see owedToolInputsOf).
        const handle = island();
        const crewTotal = (tool: string): number =>
            [...handle.world.actors.values()].reduce(
                (sum, actor) => sum + (handle.inventory.of(actor.id)[tool] ?? 0),
                0,
            );
        let axeAt = -1;
        let hammerAt = -1;
        let axeMax = 0;
        let hammerMax = 0;
        for (let minute = 0; minute < 400; minute++) {
            handle.world.step();
            const a = crewTotal('axe');
            const h = crewTotal('hammer');
            axeMax = Math.max(axeMax, a);
            hammerMax = Math.max(hammerMax, h);
            if (axeAt < 0 && a > 0) {
                axeAt = minute;
            }
            if (hammerAt < 0 && h > 0) {
                hammerAt = minute;
            }
        }
        expect(axeAt).toBe(375);
        expect(hammerAt).toBe(262);
        expect(axeMax).toBe(1);
        expect(hammerMax).toBe(1);
    });

    it('the craft rung\'s bag-room gate is the NET (post-craft) fit: a full hand holding the recipe\'s raws still crafts', () => {
        const handle = island();
        // The shelter opens on the first tick and still owes its thatch
        // (the craft-thatch rung's siteNeeds reads the active site live)
        handle.world.step();
        const ael = handle.world.actors.get('actor-1')!;
        const bram = handle.world.actors.get('actor-2')!;
        const subjectOf = (actor: (typeof ael & typeof bram)) => ({ id: actor.id, actor }) as never;
        const craftThatch = handle.tasks.ledger.behaviours().find((module) => module.id === 'craft-thatch');
        expect(craftThatch).toBeDefined();
        // THE WEDGED BAG — actor-1 starts with the STARTING_KIT (berry 2 +
        // flint 1 = three units) and is filled to EXACTLY the eight-unit
        // capacity with the thatch's raws plus surplus: three fronds (the
        // craft's two-input recipe has room in the hand) and two logs.
        handle.inventory.spawnKit('actor-1', { frond: 3, wood: 2 });
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1, frond: 3, wood: 2 });
        // The old gate was `total + output > capacity` — eight + one = nine
        // refuses the craft that is the ONLY rung able to free a slot (it
        // converts a raw the site lacks into the part it owes), clogging
        // the hand and starving the carrier past the food (the 6000-minute
        // seed-7 march deaths: Bram @4,5 minute 3231, Dune @3,5 minute 3237,
        // each holding exactly three fronds while the boat owed its cloth).
        // The net gate mirrors the craft EFFECT's revalidation (stock =
        // bag − inputs + outputs): eight − two + one = seven fits the bag,
        // so the craft stays owed on a FULL hand.
        expect(craftThatch?.appliesTo?.(subjectOf(ael))).toBe(true);
        // The ingredient gate is UNTOUCHED: actor-2 carries the same full
        // hand WITHOUT the recipe's raws (three logs + two vines fill it) —
        // the craft still refuses, the gate is the net fit AND the inputs.
        handle.inventory.spawnKit('actor-2', { wood: 3, vine: 2 });
        expect(handle.inventory.of('actor-2')).toEqual({ berry: 2, flint: 1, wood: 3, vine: 2 });
        expect(craftThatch?.appliesTo?.(subjectOf(bram))).toBe(false);
    });
});

describe('constructionPlugin — placement and the scale-0 footprint', () => {
    it('places the first project on the interior, reserving scale-0 fine cells (not coarse tiles)', () => {
        const handle = island();
        handle.world.step();
        // The shelter project opened on the first tick: the centrality-first
        // scan put it on the canvas middle tile (0,0) — dry land, nobody
        // standing in the footprint's fine cells
        const placed = sites(handle).sites();
        expect(placed.map((site) => ({ blueprintId: site.blueprintId, state: site.state, parent: site.parent, anchor: site.anchor, scale: site.scale, rotation: site.rotation }))).toEqual([
            { blueprintId: 'shelter', state: 'staged', parent: [{ x: 0, y: 0 }], anchor: { x: 0, y: 0 }, scale: 0, rotation: 0 },
        ]);
        // The footprint resolves to SCALE-0 FINE CELLS of the parent tile's
        // sub-grid — never coarse island tiles
        expect(sites(handle).cellsOf(placed[0].id)).toEqual([
            { parent: [{ x: 0, y: 0 }], x: 0, y: 0, scale: 0, offset: { x: 0, y: 0 } },
            { parent: [{ x: 0, y: 0 }], x: 1, y: 0, scale: 0, offset: { x: 1, y: 0 } },
        ]);
        // The GATE is the resolved first definition cell — the walkable one
        expect(handle.construction.project()).toBe('shelter');
    });

    it('the placement clearance skips a tile with a body standing in the footprint', () => {
        const handle = island();
        // Park a body exactly on the centrality-first anchor fine cell
        // (tile (0,0), fine (0,0)) before the first tick — the scan must
        // skip the tile and take the next feasible one
        handle.world.spawn({
            id: 'blocker',
            name: 'Bloc',
            kind: 'sentient',
            type: 'human',
            position: position3(0, 0),
            marker: 'B',
            condition: 'well',
            profile: { sex: 'male' },
        });
        const sub = handle.world.subOf('blocker');
        handle.world.relocateFine('blocker', 0 - sub.x, 0 - sub.y);
        handle.world.step();
        // The shelter moved to the next centrality-feasible dry tile
        expect(sites(handle).sites().map((site) => ({ blueprintId: site.blueprintId, parent: site.parent }))).toEqual([
            { blueprintId: 'shelter', parent: [{ x: -1, y: 0 }] },
        ]);
        expect(sites(handle).cellsOf(sites(handle).sites()[0].id)).toEqual([
            { parent: [{ x: -1, y: 0 }], x: 0, y: 0, scale: 0, offset: { x: 0, y: 0 } },
            { parent: [{ x: -1, y: 0 }], x: 1, y: 0, scale: 0, offset: { x: 1, y: 0 } },
        ]);
    });

    it('vessels moor on a beach tile with a water neighbour (the launch mooring)', () => {
        // The raft project opens when the shelter completes (minute 356);
        // by minute 1000 the raft is built on a moored beach
        const handle = island();
        for (let minute = 0; minute < 1000; minute++) {
            handle.world.step();
        }
        const raft = sites(handle).sites().find((site) => site.blueprintId === 'raft');
        expect(raft?.state).toBe('built');
        const tile = handle.world.cellAt(raft?.parent[0].x ?? 0, raft?.parent[0].y ?? 0);
        expect(tile?.biome).toBe('beach');
        // A water neighbour beside the shore — the mooring the launch reads
        const hasWater = [
            { x: (raft?.parent[0].x ?? 0) - 1, y: raft?.parent[0].y ?? 0 },
            { x: (raft?.parent[0].x ?? 0) + 1, y: raft?.parent[0].y ?? 0 },
            { x: raft?.parent[0].x ?? 0, y: (raft?.parent[0].y ?? 0) - 1 },
            { x: raft?.parent[0].x ?? 0, y: (raft?.parent[0].y ?? 0) + 1 },
        ].some((neighbor) => {
            const cell = handle.world.cellAt(neighbor.x, neighbor.y);
            return cell !== undefined && !cell.passable;
        });
        expect(hasWater).toBe(true);
    });
});

describe('constructionPlugin — the autonomous staging and work', () => {
    it('stages progressively past the bag size and builds only what is ready (shelter + raft by minute 1000)', () => {
        const handle = island();
        for (let minute = 0; minute < 1000; minute++) {
            handle.world.step();
        }
        // The shelter: staged wood 2 + thatch 2 (the thatch woven from four
        // fronds the crew fetched and crafted), then 10 work minutes
        const shelter = sites(handle).sites().find((site) => site.blueprintId === 'shelter');
        expect(shelter).toMatchObject({ state: 'built', work: 10 });
        expect(shelter?.delivered).toEqual({ wood: 2, thatch: 2 });
        // The raft: wood 4 + rope 2 (two vine twists), 30 work minutes —
        // every unit ferried through the eight-unit bags
        const raft = sites(handle).sites().find((site) => site.blueprintId === 'raft');
        expect(raft).toMatchObject({ state: 'built', work: 30 });
        expect(raft?.delivered).toEqual({ wood: 4, rope: 2 });
        // The completion ledger, in plan order; the house project is live
        expect(handle.construction.completedBlueprints()).toEqual(['shelter', 'raft']);
        expect(handle.construction.project()).toBe('house');
        expect(handle.construction.activeSite()).toMatchObject({ blueprintId: 'house', state: 'staged' });
        // The work NEVER overflowed its blueprint cost (the per-minute
        // stages clamp at the shared registry) — and every site carries its
        // placement snapshot (`required` / `cost`, the shared change the
        // deliver effect and the whole staging demand read)
        expect(handle.construction.blueprints.definitionOf('shelter')?.work).toBe(10);
        expect(handle.construction.blueprints.definitionOf('raft')?.work).toBe(30);
        expect(shelter?.required).toEqual([
            { item: 'wood', count: 2 },
            { item: 'thatch', count: 2 },
        ]);
        expect(shelter?.cost).toBe(10);
        expect(raft?.required).toEqual([
            { item: 'wood', count: 4 },
            { item: 'rope', count: 2 },
        ]);
        expect(raft?.cost).toBe(30);
    });

    it('a completed footprint walls its cells off — the gate stays usable', () => {
        const handle = island();
        for (let minute = 0; minute < 360; minute++) {
            handle.world.step();
        }
        const shelter = sites(handle).sites().find((site) => site.blueprintId === 'shelter');
        const cells = sites(handle).cellsOf(shelter?.id ?? '') ?? [];
        expect(cells.length).toBe(2);
        const [gateCell, wallCell] = cells;
        expect(shelter?.state).toBe('built');
        // The world's structure hook (fineMovement.fineSpotTaken reads it):
        // the wall blocks, the gate never
        expect(handle.world.structures?.blocksFineSpot(gateCell.parent[0].x, gateCell.parent[0].y, wallCell.x, wallCell.y)).toBe(true);
        expect(handle.world.structures?.blocksFineSpot(gateCell.parent[0].x, gateCell.parent[0].y, gateCell.x, gateCell.y)).toBe(false);
        // The movement rule end to end: a mover on the shelter tile cannot
        // fine-step INTO the wall cell, and CAN step onto the gate
        const mover = handle.world.actors.get('actor-1');
        expect(mover).toBeDefined();
        if (!mover) {
            return;
        }
        handle.world.relocate(mover.id, { x: gateCell.parent[0].x, y: gateCell.parent[0].y, z: 0 });
        handle.tasks.cancel(mover.id);
        const sub = handle.world.subOf(mover.id);
        expect(sub).toBeDefined();
        expect(fineStep(handle.world, mover, wallCell.x - (sub?.x ?? 0), wallCell.y - (sub?.y ?? 0))).toBeUndefined();
        expect(fineStep(handle.world, mover, gateCell.x - (sub?.x ?? 0), gateCell.y - (sub?.y ?? 0))).toEqual({
            parent: { dx: 0, dy: 0 },
        });
    });

    it('a sheltered sleeper recovers faster — the shelter rest bonus', () => {
        const handle = island();
        for (let minute = 0; minute < 400; minute++) {
            handle.world.step();
        }
        const shelter = sites(handle).sites().find((site) => site.blueprintId === 'shelter');
        const gate = (sites(handle).cellsOf(shelter?.id ?? '') ?? [])[0];
        expect(shelter?.state).toBe('built');
        // Park the body on the shelter's gate, freeze the belly pressures and
        // drain it to the sleep line: ten world minutes of sheltered sleep
        const sleeper = handle.world.actors.get('actor-1');
        expect(sleeper).toBeDefined();
        if (!sleeper || !gate) {
            return;
        }
        handle.world.relocate(sleeper.id, { x: gate.parent[0].x, y: gate.parent[0].y, z: 0 });
        handle.tasks.cancel(sleeper.id);
        const sub = handle.world.subOf(sleeper.id);
        handle.world.relocateFine(sleeper.id, gate.x - (sub?.x ?? 0), gate.y - (sub?.y ?? 0));
        handle.tasks.cancel(sleeper.id);
        handle.needs.satisfy(sleeper.id, { hunger: -100, thirst: -100, energy: -80 });
        for (let minute = 0; minute < 10; minute++) {
            handle.world.step();
        }
        // The sleep restore (1.2/min) + the shelter bonus (0.5/min) − the
        // decay (0.06/min): 1.64 per sleeping minute — the sheltered night
        // is the safe night. Pinned from the run (the finite-stone campaign
        // — the highland stone trek plus the tool-lead hold — shifted the
        // 400-min campaign minutes again, so the pin moved).
        expect(handle.needs.of(sleeper.id).energy).toBe(16.459999999999994);
        expect(handle.tasks.taskOf(sleeper.id)?.kind).toBe('sleep');
    });
});

describe('constructionPlugin — the inspection and render surfaces', () => {
    it('the tile inspector lists the site with its staging ledger and work progress', () => {
        const handle = island();
        for (let minute = 0; minute < 360; minute++) {
            handle.world.step();
        }
        const shelter = sites(handle).sites().find((site) => site.blueprintId === 'shelter');
        const cells = sites(handle).cellsOf(shelter?.id ?? '') ?? [];
        const path = [{ x: cells[0].parent[0].x, y: cells[0].parent[0].y }];
        const summary = tileSummary(handle, path);
        expect(summary?.structures).toEqual([
            {
                siteId: 's-1',
                blueprintId: 'shelter',
                label: 'Shelter',
                state: 'built',
                gate: true,
                workDone: 10,
                workTotal: 10,
                staged: [
                    { item: 'wood', have: 2, need: 2 },
                    { item: 'thatch', have: 2, need: 2 },
                ],
            },
        ]);
        // The readable line the Tile Inspector renders
        expect(structureLine(summary?.structures[0] as never)).toBe(
            'Shelter · built · gate · wood 2/2 · thatch 2/2 · work 10/10',
        );
        // A tile without a site lists none
        const empty = tileSummary(handle, [{ x: -11, y: 0 }]);
        expect(empty?.structures).toEqual([]);
    });

    it('the scale views draw the footprint: fine cells in the interior, tile summaries at the island view', () => {
        const handle = island();
        for (let minute = 0; minute < 360; minute++) {
            handle.world.step();
        }
        const shelter = sites(handle).sites().find((site) => site.blueprintId === 'shelter');
        const cells = sites(handle).cellsOf(shelter?.id ?? '') ?? [];
        const path = [{ x: cells[0].parent[0].x, y: cells[0].parent[0].y }];
        // The interior view (scale 0): every covered fine cell of the
        // inspected tile draws, one entry per cell, beneath the living
        // bodies (z −1)
        const slice = scaleView(handle, path);
        expect((slice?.coordinates.all() ?? []).filter((entry) => entry.kind === 'structure')).toEqual([
            { id: 'structure:s-1:0,0', position: { x: 0, y: 0, z: -1 }, kind: 'structure', type: 'shelter', name: 'Shelter' },
            { id: 'structure:s-1:1,0', position: { x: 1, y: 0, z: -1 }, kind: 'structure', type: 'shelter', name: 'Shelter' },
        ]);
        // The island view (the root): one entry per tile the live sites cover
        const root = scaleView(handle, []);
        expect((root?.coordinates.all() ?? []).filter((entry) => entry.kind === 'structure')).toEqual([
            { id: 'structure:s-1:0,0', position: { x: 0, y: 0, z: -1 }, kind: 'structure', type: 'shelter', name: 'Shelter' },
            { id: 'structure:s-2:-7,5', position: { x: -7, y: 5, z: -1 }, kind: 'structure', type: 'raft', name: 'Raft' },
        ]);
        // The canvases resolve the entries' TYPE through the structure
        // palette: the unicode tab draws the blueprint emoji, the ascii twin
        // the blueprint initial
        const unicodeFrame = handle.unicode.frameFor(slice as never);
        const wallTile = unicodeFrame.tiles.find((tile) => tile.x === cells[1].x && tile.y === cells[1].y);
        expect(wallTile?.glyphs).toEqual([
            { id: 'structure:s-1:1,0', glyph: '🏕️', color: '#e6e9ee', elevation: -1, kind: 'structure', type: 'shelter' },
        ]);
        const asciiFrame = handle.ascii.frameFor(slice as never);
        const asciiTile = asciiFrame.tiles.find((tile) => tile.x === cells[1].x && tile.y === cells[1].y);
        expect(asciiTile?.glyphs).toEqual([
            { id: 'structure:s-1:1,0', glyph: 'S', color: '#e6e9ee', elevation: -1, kind: 'structure', type: 'shelter' },
        ]);
    });

    it('a remove+redefine mid-delivery keeps the site snapshot: no throw, original staging, exact bag subtraction, refund and a fresh snapshot for new sites', () => {
        // THE REVIEWER REPRO (deterministic): the deliver effect used to read
        // the LIVE definition's requires while the shared registry validated
        // against the site's placement snapshot — remove+redefine the
        // blueprint between queueing and completing and the effect staged
        // past the snapshot (over-staged by 2) and THREW inside world.step.
        // The fix: every staging read walks `site.required`.
        const handle = island({ actorCount: 1 });
        handle.world.step(); // s-1 placed on the centrality-first tile (0,0)
        // The snapshot rides the site record: the ORIGINAL requirements and
        // cost, copied at placement
        expect(sites(handle).siteOf('s-1')?.required).toEqual([
            { item: 'wood', count: 2 },
            { item: 'thatch', count: 2 },
        ]);
        expect(sites(handle).siteOf('s-1')?.cost).toBe(10);
        // Stage one wood, park the worker on the footprint with a loaded bag
        // and queue the 1-minute delivery by hand
        sites(handle).deliver('s-1', 'wood', 1);
        const gate = (sites(handle).cellsOf('s-1') ?? [])[0];
        handle.world.relocate('actor-1', { x: gate.parent[0].x, y: gate.parent[0].y, z: 0 });
        handle.tasks.cancel('actor-1');
        const sub = handle.world.subOf('actor-1');
        handle.world.relocateFine('actor-1', gate.x - (sub?.x ?? 0), gate.y - (sub?.y ?? 0));
        handle.tasks.cancel('actor-1');
        handle.inventory.spawnKit('actor-1', { wood: 3, vine: 2 });
        handle.tasks.ledger.queue('actor-1', 'deliver', [
            { kind: 'deliver', label: 'delivers materials', minutes: 1, payload: { siteId: 's-1' } },
        ]);
        // THE REDEFINITION — the blueprint grows its requirements and cost
        // while the delivery is queued mid-flight
        handle.construction.blueprints.remove('shelter');
        handle.construction.blueprints.define({
            id: 'shelter',
            label: 'Shelter',
            cells: [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
            ],
            requires: [
                { item: 'wood', count: 5 },
                { item: 'vine', count: 3 },
            ],
            work: 12,
        });
        // Two steps — the OLD code threw "over-staged by 2" here
        expect(() => {
            handle.world.step();
            handle.world.step();
        }).not.toThrow();
        // The staging walked the SNAPSHOT (wood remaining 2−1=1): exactly one
        // more wood staged, the snapshot satisfied — the redefined wood 5
        // never reached the site
        expect(sites(handle).siteOf('s-1')?.delivered).toEqual({ wood: 2 });
        // THE BAG SUBTRACTION IS EXACT — one wood left the bag, no new item
        // appeared, no item was lost (the vine rides along untouched)
        expect(handle.inventory.of('actor-1')).toEqual({ berry: 2, flint: 1, wood: 2, vine: 2 });
        // A NEWLY PLACED site resolves through the LIVE definition — its
        // snapshot carries the redefined requirements and cost
        const fresh = sites(handle).place({
            blueprintId: 'shelter',
            parent: [{ x: -1, y: 0 }],
            anchor: { x: 0, y: 0 },
        });
        expect(fresh.required).toEqual([
            { item: 'wood', count: 5 },
            { item: 'vine', count: 3 },
        ]);
        expect(fresh.cost).toBe(12);
        // …and its refund reads ITS snapshot: two woods staged, cancelled,
        // exactly the staged wood returned (requirement order)
        sites(handle).deliver(fresh.id, 'wood', 2);
        expect(sites(handle).cancel(fresh.id)).toEqual([{ item: 'wood', count: 2 }]);
        // The original construction FINISHES on its snapshot: the god drains
        // the dead vine stock (the redefined requirement never applied to
        // s-1), the crew fetches the snapshot's thatch and works the
        // snapshot's 10 minutes — the redefined cost (12) and the redefined
        // wood 5 / vine 3 never touch the existing site
        delete handle.inventory.of('actor-1').vine;
        for (let minute = 0; minute < 600; minute++) {
            handle.world.step();
        }
        expect(sites(handle).siteOf('s-1')).toMatchObject({ state: 'built', work: 10 });
        expect(sites(handle).siteOf('s-1')?.delivered).toEqual({ wood: 2, thatch: 2 });
        expect(sites(handle).siteOf('s-1')?.required).toEqual([
            { item: 'wood', count: 2 },
            { item: 'thatch', count: 2 },
        ]);
        expect(sites(handle).siteOf('s-1')?.cost).toBe(10);
        expect(handle.construction.completedBlueprints()).toEqual(['shelter']);
    });
});

describe('constructionPlugin — the vessels', () => {
    it('launches a built raft into the water beside its shore and moors the vessel', () => {
        const handle = island();
        for (let minute = 0; minute < 1000; minute++) {
            handle.world.step();
        }
        const raft = sites(handle).sites().find((site) => site.blueprintId === 'raft');
        expect(raft?.state).toBe('built');
        // The launch: the site frees (no refund — the materials sail with
        // the hull) and the concrete output is the moored vessel record
        const vessel = handle.construction.launch(raft?.id ?? '');
        expect(vessel).toEqual({
            id: 'v-1',
            siteId: 's-2',
            blueprintId: 'raft',
            label: 'Raft',
            x: -7,
            y: 5,
            launchedAt: 1000,
        });
        expect(handle.construction.vessels()).toEqual([vessel]);
        expect(sites(handle).siteOf(raft?.id ?? '')).toBeUndefined();
        // The log carries the launch (a world-scale happening)
        expect(handle.world.events.log().filter((event) => event.kind === 'launch').map((event) => event.message)).toEqual([
            'The raft is launched into the water at (-7, 5).',
        ]);
        // The completed ledger keeps the raft (the plan never rebuilds it)
        expect(handle.construction.completedBlueprints()).toEqual(['shelter', 'raft']);
        expect(handle.construction.project()).toBe('house');
        // A second launch of the same site is a no-op…
        expect(handle.construction.launch(raft?.id ?? '')).toBeUndefined();
        // …and a BUILT NON-vessel (the shelter) cannot launch
        expect(handle.construction.launch('s-1')).toBeUndefined();
        expect(handle.construction.vessels()).toHaveLength(1);
    });
});
