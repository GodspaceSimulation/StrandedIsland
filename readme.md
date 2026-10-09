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
│   ├── forest/       The forest ecology — trees grow wood biologically on
│   │                 the persistent fine-scale stands (recruitment even
│   │                 clearcut, spread over grass only), and the wood
│   │                 harvest provider it mounts into the inventory
│   ├── needs/        Hunger / thirst / energy decay per minute — and the
│   │                 HEALTH reservoir: starvation wounds, a fed body heals,
│   │                 a predator's bite wounds — for EVERY living entity, at
│   │                 its species' own rates. Health 0 is death
│   ├── relationship/ Affinity graph between actors with slow drift
│   ├── tasks/        The task ledger — per-ENTITY FIFO task queues (every
│   │                 living thing plans through it) with WORLD-MINUTE time
│   │                 costs, fed by pluggable behaviour modules
│   │                 (adding/removing one updates every queue). A thin
│   │                 adapter over @godspace/core's task scheduler — the
│   │                 shared core owns the queue/priority/pre-emption/
│   │                 completion semantics; the island renames subjectId
│   │                 → actorId at the boundary
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
│   ├── survival/     The flee-from-wild-animals rung (priority 60 — the
│   │                 top of the ladder; a threat pre-empts every queue)
│   ├── lumber/       The tree-felling rung (priority 10): fells trees into
│   │                 wood (the chop → bag harvest)
│   ├── construction/ The build/craft governance (priorities 15–24): the
│   │                 stock blueprints and the construction sites over
│   │                 @godspace/blueprint, the island recipes over
│   │                 @godspace/material, the rungs (deliver / craft /
│   │                 tool / materials / build / maintain) composed from
│   │                 the core task scheduler's behaviour factories, the
│   │                 section/wear/upgrade model (structureModel.ts), the
│   │                 sheltered sleep bonus and the vessel launch
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

The richer map seeds every tile from its deposits AND its biome's living
stocks (`plugins/inventory/inventoryPlugin.ts`): meadows berry ×3, forests
berry ×2 AND mushroom ×2 (plus the 35%-draw vine), beaches coconut ×2 and
the 50%-draw shell, highlands the vein noise's iron lodes and the 30%-draw
flint, and EVERY water column stocks a fish shoal — the sea (the ocean
always, the shallows on a 50% draw) AND the impassable fresh basins — with
seaweed matting the salt beside them. The harvestible foods and materials are ABUNDANT
by design — the starting stocks above are the survey floor and the regrowth
caps run generous (berry 5, mushroom 4, coconut 3, fish 3, seaweed 2, vine
2, bush 3) so a harvested cell refills toward a stock that reads abundant.
Regrowth is ELIGIBILITY-GATED: the survey records every cell it seeded each
renewable on, and the rhythm sweep refills exactly those cells — a fully
harvested source (its stock key deleted by the take) still regrows, and an
item never spreads to a cell it was not seeded on (no mushrooms on the
beach, no fish on land). The finite resources (shell, flint, stone, iron)
never regrow. The hunger ladder gathers berries, mushrooms, fish, coconuts
and seaweed in priority order — and THE FISHING SHORE (R5) joins it: a
hungry body on dry ground with fish in the CARDINAL-adjacent water fishes
it (the inventory's `fish` primitive — dry ground, cardinal reach, live
shoal and bag room all re-validated at completion), and at a distance the
fishing shores join the hunger trek's targets, so a beachgoer walks to the
water's edge instead of milling at it. The bodies never enter the water:
the shore is the fishery.

The wetland cutoff drowns the fresh basins (R4): lake and pond tiles are
IMPASSABLE water columns — ground a step under the sea line, every deposit
cleared — so the land set the spawn, build and trek scans walk curves
around them, and only the salt carries vessels.

