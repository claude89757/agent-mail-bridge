// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Domain code must stay IO-free and secrets must never leak into logs;
      // console usage is only legitimate at the CLI boundary.
      'no-console': 'error',
    },
  },
  {
    files: ['src/cli/**/*.ts', 'spikes/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
