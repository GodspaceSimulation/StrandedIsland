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
    },
});
