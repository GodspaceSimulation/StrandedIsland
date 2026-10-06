# Stranded Island

A god-simulator distribution: a small procedurally generated island (the
**canvas**), a handful of stranded people (the **actors**) with inventories
and relationships, and a whole world that runs on a **ticker** — every tick
carries ONE world minute of simulated time.

## Architecture

The generic engine core lives in `@godspace/core` (`packages/godspace/core`
src/engine): the world container (3D coordinate record + entity registry +
ticker + event bus + plugin roster + the fine-movement ladder) that THIS
distribution inserts its entities and terrain into. The visualization comes
from `@godspace/canvas` (representation plugins bound by the scenario). What
remains here is the distribution's own vocabulary — entities, fruits, items,
terrain — plus the adapter that dresses the engine world with the island
surface:

```
src/
├── engine/        The distribution's half of the @godspace/core contract
│   ├── types.ts     The island's domain types (Actor, TerrainCell, Canvas, …)
│   └── world.ts     The adapter: island entities + canvas surface +
│                     narrative hooks onto the generic engine world
├── plugins/       Swappable environment plugins
│   ├── terrain/      Procedural voxel island generation (seeded, deterministic)
│   ├── entity/       The species registry — stats, attributes, abilities,
│   │                 movement economics and inventory sizes per entity type
│   ├── inventory/    Item catalog, inventories (sized per species), gathering,
│   │                 exchange (trade), the mine-ability gate — the survey
│   │                 seeds the map with the tile deposits AND the biomes'
│   │                 living stocks (berries, mushrooms, coconuts, vines,
│   │                 shells, flints, the sea's fish and seaweed)
│   ├── needs/        Hunger / thirst / energy decay per minute — and the
│   │                 HEALTH reservoir: starvation wounds, a fed body heals,
│   │                 a predator's bite wounds — for EVERY living entity, at
│   │                 its species' own rates. Health 0 is death
│   ├── relationship/ Affinity graph between actors with slow drift
│   ├── tasks/        The task ledger — per-ENTITY FIFO task queues (every
│   │                 living thing plans through it) with WORLD-MINUTE time
│   │                 costs, fed by pluggable behaviour modules
│   │                 (adding/removing one updates every queue)
│   ├── behavior/     Agent behaviour modules (thirst / hunger / rest /
│   │                 social / wander) that QUEUE tasks into the ledger and
│   │                 apply their effects on completion (a walk crossing
│   │                 burns the walk row, a flee the run row). Plans EVERY
│   │                 grounded dry-land creature too: a hungry bird forages,
│   │                 a tired bird roosts, a boar wanders its tile
│   ├── sleep/        The timed sleep behaviour (priority 30, shadows the
│   │                 fallback instant-rest rung)
│   ├── birds/        Seabirds — the Z-axis travelers: altitude fade bands,
│   │                 the vanished higher scale (z ≥ 10 leaves the world's
│   │                 reachable scales), the world edge, and arrivals;
│   │                 flight burns the fly row, perching recovers; a
│   │                 perched bird with ledger tasks skips its own rolls
│   └── sharks/       Sharks — water creatures swimming in past the edge;
│                     swimming burns the swim row, a spent shark rests
├── scenario/      createIslandWorld() — assembles plugins into a ready world
└── features/      React god-view: grid, tile inspector, ticker controls,
                    entity inspector, log
```

The engine and every plugin are pure TypeScript with zero React dependency —
fully unit-testable. The React layer only subscribes to the world's event bus
and ticker state.

## Health — the reservoir between an entity and death

The fourth survival stat (`plugins/needs/needsPlugin.ts`): health is a
WELLBEING reservoir, 100 = healthy, 0 = dead, and it is THE killer — an
entity whose health reaches 0 dies (despawned + the log's "has died."
ending), castaway or creature alike. Health only moves when something
hurts the body:

- **starvation** — hunger or thirst sitting at the 100 line drains health
  every minute (the drain is calibrated off the doom window: an entity
  that stays maxed dies exactly `doomMinutes` world minutes after the
  line is reached);
