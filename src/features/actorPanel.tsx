// Entity inspector — the needs, attributes, abilities, inventory and bonds
// of whichever LIVING ENTITY the god selects — castaway or creature.
//
// Rendered in the LEFT rail (where the roster lives — see dashboard.tsx) as
// the ENTITY INSPECTOR: the panel that reads one entity of the world (the
// roster lists them all; tiles have their own Tile Inspector in the right
// rail). Every entity carries the same core reads:
//
//   stats       — fullness / hydration / energy / health (needsDisplay
//                 inversion; health is the reservoir between the entity
//                 and death — at 0 the entity dies)
//   attributes  — Strength / Stamina / Speed / Dexterity, straight from the
//                 entity profile (plugins/entity/entityPlugin.ts)
//   abilities   — the capability set the profile grants (walk, run, swim,
//                 fly, mine, craft…) — what this species may ever do
//   inventory   — the bag's stacks plus its SIZE (species-defined capacity)
//   bonds       — fellow castaways only (creatures keep no relationship
//                 graph; the relationship plugin tracks castaway pairs)
//
// The per-entity history is gone: the log is the story now
// (features/storyFeed.tsx — the Story tab top right).

import { styled } from '../styles/styled';
import { NEED_COLORS, PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useSelection } from './worldBridge';
import { needsDisplay, displayConditionOf, type NeedsDisplay } from './needsDisplay';
import { inventoryEntries } from '../plugins/inventory/inventory';
import { itemLabel, inventoryWeight } from '../plugins/inventory/items';
import { SEX_BADGES } from '../engine/types';
import type { EntityProfile } from '../plugins/entity/entityPlugin';

const Row = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
});

const NeedName = styled('span', {
    width: '52px',
    fontSize: 12,
    color: PALETTE.textDim,
});

const Track = styled('div', {
    height: '8px',
    flex: 1,
    background: '#2a333f',
    borderRadius: 4,
    overflow: 'hidden',
});

const Fill = styled<{ width: string; background: string }>('div', {
    height: '100%',
    width: 'custom',
    background: 'custom',
    borderRadius: 4,
});

const NeedValue = styled('span', {
    width: '34px',
    textAlign: 'right',
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
});

const List = styled('ul', {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 13,
});

/** The attribute rows — label + tabular value, one line per attribute. */
const AttrRow = styled('span', {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    fontSize: 13,
});

/** Ability badges — one pill per ability, capitalize for readability. */
const AbilityBadge = styled('span', {
    display: 'inline-block',
    padding: '1px 7px',
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 8,
    fontSize: 11,
    color: PALETTE.textDim,
    textTransform: 'capitalize',
    marginRight: 4,
});

const Carry = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

const EmptyNote = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

/** Wellbeing rows — labels match the display metrics (needsDisplay). */
const NEED_ROWS: Array<{ key: keyof NeedsDisplay; label: string }> = [
    { key: 'fullness', label: 'Fullness' },
    { key: 'hydration', label: 'Hydration' },
    { key: 'energy', label: 'Energy' },
    { key: 'health', label: 'Health' },
];

/** The attribute rows in display order (the entity profile's block). */
const ATTRIBUTE_ROWS: Array<{ key: keyof EntityProfile['attributes']; label: string }> = [
    { key: 'strength', label: 'Strength' },
    { key: 'stamina', label: 'Stamina' },
    { key: 'speed', label: 'Speed' },
    { key: 'dexterity', label: 'Dexterity' },
];

