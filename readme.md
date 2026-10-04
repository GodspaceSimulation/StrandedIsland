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
│   └── behavior/     Agent decision loop (eat / drink / gather / trade / rest / wander)
├── scenario/      createIslandWorld() — assembles plugins into a ready world
└── features/      React god-view: grid, ticker controls, actor inspector, log
```

The engine and every plugin are pure TypeScript with zero React dependency —
fully unit-testable. The React layer only subscribes to the world's event bus
and ticker state.

## Plugins

A plugin is any object with an `id` and optional `setup` / `tick` / `dispose`
hooks receiving a `PluginContext` (the world). Worlds are configured with a
plugin list; removing a plugin removes that environment behaviour entirely
(e.g. drop the inventory plugin and nobody can gather, eat or trade).
