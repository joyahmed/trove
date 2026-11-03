import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteConfig from './svelte.config.js';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    // the conventions doc, enforced where a linter can: `.svelte` markup never talks to Tauri directly
    files: ['src/lib/components/**/*.svelte', 'src/routes/**/*.svelte'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              message: 'invoke belongs in $lib/api/*; components call a hook.',
            },
          ],
        },
      ],
    },
  },
  { ignores: ['build/', '.svelte-kit/', 'src-tauri/', 'node_modules/', '.claude/'] },
);
