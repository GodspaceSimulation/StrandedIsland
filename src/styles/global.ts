// Global stylesheet for the Stranded Island god-view.
//
// The styled() shim (src/styles/styled.tsx, backed by @presource/react's
// styledComponent) emits styles as Emotion classes and cannot express bare
// element resets or pseudo-selectors. This sheet is injected once at boot
// via main.tsx.
//
// The critical rule: the browser's UA stylesheet gives <body> a default
// `margin: 8px`, which showed as a white frame around the dark dashboard
// (the UA body background is white). Reset it and pin the document surfaces
// to the theme palette.

import { PALETTE } from './theme';

const sheet = `
/* ---- Document reset ---------------------------------------------------- */

/* UA stylesheets default body margin to 8px — that margin was the white
   frame around the dashboard. Zero it and paint both document surfaces
   with the app background so no white can peek through at any scroll
   position or overscroll rubber-band. */
html, body {
    margin: 0;
    padding: 0;
    background: ${PALETTE.background};
}

/* Let the body own the full viewport height and avoid the inline-gap
   baseline the UA gives inline-level roots. */
body {
    min-height: 100vh;
}

/* Consistent box sizing — the grid/cell layout assumes borders sit inside
   the declared cell size. */
*, *::before, *::after {
    box-sizing: border-box;
}

/* ---- Color scheme ------------------------------------------------------ */

/* Native UI surfaces the browser paints for us — scrollbars and native
   form controls (the world-size <select> pickers) are drawn per
   the document's color scheme. Without this dark hint they default to the
   LIGHT scheme (white tracks, grey-on-white popups), which shatters the
   dark dashboard. */
:root { color-scheme: dark; }

/* ---- Scrollbars -------------------------------------------------------- */

/* Flat thin dark-native scrollbars (world log / actor history overflow). */
.si-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.si-scroll::-webkit-scrollbar-track { background: transparent; }
.si-scroll::-webkit-scrollbar-thumb {
    background: ${PALETTE.panelBorder};
    border: 2px solid transparent;
    border-radius: 5px;
    background-clip: padding-box;
}
.si-scroll::-webkit-scrollbar-thumb:hover { background: ${PALETTE.textDim}; background-clip: padding-box; }
`;

// Inject the stylesheet into the document head exactly once. Idempotent —
// re-invocation is a no-op, which keeps fast-refresh/HMR safe.
let injected = false;
export function injectGlobalStyles(): void {
    if (injected || typeof document === 'undefined') {
        return;
    }
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-si-styles', '');
    styleEl.textContent = sheet;
    document.head.appendChild(styleEl);
    injected = true;
}
