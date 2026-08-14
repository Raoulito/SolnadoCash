// app/eslint.config.js
//
// There was no linter here, despite `eslint-disable-next-line` comments in the source
// implying one ran. That gap let a real bug ship: `executeWithdraw` read `breakdown` but
// omitted it from its useCallback dependencies, so the memoised closure kept
// `breakdown === null` and the H-4 fee-ceiling comparison silently compared the quote
// against itself. react-hooks/exhaustive-deps catches exactly that, which is why it is an
// error here rather than a warning.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A missing dependency is a stale closure, and a stale closure in this app means a
      // security check reading last render's values. Not a style question.
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
