// The entity environment plugin — the species registry (see entityPlugin.ts).
export { entityPlugin, deriveMovement } from './entityPlugin';
export type {
    EntityPlugin,
    EntityPluginOptions,
    EntityProfiles,
    EntityProfile,
    EntityAttributes,
    EntityStats,
    EntityMove,
    MoveKind,
    Ability,
} from './entityPlugin';
export { MOVE_KINDS, TYPICAL_SPEED, TYPICAL_STAMINA } from './entityPlugin';
