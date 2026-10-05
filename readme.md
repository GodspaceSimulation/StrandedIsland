# Stranded Island

A god-simulator distribution: a small procedurally generated island (the
**canvas**), a handful of stranded people (the **actors**) with inventories
and relationships, and a whole world that runs on a **ticker** — every tick
can be a minute, ten minutes, or an hour of simulated time.

## Architecture

Everything is plugin-shaped so environments can be swapped in and out:

```
src/
├── engine/        Framework-free simulation core
│   ├── ticker.ts     World clock — tick size (minutes/tick), realtime speed
│   ├── events.ts     World event bus / log
│   ├── plugin.ts     Plugin registry (add / remove / list — swap in & out)
│   └── world.ts      The World: canvas + actors + plugins + ticker + events
├── plugins/       Swappable environment plugins
│   ├── terrain/      Procedural voxel island generation (seeded, deterministic)
│   ├── inventory/    Item catalog, inventories, gathering, exchange (trade)
│   ├── needs/        Hunger / thirst / energy decay per tick
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

## Time and travel

The world sub-steps every tick ONE world-minute at a time (engine/world.ts),
so all pacing is per-minute and identical at every view scale. ONE TILE of
travel costs **10 world minutes** at scale 0 — the engine pins this cost
(scenario/island.ts `TRAVEL_MINUTES_PER_TILE`), not @godspace/*. Every
behaviour queues tasks with a minute cost; the ledger advances the queue
heads one minute per tick.

## Plugins

A plugin is any object with an `id` and optional `setup` / `tick` / `dispose`
hooks receiving a `PluginContext` (the world). Worlds are configured with a
plugin list; removing a plugin removes that environment behaviour entirely
(e.g. drop the inventory plugin and nobody can gather, eat or trade).
