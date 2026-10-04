// Vite config for the StrandedIsland distribution.
// `base` is "./" so all asset paths are relative — the build works on any
// GitHub Pages subpath without hardcoding the repo name.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // Relative base path so the build works on GitHub Pages subpaths
    base: './',
    server: {
        port: 8000,
    },
    build: {
        outDir: 'dist',
    },
});