const EntityCard = ({ entityId }: { entityId: string }) => {
    const island = useWorld();
    if (!island) {
        return null;
    }
    const { inventory, needs, relationship, world, entity } = island;
    // The entity reads two ways: castaways from the registry (condition on
    // the record, sex on the profile), creatures from the coordinate facet
    const actor = world.actors.get(entityId);
    const entry = world.coordinates.entryOf(entityId);
    const name = actor?.name ?? entry?.name ?? entityId;

    // Display values: full bar = good (hunger/thirst pressure inverted)
    const stats = needs.of(entityId);
    const state = needsDisplay(stats);
    // The condition ladder is the same for every species — castaways carry
    // it on the record, creatures derive it here off the wellbeing values
    const condition = actor?.condition ?? displayConditionOf(state);
    const type = actor?.type ?? entry?.type ?? '';
    const profile = entity.profileOf(type);

    const bag = inventory.of(entityId);
    const stock = inventory.cellStock(entry?.position.x ?? 0, entry?.position.y ?? 0);
    const capacity = inventory.capacityOf(entityId);
    // R5 — the carried LOAD is the bag's total WEIGHT (Σ count × itemWeight),
    // compared against the carrier's weight capacity (a person 200).
    const carried = inventoryWeight(bag);

    // One bond row per fellow castaway — never the entity themselves, and
    // creatures keep no bond graph at all (the relationship plugin tracks
    // castaway pairs). Walking the roster (instead of relationship.pairs())
    // keeps the list at exactly castSize − 1: pairs that don't involve this
    // actor can no longer be mislabelled as theirs, and unacquainted pairs
    // read as neutral (0).
    const relations = actor
        ? Array.from(world.actors.values())
              .filter((other) => other.id !== actor.id)
              .map((other) => ({
                  id: other.id,
                  name: other.name,
                  value: relationship.relation(actor.id, other.id),
                  level: relationship.level(actor.id, other.id),
              }))
        : [];

    return (
        <>
            <Row>
                <span data-testid="actor-condition">
                    {name} · {condition}
                </span>
            </Row>
            {/* The PROFILE row — the stable personal facts: a human's sex
                badge (♂/♀ — the gendered emoji the canvases draw), a
                creature's species label */}
            <Row>
                <span data-testid="actor-profile">
                    {actor ? `${SEX_BADGES[actor.profile.sex]} ${actor.profile.sex}` : (profile?.label ?? type)}
                </span>
            </Row>
            <div>
                {NEED_ROWS.map((row) => (
                    <Row key={row.key}>
                        <NeedName>{row.label}</NeedName>
                        <Track>
                            <Fill width={`${Math.round(state[row.key])}%`} background={NEED_COLORS[row.key]} />
                        </Track>
                        <NeedValue>{Math.round(state[row.key])}</NeedValue>
                    </Row>
                ))}
            </div>
            {/* The ATTRIBUTES — the profile's Strength/Stamina/Speed/Dexterity
                block: the numbers that determine every consumption and pace
                (entityPlugin's movement derivation reads them) */}
            {profile && (
                <div>
                    <PanelTitle>Attributes</PanelTitle>
                    <List data-testid="actor-attributes">
                        {ATTRIBUTE_ROWS.map((row) => (
                            <li key={row.key}>
                                <AttrRow>
                                    <NeedName>{row.label}</NeedName>
                                    <span>{profile.attributes[row.key]}</span>
                                </AttrRow>
                            </li>
                        ))}
                    </List>
                </div>
            )}
            {/* The ABILITIES — what this species may ever do: the movement
                kinds (walk/run/swim/fly) and the work unlocks (mine, craft…) */}
            {profile && profile.abilities.length > 0 && (
                <div>
                    <PanelTitle>Abilities</PanelTitle>
                    <div data-testid="actor-abilities">
                        {profile.abilities.map((ability) => (
                            <AbilityBadge key={ability}>{ability}</AbilityBadge>
                        ))}
                    </div>
                </div>
            )}
            <div>
                <PanelTitle>Inventory</PanelTitle>
                {/* R5 — the bag's carried WEIGHT over the species' weight
                    capacity (a person 200) — the load the inventory plugin
                    clamps every take/transfer/harvest to */}
                <Carry data-testid="actor-carry">
                    Carries {carried} / {Number.isFinite(capacity) ? capacity : '∞'} wt
                </Carry>
                <List data-testid="actor-inventory">
                    {inventoryEntries(bag).length === 0 ? (
                        <li>
                            <EmptyNote>Empty hands.</EmptyNote>
                        </li>
                    ) : (
                        inventoryEntries(bag).map((entry_) => (
                            <li key={entry_.item}>{itemLabel(entry_.item, entry_.count)}</li>
                        ))
                    )}
                </List>
            </div>
            <div>
                <PanelTitle>Underfoot</PanelTitle>
                <List>
                    {inventoryEntries(stock).length === 0 ? (
                        <li>
                            <EmptyNote>Nothing left here.</EmptyNote>
                        </li>
                    ) : (
                        inventoryEntries(stock).map((entry_) => (
                            <li key={entry_.item}>{itemLabel(entry_.item, entry_.count)} (ground)</li>
                        ))
                    )}
                </List>
            </div>
            {actor && (
                <div>
                    <PanelTitle>Bonds</PanelTitle>
                    <List data-testid="actor-relations">
                        {relations.length === 0 ? (
                            <li>
                                <EmptyNote>No bonds yet.</EmptyNote>
                            </li>
                        ) : (
                            relations.map((relation) => (
                                <li key={relation.id}>
                                    {relation.name} — {relation.level} (
                                    {Math.round(relation.value)})
                                </li>
                            ))
                        )}
                    </List>
                </div>
            )}
        </>
    );
};

export const ActorPanel = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    if (!island) {
        return null;
    }
    void revision;

    // The selection is an ENTITY id — castaway or creature. It exists when
    // the registry or the coordinate space knows it (a stale selection on a
    // despawned entity reads as nothing)
    const entityId = selected;
    const exists =
        entityId !== null &&
        (island.world.actors.has(entityId) || island.world.coordinates.entryOf(entityId) !== undefined);

    return (
        <Panel>
            <PanelTitle>Entity Inspector</PanelTitle>
            {exists && entityId ? (
                <EntityCard entityId={entityId} />
            ) : (
                <EmptyNote data-testid="actor-panel-empty">Select an entity to inspect.</EmptyNote>
            )}
        </Panel>
    );
};
