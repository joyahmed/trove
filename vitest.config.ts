import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

// Unit tests for state classes, hooks-free utils and data files. Rune modules (*.svelte.ts)
// compile through the SvelteKit plugin, so $state/$derived work in tests.
//
// `*.client.test.ts` files run on Svelte's CLIENT runtime instead (see
// vitest.svelte-client-env.ts): the default side compiles for the server, where an `$effect`
// and its teardown never run, so a test about what a teardown does needs the client one.
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.client.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        // Svelte's package exports its client runtime under the `browser` condition only
        resolve: { conditions: ['browser'] },
        test: {
          name: 'client',
          include: ['src/**/*.client.test.ts'],
          environment: './vitest.svelte-client-env.ts',
        },
      },
    ],
  },
});
