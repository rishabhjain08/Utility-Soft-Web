import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds one self-contained dist/index.html so the app can be hosted anywhere
// or copied next to the Java program and opened directly in Chrome.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  base: './',
  build: { target: 'es2022' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
