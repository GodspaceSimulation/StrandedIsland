// Vitest config scoped to the StrandedIsland distribution.
// jsdom environment for React component tests; engine and plugin tests are
// pure TypeScript so they run in any environment.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true,
        // The world-simulation tests (full island boots, driveUntil march
        // loops, 400+ minute reference runs) regularly exceed vitest's
        // default 5s testTimeout when the monorepo test run goes wide
        // (yarn runs every workspace in parallel). Explicit headroom keeps
        // a margin without masking hangs.
        testTimeout: 60_000,
        hookTimeout: 60_000
    },
});
