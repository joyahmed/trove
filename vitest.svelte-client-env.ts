// A vitest environment that compiles rune modules for the browser, not the server.
//
// The default `node` environment transforms through Vite's SSR side, where Svelte's server
// runtime never runs an `$effect` — so a test of what an effect or its teardown does passes
// without testing anything. A test file opts in with its first line:
//   // @vitest-environment ./vitest.svelte-client-env.ts
// It gets Svelte's client runtime (effects, teardowns, flushSync) and still no DOM.
import type { Environment } from 'vitest/environments';

export default {
  name: 'svelte-client',
  viteEnvironment: 'client',
  setup: () => ({ teardown: () => {} }),
} satisfies Environment;
