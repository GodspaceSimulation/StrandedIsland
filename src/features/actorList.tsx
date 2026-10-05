// Castaway roster — one compact row per actor.
//
// Each row shows the actor's name plus a micro stat strip (hunger / thirst /
// energy as 30×4px bars) — the whole overview fits in ~40px of height.
// Clicking a row selects the actor for the inspector (which renders in this
// same left rail, see dashboard.tsx).

import { styled } from '../styles/styled';
import { CONDITION_COLORS, NEED_COLORS, PALETTE } from '../styles/theme';
import { Panel, PanelTitle } from '../components/panel';
import { useWorld, useRevision, useSelection, selectActor } from './worldBridge';
import { needsDisplay } from './needsDisplay';

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

/** The actor's current task label — a small dim tag next to the name. */
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

/** One micro bar — fullness/hydration/energy read left to right. 100 = good. */
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
    const actors = Array.from(world.actors.values());

    return (
        <Panel>
            <PanelTitle>Castaways</PanelTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {actors.length === 0 ? (
                    <Empty>No one survives.</Empty>
                ) : (
                    actors.map((actor) => {
                        const state = needsDisplay(needs.of(actor.id));
                        // The actor's in-progress task (plugins/tasks/taskLedger.ts)
                        // — shown only when the tasks plugin is mounted
                        const task = world.plugins.has('tasks') ? tasks.taskOf(actor.id) : undefined;
                        return (
                            <Chip
                                key={actor.id}
                                selected={selected === actor.id ? 'true' : 'false'}
                                data-testid={`actor-chip-${actor.name}`}
                                onClick={() => selectActor(selected === actor.id ? null : actor.id)}
                            >
                                <NameRow>
                                    <Dot color={CONDITION_COLORS[actor.condition]} />
                                    {actor.marker} {actor.name}
                                    {task && (
                                        <TaskTag data-testid={`actor-task-${actor.id}`}>
                                            · {task.label}
                                        </TaskTag>
                                    )}
                                </NameRow>
                                <StatStrip data-testid={`actor-stats-${actor.name}`}>
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
                                </StatStrip>
                            </Chip>
                        );
                    })
                )}
            </div>
        </Panel>
    );
};
