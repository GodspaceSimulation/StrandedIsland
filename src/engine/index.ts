// The island engine — the distribution's half of the @godspace/core engine
// contract.
//
// The GENERIC engine core (world container, ticker, event bus, plugin
// registry, seeded randomness, fine-movement ladder) lives in
// @godspace/core — import it from there. What remains here is the
// distribution's own vocabulary:
//   types.ts — the island's domain types (Actor, TerrainCell, Canvas, …):
//              the entities and terrain that get INSERTED into the engine
//   world.ts — the adapter that dresses the generic engine world with the
//              island surface (canvas holder, cell lookups, the actors
//              registry alias) and the island narrative

export * from './types';
export * from './world';
