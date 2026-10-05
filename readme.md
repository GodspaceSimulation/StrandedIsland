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
│   ├── inventory/    Item catalog, inventories, gathering, exchange (trade)
│   ├── needs/        Hunger / thirst / energy decay per minute
│   ├── relationship/ Affinity graph between actors with slow drift
│   ├── tasks/        The task ledger — per-actor FIFO task queues with
│   │                 WORLD-MINUTE time costs, fed by pluggable behaviour
│   │                 modules (adding/removing one updates every queue)
│   ├── behavior/     Agent behaviour modules (thirst / hunger / rest /
│   │                 social / wander) that QUEUE tasks into the ledger and
│   │                 apply their effects on completion
│   ├── sleep/        The timed sleep behaviour (priority 30, shadows the
│   │                 fallback instant-rest rung)
│   ├── birds/        Seabirds — the Z-axis travelers: altitude fade bands,
│   │                 the vanished higher scale (z ≥ 10 leaves the world's
│   │                 reachable scales), the world edge, and arrivals
│   └── sharks/       Sharks — water creatures swimming in past the edge
├── scenario/      createIslandWorld() — assembles plugins into a ready world
└── features/      React god-view: grid, tile inspector, ticker controls,
                    actor inspector, log
```

The engine and every plugin are pure TypeScript with zero React dependency —
fully unit-testable. The React layer only subscribes to the world's event bus
and ticker state.

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