- **wounds** — a boar's maul drains health straight through `needs.satisfy`
  (plugins/predators), so a cornered castaway can bleed out;
- **healing** — a FED body (hunger ≤ 50 AND thirst ≤ 50) closes wounds
  slowly (`healthRegenPerMinute`); a dry reservoir never regenerates;
- **the species drain** — every profile carries a health decay rate (0 for
  every stock species — nothing sickens on its own).

The god-view reads health through `features/needsDisplay.ts` — a fourth
wellbeing bar on every roster row and in the Entity Inspector.

## Tasks — every living thing plans through the ledger

The behaviour modules register into the task ledger
(`plugins/tasks/taskLedger.ts`) and the behavior plugin plans EVERY LIVING
THING each minute: the registry castaways through their full Actor
records, and the coordinate-space creatures through their coordinate
identity (the `TaskEntity` shape). A hungry gull forages the cell's food
into its beak-bag and eats it; a tired bird roosts; a boar wanders its
tile. Grounded walkers fine-wander when idle — but FLYERS are exempt from
the idle filler (a task queued every minute would close the birds plugin's
busy gate forever and no takeoff would ever fire again): a perched gull
with no pressing need keeps its own perch script. Flyers (birds at z > 0)
and water creatures (sharks) stay wholly plugin-owned — the ledger plans
only what stands on dry ground, and the birds/predators plugins skip their
own random rolls while an entity carries tasks (two drivers would
double-step the same body). The flee-from-beasts rung and the tree-felling
rung stay SENTIENT-only — beasts do not flee beasts, and a gull does not
work the woods.

## The richer map

The survey seeds every tile from its deposits AND its biome's living
stocks (`plugins/inventory/inventoryPlugin.ts`): meadows berry, forests
berry AND mushroom (plus the 35%-draw vine), beaches coconut and the
50%-draw shell, highlands stone/iron and the 30%-draw flint, and the sea
stocks fish plus seaweed (the ocean always, the shallows on a 50% draw).
The new foods regrow on their own rhythms; the hunger ladder gathers
berries, mushrooms, fish, coconuts and seaweed in priority order.

The canvas draws the woods: a treed tile carries the 'tree' DECORATION
(scenario/island.ts decorationOf → @godspace/canvas frames), and the
unicode tab paints the 🌳 emoji on every empty treed tile (entities always
win the tile) while the SVG tab draws the vector tree — trunk + canopy.
DENSE GROVES: forest tiles whose moisture passes
`DENSE_FOREST_MOISTURE_THRESHOLD` carry tree ×6 instead of the base ×2 —
some tiles hold a lot of trees, and each tile's trees scatter onto its own
subtiles when the god zooms in.

## Time, distance and scale

- **Time per tick** — ONE world minute (`TICK_MINUTES`, engine/world.ts): the
  ticker steps 1 minute at a time, and a step's minutes always sub-step one
  at a time (the engine core's `step()`), so all pacing is per-minute.
- **Distance per tick** — ONE SCALE-0 TILE move per tick
  (`TRAVEL_MINUTES_PER_TILE`, scenario/island.ts): the simulation runs at
  Scale 0, the LOWEST level of the view ladder — the tile interiors, where
  the entities move around (one subtile cell per completed move task,
  `world.relocateFine` flowing across tile boundaries).
- **The view ladder** — counts UP from the lowest level (@godspace/core
  src/scale): scale 0 the tile interior (the simulation ground), scale 1 the
  island — THE DEFAULT VIEW, which shows where the Scale-0 entities stand.
  The ladder is a PURE VIEW ladder: zooming never re-times the clock.

## Plugins

A plugin is any object with an `id` and optional `setup` / `tick` / `dispose`
hooks receiving a `PluginContext` (the world). Worlds are configured with a
plugin list; removing a plugin removes that environment behaviour entirely
(e.g. drop the inventory plugin and nobody can gather, eat or trade).