The canvas draws the woods: a treed tile carries the 'tree' DECORATION
(scenario/island.ts decorationOf → @godspace/canvas frames), and the
unicode tab paints the 🌳 emoji on every empty treed tile (entities always
win the tile) while the SVG tab draws the vector tree — trunk + canopy.
DENSE WOODS: a forested tile seeds its interior at its NEIGHBORHOOD
coverage — a wood ringed by forests fills the ground completely (100%),
edge woods thin out, woods beside rock thin out further and take its
boulders in (see the Forest Ecology below).

## The ground supply — infinite resources by voxel name

Every DRY column supplies whatever it is actually built from, forever: a
voxel kind whose name carries a resource token stands for that resource at
the tile, at a symbolic count of 1 mirrored onto every fine cell — stone
voxels → stone ×∞, dirt voxels → dirt ×∞, grass voxels → grass ×∞, sand
voxels → sand ×∞ (`engine/types.ts UNLIMITED_TILE_RESOURCES`). The match is
by voxel NAME, not by biome, and it reads the ACTUAL column — the dirt
under a meadow and the stone bedrock under everything supply too. Taking
the ground is gated only by the bag's capacity and the 'mine' ability
(stone/iron, plugins/entity) — the pile itself never depletes, and the
oceans stay bare (submerged columns have no habitat and no access). The
grass cover carries its OWN resource identity now (it used to read only as
the dirt under it); the `dirt` VOXEL exists (formerly named 'soil') so the
ground layer under every surface supplies dirt by its own name. Iron stays
a finite vein landmark.

## Forest Ecology — the living woods (plugins/forest)

The woods are a population, not a pile. The terrain plugin seeds every
forested tile with a PERSISTENT FINE-SCALE STAND sized by the
**neighborhood model** (plugins/terrain/islandTerrain.ts): a tile's
generated resources are affected by ALL EIGHT of its neighbors — the
cardinal directions (left/right/up/down) weighing DOUBLE the diagonals —
classified by the neighbor's actual biome:

- **forest neighbor** — the woods feed the woods: the tile's tree coverage
  gains (`FOREST_NEIGHBOR_CARDINAL` / `FOREST_NEIGHBOR_DIAGONAL`). A wood
  ringed by 8 forests seeds the FULL 100% — 425 trees on the default
  island, every fine cell holding a tree (the old uniform 90% cap is gone,
  `FOREST_COVERAGE` is now the BASE coverage of an isolated wood); a wood
  with 4 forest neighbors lands well below it.
