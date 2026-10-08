// Lumber barrel — the tree-felling behaviour plugin (lumberPlugin.ts): the
// 'lumber' ledger behaviour at priority 10 (work the tile's SHARED chop
// job → wood) plus the chop completion effect (one work-minute per beat
// into the tasks plugin's tile-work ledger; the finished job is claimed
// atomically and pays one wood off the tree's pool into the bag).

export * from './lumberPlugin';
