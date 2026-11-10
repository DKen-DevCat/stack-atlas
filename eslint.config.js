// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'out/**',
      'prototype/**',
      'examples/fixture-repo/**',
      'examples/fixture-poly/**',
      'examples/fixture-gaps/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['packages/viewer/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // 計測のスクリプトは Node で動き、page.evaluate に渡す関数はブラウザで動く
    files: ['packages/viewer/scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