- **meadow neighbor** — the grassland complements the woods' border: the
  MEADOW tile gains its own LOCALIZED TREE INGRESS along the shared edge
  (`MEADOW_INGRESS_*` — 6 trees per cardinal forest edge, 2 per diagonal
  corner, placed on the fine cells nearest that edge). The meadow keeps
  its biome ('meadow' — never a grassland alias); its trees are a real
  persistent stand: the ecology's chop harvests them, the Tile Inspector
  reads them, and a spread conversion plants its sapling INTO the ingress
  stand (the ingress is the spread's beachhead).
- **highland neighbor** — the rock crowds the woods: the tile's coverage
  drops (`ROCK_NEIGHBOR_*`) AND a rock-spillover band is carved along the
  shared edge — the zoomed interior crowns those fine cells with a BOULDER
  voxel (a stone voxel on top of the column — the fine cell reads as rock,
  `tileSurfaceKey`'s boulder crown), and no tree stands on a boulder.
- **beach / water neighbor** — sand and sea feed nothing.

Every seeded tree holds one fine cell at mixed seeded ages, and the zoomed
interior mirrors those exact positions — trees never reshuffle after a
cut. The tile's `tree` deposit count mirrors the standing stand (ingress
meadows included). The neighbor carve rides the sub-grid fingerprint, so a
cached zoomed grid never outlives the parent data it was generated from.

**Wood grows on the tree.** Each tree carries a wood pool that grows with
its age toward the mature cap (8 units): a sapling gives 1 wood, an old
tree gives more. Cutting wood (the lumber behaviour's chop →
inventory.harvest → the forest chop) takes ONE unit per chop; the tree
stands while wood remains and regrows from its post-cut baseline — a
partially harvested mature tree is never dead-ended. A tree chopped to 0
is felled away: its record and the mirrors leave, and recruitment refills
the spot (never a boulder spot — the rock-spillover band is treeless
forever). Living trees are never bagged (`takeFromCell('tree')` refuses).

**Recruitment and spread** (the ecology's own staggered per-tile
schedules, bounded per minute):

- a forest VOXEL recruits one sapling into a free fine cell OFF its
  rock-spillover boulders on its rhythm — EVEN clearcut (the seed bank
  stands in for the felled mothers; the documented assumption). Boulders
  hold no tree: the recruitment probe, its bounded fallback and the
  terrain plugin's `forestPlant` boundary all refuse the carve;
- a forest tile holding a LIVING MATURE tree converts ONE adjacent meadow
  tile (grass substrate) into woods every spread slot: the forest voxel
  stacks on the grass, the biome re-skins, a sapling seeds the new stand —
  or JOINS the meadow's ingress stand when the border already seeded one;
  - trees NEVER spread onto sand, stone or water — they cannot grow there,
    regardless of the soil underlayer.

**Research-backed pacing** (representative fast pioneer, DEFAULT real
time — one year = 525,600 world minutes of 1440-minute days):

| phase | default | source |
|---|---|---|
| maturity (full wood pool) | 8 years | UNL Extension EC3076 (~6 yr tree maturation): https://extensionpubs.unl.edu/publication/ec3076 · MSU Extension (pulpwood rotations < 10 yr): https://extension.msstate.edu/publications/forest-growth-and-yield · FAO (fast tropical rotations 5–21 yr): https://www.fao.org/4/ac121e/ac121e04.htm |
| recruitment (one new sapling per tile) | 2 years | UNL EC3076 (germination ~2 yr): https://extensionpubs.unl.edu/publication/ec3076 · UF/IFAS (seed crops begin 1–5 yr): https://ufdcimages.uflib.ufl.edu/IR/00/00/18/15/00001/FR02400.pdf · USU Extension (seedling establishment 1–3 yr): https://extension.usu.edu/forestry/publications/utah-forest-facts/040-tree-seedling-planting-guide |
| spread (one meadow conversion per tile) | 3 years | UNL EC3076 (natural spread is limited): https://extensionpubs.unl.edu/publication/ec3076 |

Wood growth accumulates in exact integer math with a fractional carry (the
growth accumulator) — every read and fold is deterministic. A day is a
day: the default biology does NOT compress years into days.

**Configuration** (`IslandOptions.forest`, plugins/forest/forestPlugin.ts
`ForestPacingOptions`): `growthRateMultiplier` divides the years (1000 → a
stand matures in ~70 world hours); `maturityYears` / `recruitYears` /
`spreadYears` / `woodCap` reshape the biology; `maturityMinutes` /
`recruitMinutes` / `spreadMinutes` are DIRECT world-minute overrides that
win over the year math (accelerated deterministic tests pin exact ticks
with these). Invalid values (zero, negative, NaN) fall back to the
documented defaults — never a zero denominator, never a NaN pool.

**Fast-forwarding without millions of ticks**: `island.forest
.fastForward(minutes)` runs ONLY the ecology across a span of world
minutes — an event-driven replay that jumps the clock slot to slot and
applies exactly what per-minute stepping would apply (same minutes, same
order, same seeded streams; verified equivalent in the tests). Needs, tasks
and every other plugin keep their own pace. Reading the woods is lazy:
`forest.standOf(tile)` (trees + standing wood), `forest.treeAt(tile, fine)`
(a tree's pool, age, maturity), `forest.poolOf/ageOf/matureOf` — no
per-tree scans of the ~30,000 seeded trees ever run.

**Remounting** (the plugin-swap edge): while the ecology is unmounted, the
inventory's biological boundary SEALS the woods — a `harvest(tree, wood)`
on terrain carrying a persistent stand is refused before any mutation (a
living tree harvests only through its owner). The legacy whole-tree path
serves only stand-less terrain (old fixtures whose trees are plain tile
deposits with no records — cutting those draws the deposit down with
nothing able to resurrect it). No drift is ever created, so the mount-time
mirror reconciliation has nothing to heal; the wood pool cannot be farmed
through remove/cut/remount cycles. The ecology's clock stays monotonic
across a remount: the records carry absolute birth/baseline minutes, so a
reset would age recruited trees backwards.

## Time, distance and scale

- **Time per tick** — ONE world minute (`TICK_MINUTES`, engine/world.ts): the
  ticker steps 1 minute at a time, and a step's minutes always sub-step one
  at a time (the engine core's `step()`), so all pacing is per-minute.
- **Distance per tick** — ONE SCALE-0 TILE move per tick
  (`TRAVEL_MINUTES_PER_TILE`, scenario/island.ts): the simulation runs at
  Scale 0, the LOWEST level of the view ladder — the tile interiors, where
  the entities move around (one subtile cell per completed move task,
  `world.relocateFine` flowing across tile boundaries). Off the target
  tile, the fine step books a TILE-HOP first (`plugins/movement/
  fineMovement.ts tilePathHop` — a 4-neighbour BFS over passable tiles
  returning the first route hop): greedy fine aiming ping-ponged against
  concave coastlines (the peninsula livelock — a hauler frozen at a
  shore corner while the sea blocked the direct line).
- **The view ladder** — counts UP from the lowest level (@godspace/core
  src/scale): scale 0 the tile interior (the simulation ground), scale 1 the
  island — THE DEFAULT VIEW, which shows where the Scale-0 entities stand.
  The ladder is a PURE VIEW ladder: zooming never re-times the clock.
- **The dominant visible type** — at the coarse scale a tile PAINTS as the
  majority visible type of its children (`features/tileDetails.ts`
  dominantVisibleType, counted in child cells, ties to the key that reached
  its winning count first in the row-major scan, recursive down the
  generated ladder): fringed meadows read grass, rock sites and lodes read
  dirt (the 🪨 decoration keeps them findable), the canopy reads tree. A
  pure RENDER-side read — the simulation keeps the tile's own identity.
  The fold is CACHED without changing its answer: the deepest generated
  level histograms its children's keys straight from the parent cell
  (`plugins/terrain` surfaceKeyCounts — the exact scatter, no cell objects)
  and intermediate nodes ride a per-world fingerprint-keyed cache, so a
  configured depth-2 board stays interactive (the naive fold materialized
  ~180k cells per root).

## The day cycle — the shared clock contract (scenario/dayCycle.ts)

- **The day** — 1440 world minutes (`DAY_MINUTES`); elapsed minute 0 is the
  island's birth at 10:00, so `minuteOfDay(elapsed)` anchors there (the
  calendar rolls at midnight exactly as temporal.ts's Gregorian readout does).
- **The 6h sleep** — every body owes a 360-minute daily sleep quota
  (`sleepPlugin`, the 22:00–06:00 preferred window): the window sleeps every
  body whose quota is unmet EVEN AT FULL ENERGY — the six hours are owed by
  the clock, not by fatigue. An interrupted night's shortfall becomes DEBT,
  caught up any time in 90-minute chunks (the day continues between them).
  An exhausted body (energy ≤ 22) naps whatever the clock says.
- **Pre-emption is the honest cost** — the task ledger churns a busy
  body's head task only for a STRICTLY higher-priority module (equal
  priorities never churn a running queue): a thirst rung (50) breaks a
  slumber (30), the night sleep breaks a hand-driven build minute (the
  deliver shell at 24), and the interrupted night pays the debt later —
  the contracts above are subject to survival, not the other way round.
- **Energy** — the idle burn (0.06/min for the stock human) runs ALWAYS,
  asleep or awake; movement charges its own cost per tile crossing (the
  species profile's run/walk economics). A resting minute's hunger/thirst
  spend is the recovery service's EQUAL charge (`needs.recovery` — the
  sleep restore, the shelter bonus and the rest fallback all route through
  it): the actual gain is capped by the energy headroom and by the charged
  resources' room, so nothing converts from a full belly line or an empty
  source.
- **Lighting** — the god-view's night veil reads `daylightAt(elapsed)`, a
  pure function of the world clock: night 18:00–06:00 holds the readable
  floor (`NIGHT_LIGHT_FLOOR` 0.35 — the veil dims hard, every tile stays
  legible), full daylight 07:30–16:30, and 90-minute smoothstep ramps run
  dusk 16:30→18:00 and dawn 06:00→07:30 so the light never jumps. The one
  documented seam: at 06:00 exactly the dawn ramp still sits at the floor
  (continuity with 05:59) while `isNight()` already reads day — the
  half-open window's single boundary minute.

## Plugins

A plugin is any object with an `id` and optional `setup` / `tick` / `dispose`
hooks receiving a `PluginContext` (the world). Worlds are configured with a
plugin list; removing a plugin removes that environment behaviour entirely
(e.g. drop the inventory plugin and nobody can gather, eat or trade).

## Construction — the build projects over the shared stack

The `construction` plugin (`plugins/construction/constructionPlugin.ts`) is
the island's BUILD and CRAFT governance, planned through the shared
@godspace packages rather than re-implemented locally:

- **@godspace/blueprint** — the stock definition registry (shelter, house,
  fort, raft, boat — multi-tile footprints of SCALE-0 fine cells with staged
  material requirements and a work cost) and the site registry the plugin
  wires to the island grid: placement is hook-vetoed (dry land only, no
  grounded body standing in the footprint's fine cells), overlap is
  registry-checked, deliveries stage capped exactly at the requirement and
  the work accrues in one-world-minute stages (`workOn`) once every
  material is staged.
- **@godspace/material** — the crafting registry seeded with the ISLAND's
  recipes (vine 2 → rope, wood 1 → plank ×2, frond 2 → thatch,
  frond 3 → cloth), each craft atomic: a spent/moved stock loses nothing.
- **@godspace/core** — the task scheduler runs the island ledger (the
  ledger is a thin adapter over it), and the craft/build rungs are composed
  FROM the core's stock behaviour factories (`craftTaskBehaviour`,
  `buildTaskBehaviour`) with island gates layered on top.

**The plan** — one stock structure at a time, cooperative and
deterministic (R1): `shelter → raft → house → boat → quarry → furnace →
fort` (`PLAN_ORDER`). The tick places the current project when nothing is
live, ranked by PRIORITY-AWARE placement: land cells scored by centrality
with beach/wood adjacency bonuses, and vessels require a beach tile WITH a
SEA-water neighbour — the launch mooring; a lake beach never hosts a hull.
The quarry and furnace come BEFORE the fort: the furnace fires the bricks
the fort's upgrades need, and the axe/hammer tool chain the early projects
owe (the tool rung, priority 23) keeps the crew equipped.

**The rungs** (the ledger's planning order — needs always win):

| rung | priority | what it does |
|---|---|---|
| flee | 60 | the survival plugin (unchanged) |
| thirst / hunger / roost / sleep / rest | 50…25 | the survival needs (unchanged) |
| deliver | 24 | the bag holds a material the site lacks → haul it to the footprint and stage it |
| craft / tool | 23 | the bag holds a recipe's inputs → the atomic craft (per recipe); the tool rung re-arms the crew's axe/hammer when they wear out |
| fetch-* / materials | 22 | a fetch the site still lacks AND no single bag can already use → take it underfoot, fell a tree for wood, or travel to the nearest stocked cell |
| build | 21 | the site is fully staged → one world-minute work stage per task |
| social | 20 | unchanged — construction outranks it |
| maintain | 15 | the R4 upkeep rungs: stage an open repair/upgrade order's material onto the built structure's footprint, then work its minutes |
| mend | 14 | the R3 tool upkeep: a held tool worn past half sound mends for one wood + 2 minutes — below the structure upkeep (15), above the lumber chop (10): the crew mends its tools in the idle gaps, before break |
| lumber / wander | 10 / 0 | unchanged — construction outranks them |

**Demand direction** — the fetch gate measures the CREW's strongest single
bag against the site's remaining demand, so the crew gathers exactly what
the staging lacks and never wedges a bag full of lumber the site stopped
needing (a crew-total read would deadlock: rope needs two vines in ONE bag,
and 1+1 split across two bags satisfies a total while nothing can be
crafted). Deliveries are PROGRESSIVE: the house's twelve staging units ride
several eight-unit trips.

**Literal totals (R2)** — every island blueprint stages material units
that map 1:1 to its work minutes (`ISLAND_BLUEPRINT_WORK` /
`ISLAND_BLUEPRINT_REQUIRES`): shelter wood 120 + thatch 120 / work 240;
raft wood 320 + rope 160 / 480; house wood 1440 + plank 1440 + thatch
1440 / 4320; boat plank 720 + rope 480 + cloth 240 / 1440; quarry wood
240 + sand 240 / 480; furnace stone 120 + sand 120 / 240; fort stone
1920 + wood 960 / 2880. The totals are the CONTRACT — the tests pin the
exact end state, and the drive settles the pacing.

**Sections and upgrades (R3)** — a BUILT structure stands as material-
defined sections (`plugins/construction/structureModel.ts`
`BLUEPRINT_SECTIONS`): a shelter is a wood frame under a thatch roof, the
fort is four stone walls, the furnace is stone-built. Each tier carries
its own full health — thatch 60, wood 100, stone 200, brick 300 — and the
upgrade ladder walks wood → stone (stone 10 + 100 work) → brick (brick
10 + 100 work). The brick rung only FIRES beside a BUILT furnace: the god
may order the rung at any time, but bricks are kiln-fired (sand 2 +
stone 1 → brick) and without the kiln the crew cannot make one — the raw
inputs stay unspent and the order waits (while never starving a serviceable
repair queued behind it: the maintain rung walks its open orders and
serves the first one that can actually be worked).

**The quarry cut (R3)** — a built quarry opens its highland tile's gravel
bedrock ONCE: 2400 stone land on the anchor tile's deposit record AND its
gatherable stock at the cut (the stock is what `takeFromCell` and
`cellsWithItem` read — the survey seeds it from the deposit only at
survey time, so a deposit-only cut would be unmineable). From then on the
two layers draw down in step, and a resurvey rebuilds the stock from the
deposit — the yield is counted once, never minted twice.

**Wear and repair (R4)** — every section banks wear: ONE health point per
world day — 1440 world minutes (`WEAR_MINUTES_PER_HEALTH`, exact integer
math), the conservative weathering rate: a thatch roof stands ~60 unbuilt
days, a wood frame ~100, stone ~200, brick ~300. The crew opens a repair
order on its own once a section wears to half its full health
(`REPAIR_TRIGGER` 0.5); a repair mends with the section's own material —
one unit per 10 missing health, 5 work-minutes per unit (`repairPrice`).
The economics are audited: restoring even a TOTAL ruin costs strictly less
material and strictly less work than rebuilding the whole structure (a
ruined shelter's full bill is 10 wood + 6 thatch and 80 work-minutes
against the 240-unit, 240-minute replacement; every blueprint prices the
same way). The god can order a repair or an upgrade at any time
(`construction.orderRepair` / `construction.orderUpgrade`), and the
maintain rung (15) works them: stage the material onto the footprint,
then spend the minutes. `construction.sectionsOf(siteId)` reads the
anatomy; worn sections render in the Tile Inspector.

**Tools wear at use (R3)** — the crafted hand tools (the axe, the hammer)
are durables with their own wear ledger, keyed entity + tool beside the
canonical bag counts (`plugins/inventory/toolDurability.ts`):
`construction.tools()` lists the crew's live health/damage views. Wear
charges at ACTUAL USE, never on the clock: the axe loses 5 health per
SUCCESSFUL felling payout (the lumber rung's chop and the construction
run's fell feed the same shared tile job, one payout shape, one wear
rate), the hammer 1 health per committed build minute; idle minutes,
walking and failed beats wear nothing. The break is ATOMIC: the use that
spends the last health point removes the tool from the bag in the same
step (no half-broken state) and the once-per-crew craft gate re-opens —
the replacement becomes craftable naturally. A mend is one wood plus a
2-minute task (the priority-14 mend rung acts on its own once a held tool
wears past half sound, `TOOL_REPAIR_TRIGGER` 0.5) — strictly cheaper than
crafting the replacement in both material and work (the axe's craft is
wood + stone at 5 minutes, the hammer's two wood at 5).

**The gate (doorway) and the walls** — a site's walkable cell is the
resolved FIRST definition cell (every stock blueprint's `cells[0]`).
Deliverers and builders work from anywhere on the footprint while it is
unbuilt; when it COMPLETES, its resolved cells wall off (the fine movement
rules refuse stepping onto them through the world's `structures` hook) and
the gate stays usable — the intentional doorway. Planned footprints do not
block movement: their clearance is checked at placement, and a body can
always step OFF a cell a wall later rises on (only destinations are
validated).

**The shelter's survival use** — a body sleeping or resting on a built
roofed structure's gate (shelter, house) recovers energy faster: +0.5 per
world minute ON TOP of the sleep restore (`SHELTER_REST_PER_MINUTE`, the
construction tick sweep). Both gains ride the recovery service
(`needs.recovery`): the actual energy is capped by the 100 headroom and by
the charged resources' room, and the minute's hunger/thirst cost is the
service's EQUAL charge — the sheltered night is the safe night, and an
honest one: nothing converts from a full belly line or an empty source.

**The vessels** — a built raft or boat is a concrete output:
`construction.launch(siteId)` requires a SEA-water neighbour beside the
shore tile (ocean/shallows — the fresh basins are impassable AND landlocked,
so only the salt carries a vessel), frees the site (no refund — the materials sail with
the hull), records the moored vessel at the FIRST sea neighbour in scan
order west → east → north → south (`construction.vessels()`, ids `v-1`,
…) and logs the launch at the mooring tile. The map resources replenish for the
campaign: vines re-hang on an 80-minute rhythm and palm fronds shed
beneath the standing trees every 60 minutes (offset 45 — the fronds the
thatch/cloth chains weave).

**Inspection and render** — the Tile Inspector lists a Structures section
at every zoom level (`features/tileDetails.ts tileStructures`,
"Shelter · built · sections wood 100/100 + thatch 60/60 · work 240/240"); the
interior (scale-0) views draw every footprint cell as a structure entry
(the unicode tab the blueprint emoji — 🏕️ 🏠 🏰 🛶 ⛵ — through the
`STRUCTURE_TYPE_GLYPHS` palette, the ascii twin the blueprint initial);
the island view draws one summary entry per tile a live site covers.
Structures are NOT living entities: they never enter the needs sweep, the
roster or the task ladder.

**Simulation limitations** (honest edges of the model): the launch is as
far as water travel goes — no sailing is simulated; the launch is a
god-side control, never fired by the autonomous loop; one site is live at
a time (the whole crew serves it — no per-owner claiming); the footprint
occupies fine cells of a single parent tile (the stock blueprints span at
most one tile edge — the cross-parent wrap machinery lives in the shared
site registry and its own tests); leftover materials may linger in bags
between projects (bounded by the demand gate, and consumed by the next
blueprint that needs them).
