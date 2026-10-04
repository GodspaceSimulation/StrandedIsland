// Shared styled building blocks for the god-view.

import { styled } from '../styles/styled';
import { PALETTE } from '../styles/theme';

/** Framed panel container used by every feature section. */
export const Panel = styled('section', {
    background: PALETTE.panel,
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 8,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    minWidth: 0,
    minHeight: 0,
});

/** Small uppercase panel heading. */
export const PanelTitle = styled('h2', {
    margin: 0,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: PALETTE.textDim,
    fontWeight: 600,
});

/** Generic button with an active state highlight. */
export const ControlButton = styled<{ active?: boolean }>('button', {
    background: ({ active }) => (active ? PALETTE.accentDim : '#232c37'),
    color: ({ active }) => (active ? '#eafff5' : PALETTE.text),
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
});

/** Native select styled to the palette (tick size / speed pickers). */
export const ControlSelect = styled('select', {
    background: '#232c37',
    color: PALETTE.text,
    border: `1px solid ${PALETTE.panelBorder}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 13,
    fontFamily: 'inherit',
});

/** Horizontal row of controls. */
export const ControlRow = styled('div', {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    flexWrap: 'wrap',
});
