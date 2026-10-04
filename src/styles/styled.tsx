// Styled-component shim for the god-view.
//
// Thin wrapper over @presource/react's `styledComponent` factory that only
// widens the prop surface: standard HTML attributes PLUS an index signature
// so `data-testid` and `aria-*` extras pass typecheck (styledComponent's
// BuilderType does not admit data-* props, which the dashboard's tests rely
// on — same reason distribution/story-generator ships an identical shim).
//
// Style input values may be:
//   - static CSS values (string / number / breakpoint object)
//   - the 'custom' sentinel — resolved from the prop of the same name
//   - a function `(props: P) => value` — typed with the component's props
//
// Usage:
//   const Cell = styled<{ background: string }>('div', { background: 'custom' });
//   <Cell background="#123" data-testid="cell" />

import React from 'react';
import { styledComponent } from '@presource/react';

/** Permissive props: HTML attributes + arbitrary data-* and aria-* extras. */
type PermissiveProps = React.HTMLAttributes<HTMLElement> & {
    [key: string]: unknown;
};

/** Style input: static values, 'custom' sentinels, or typed compute functions. */
type StyleInput<P extends object> = {
    [key: string]: string | number | object | undefined | ((props: P) => unknown);
};

export function styled<P extends object = {}>(
    tag: keyof JSX.IntrinsicElements,
    input: StyleInput<P>,
): React.FC<PermissiveProps & Partial<P>> {
    return styledComponent(tag, input as never) as unknown as React.FC<PermissiveProps & Partial<P>>;
}
