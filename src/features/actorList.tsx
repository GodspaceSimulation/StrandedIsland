// Entity roster — one compact row per LIVING ENTITY, castaway or creature.
//
// The left rail lists EVERY living thing in the coordinate space
// (world.coordinates.all() — the single position registry): the castaways
// first (spawned first), then the creatures a plugin coins — the seabirds,
// the sharks, the wild boars. Each row carries the entity's marker, name,
// species tag, current task (every planned entity — the behavior plugin
// plans castaways AND grounded creatures through the ledger, so a bird's
// forage shows next to its name) and the micro stat strip: fullness /
// hydration / energy / health as 30×4px bars. The needs plugin tracks the
// survival stats of ALL entities (plugins/needs/needsPlugin.ts), so a
// bird's bars decay just like a castaway's, at its species' own rates.
//
// The condition DOT: castaways carry their derived condition on the record;
// creatures derive it from their stat values at render time (the same
// ladder, read off the wellbeing values — needsDisplay displayConditionOf).
// Clicking a row selects the entity for
// the inspector (which renders in this same left rail, see dashboard.tsx).

import { styled } from '../styles/styled';
import { CONDITION_COLORS, NEED_COLORS, PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useSelection, selectActor } from './worldBridge';
import { needsDisplay, displayConditionOf } from './needsDisplay';

import type { CoordinateEntry } from '@godspace/core';

const Chip = styled<{ selected: string }>('button', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 4,
    background: ({ selected }) => (selected === 'true' ? PALETTE.accentDim : '#232c37'),
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '5px 8px',
    cursor: 'pointer',
    color: PALETTE.text,
    fontFamily: 'inherit',
});

const NameRow = styled('span', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
});

const Dot = styled<{ color: string }>('span', {
    background: 'custom',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
});

/** The species tag — WHICH the entity is ('human', 'bird', 'shark', …). */
const TypeTag = styled('span', {
    fontSize: 11,
    color: PALETTE.textDim,
    textTransform: 'capitalize',
});

/** The entity's current task label — a small dim tag next to the name. */
const TaskTag = styled('span', {
    fontSize: 11,
    color: PALETTE.textDim,
    whiteSpace: 'nowrap',
});

/** The micro stat strip — three bars, smallest space that still reads. */
const StatStrip = styled('span', {
    display: 'flex',
    gap: 3,
});

const MicroTrack = styled('span', {
    background: '#2a333f',
    width: '30px',
    height: '4px',
    borderRadius: 2,
    overflow: 'hidden',
    display: 'inline-block',
});

const MicroFill = styled<{ width: string; background: string }>('span', {
    height: '100%',
    width: 'custom',
    background: 'custom',
    display: 'block',
});

const Empty = styled('span', {
    fontSize: 12,
    color: PALETTE.textDim,
});

/** One micro bar — fullness/hydration/energy/health read left to right. 100 = good. */
const MicroBar = ({ value, color, title }: { value: number; color: string; title: string }) => (
    <MicroTrack title={title}>
        <MicroFill width={`${Math.round(Math.max(0, Math.min(100, value)))}%`} background={color} />
    </MicroTrack>
);

export const ActorList = () => {
    const island = useWorld();
    const revision = useRevision();
    const selected = useSelection();
    if (!island) {
        return null;
    }
    void revision;

    const { world, needs, tasks } = island;
    // EVERY living entity in first-placement order — the cast, then the
    // creatures (birds, sharks, boars — whatever the plugins hold aloft)
    const entities: CoordinateEntry[] = world.coordinates.all();

    return (
        <Panel>
            <PanelTitle>Entities</PanelTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {entities.length === 0 ? (
                    <Empty>No one survives.</Empty>
                ) : (
                    entities.map((entity) => {
                        const state = needsDisplay(needs.of(entity.id));
                        // Castaways carry their derived condition on the
                        // record; creatures derive it from the same stat
                        // ladder at render time
                        const condition =
                            world.actors.get(entity.id)?.condition ?? displayConditionOf(state);
                        // The entity's in-progress task (plugins/tasks/
                        // taskLedger.ts) — shown for EVERY planned entity
                        // (castaways and creatures alike) when the tasks
                        // plugin is mounted
                        const task =
                            world.plugins.has('tasks') ? tasks.taskOf(entity.id) : undefined;
                        return (
                            <Chip
                                key={entity.id}
                                selected={selected === entity.id ? 'true' : 'false'}
                                data-testid={`actor-chip-${entity.name}`}
                                onClick={() => selectActor(selected === entity.id ? null : entity.id)}
                            >
                                <NameRow>
                                    <Dot color={CONDITION_COLORS[condition]} />
                                    {entity.marker} {entity.name}
                                    {entity.type && <TypeTag>{entity.type}</TypeTag>}
                                    {task && (
                                        <TaskTag data-testid={`actor-task-${entity.id}`}>
                                            · {task.label}
                                        </TaskTag>
                                    )}
                                </NameRow>
                                <StatStrip data-testid={`actor-stats-${entity.name}`}>
                                    <MicroBar
                                        value={state.fullness}
                                        color={NEED_COLORS.fullness}
                                        title={`Fullness ${Math.round(state.fullness)}%`}
                                    />
                                    <MicroBar
                                        value={state.hydration}
                                        color={NEED_COLORS.hydration}
                                        title={`Hydration ${Math.round(state.hydration)}%`}
                                    />
                                    <MicroBar
                                        value={state.energy}
                                        color={NEED_COLORS.energy}
                                        title={`Energy ${Math.round(state.energy)}%`}
                                    />
                                    <MicroBar
                                        value={state.health}
                                        color={NEED_COLORS.health}
                                        title={`Health ${Math.round(state.health)}%`}
                                    />
                                </StatStrip>
                            </Chip>
                        );
                    })
                )}
            </div>
        </Panel>
    );
};
